'use strict'

const StaggEKGProClient = require('./lib/stagg-ekg-pro-client')
const { startTempPolling } = require('./lib/temperature-polling')

module.exports = (api) => {
    api.registerPlatform('homebridge-kettle-pro', 'StaggKettle', StaggKettlePlatform);
}

class StaggKettlePlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = new Map();

        api.on('didFinishLaunching', () => this._discoverDevices());
    }

    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    _discoverDevices() {
        const kettles = this.config.kettles || [];
        if (kettles.length === 0) {
            this.log.warn('No kettles configured — add at least one entry under "kettles" in the platform config.');
        }
        const seen = new Set();

        for (const config of kettles) {
            const uuid = this.api.hap.uuid.generate(config.name);
            seen.add(uuid);

            let accessory = this.accessories.get(uuid);
            if (accessory) {
                accessory.context.config = config;
                this.api.updatePlatformAccessories([accessory]);
            } else {
                accessory = new this.api.platformAccessory(config.name, uuid);
                accessory.context.config = config;
                this.api.registerPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.set(uuid, accessory);
            }
            this._setupAccessory(accessory);
        }

        for (const [uuid, accessory] of this.accessories) {
            if (!seen.has(uuid)) {
                this.api.unregisterPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.delete(uuid);
            }
        }
    }

    _setupAccessory(accessory) {
        const config = accessory.context.config;
        const mode = String(config.connection || config.mode || '').toLowerCase();
        const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
        if (mode === 'wifi') {
            new StaggEKGProWifiHandler(
                this.log,
                config,
                accessory,
                Service,
                Characteristic,
                HapStatusError,
                HAPStatus,
            );
        } else {
            new StaggEKGPlusHandler(this.log, config, accessory, Service, Characteristic);
        }
    }
}

class StaggEKGProWifiHandler {
    constructor(log, config, accessory, Service, Characteristic, HapStatusError, HAPStatus) {
        const client = new StaggEKGProClient(config.url);
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;
        const name = config.name || 'Kettle';
        const endpoint = client.cliUrl.replace(/\/\/[^/@]*@/, '//');
        let temperaturePolling;
        let unavailable = false;

        const communicate = async (operation) => {
            try {
                return await operation();
            } catch (err) {
                temperaturePolling?.markTemperatureUnavailable();
                if (!unavailable) {
                    unavailable = true;
                    const cause = err.cause;
                    const details = [err.message, cause?.code, cause?.message]
                        .filter(Boolean).join(': ');
                    log.warn(`${name} unavailable (${endpoint}): ${details}`);
                }
                throw err;
            }
        };
        const command = (cmd) => communicate(() => client.commandAsync(cmd));
        const readState = () => communicate(async () => {
            const body = await client.commandAsync('state');
            const isHeating = client.parseState(body);
            const targetC = client.parseTargetTemp(body);
            if (isHeating === null || targetC === null) {
                throw new Error('Invalid kettle state response: missing heating state or target temperature');
            }
            if (unavailable) {
                unavailable = false;
                log.info(`Connection to ${name} restored (${endpoint}).`);
            }
            return { isHeating, targetC, tempC: client.parseTemp(body) };
        });
        const homeKit = (operation) => async (...args) => {
            try {
                return await operation(...args);
            } catch (err) {
                if (err instanceof HapStatusError) throw err;
                throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        };

        if (config.syncTime === true) {
            const syncClock = () => communicate(() => client.syncClock())
                .then(() => log.info(`Synced ${config.name || 'kettle'} clock to local time.`))
                // communicate already reports the outage once for this kettle.
                .catch(() => {});

            syncClock();
            this.clockSyncInterval = setInterval(syncClock, 24 * 60 * 60 * 1000);
            this.clockSyncInterval.unref?.();
        }

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG Pro')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(homeKit(async () => (await readState()).isHeating))
            .onSet(homeKit(async (value) => {
                await command(`setstate ${client.stateForHomeKit(value)}`);
            }));

        service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(homeKit(async () => (await readState()).isHeating));

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(homeKit(async () => (await readState()).targetC))
            .onSet(homeKit(async (value) => {
                const targetF = Math.round(client.cToF(value));
                await Promise.all([
                    command(`setsetting settempr ${targetF}`),
                    command(`setstate S_Heat`),
                ]);
            }));

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: 100 })
            .onGet(homeKit(async () => {
                const { tempC } = await readState();
                if (tempC === null) {
                    temperaturePolling?.markTemperatureUnavailable();
                    log.info('No temp data, is kettle off its base?');
                    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                }
                return tempC;
            }));

        // Periodic polling with configurable intervals for heating vs idle
        temperaturePolling = startTempPolling(log, config, async (idleTemperatureDue) => {
            const { isHeating, tempC } = await readState();
            let temperatureUpdated = false;
            if (isHeating === 1 || idleTemperatureDue) {
                if (tempC !== null) {
                    service.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
                    temperatureUpdated = true;
                }
            }
            return {
                isHeating,
                temperatureUpdated,
                temperatureAvailable: tempC !== null,
            };
        });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}


class StaggEKGPlusHandler {
    constructor(log, config, accessory, Service, Characteristic) {
        const url = config.url;
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;
        const _fetch = (path, opts = {}) =>
            fetch(url + path, { signal: AbortSignal.timeout(5000), ...opts });

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG+')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await _fetch('/state').then(r => r.text());
                return parseFloat(body);
            })
            .onSet(async (value) => {
                await _fetch('/state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/target_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse target temp: ${body}`);
                return tempC;
            })
            .onSet(async (value) => {
                await _fetch('/target_temp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/current_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse current temp: ${body}`);
                return tempC;
            });

        // Periodic polling with configurable intervals for heating vs idle
        startTempPolling(log, config, async (idleTemperatureDue) => {
            const stateBody = await _fetch('/state').then(r => r.text());
            const isHeating = parseFloat(stateBody);
            let temperatureUpdated = false;
            if (isHeating === 1 || idleTemperatureDue) {
                const currentBody = await _fetch('/current_temp').then(r => r.text());
                const tempC = (parseFloat(currentBody) - 32) / 1.8;
                if (!isNaN(tempC)) {
                    service.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
                    temperatureUpdated = true;
                }
            }
            return { isHeating, temperatureUpdated };
        });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}
