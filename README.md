# homebridge-kettle-pro

Homebridge plugin for Fellow Stagg kettles. Supports:
- **Stagg EKG Pro** over Wi-Fi (HTTP CLI API) — primary focus of this fork
- **Stagg EKG+ / EKG Pro** over BLE bridge HTTP API (legacy)

Fork of [calvinmclean/homebridge-kettle](https://github.com/calvinmclean/homebridge-kettle).

## Install

```
npm install -g homebridge-kettle-pro
```

## Config

```json
"platforms": [
    {
        "platform": "StaggKettle",
        "name": "Kettles",
        "kettles": [
            {
                "name": "Kettle",
                "connection": "wifi",
                "url": "http://192.168.1.32",
                "minTemp": 40,
                "maxTemp": 100,
                "pollIntervalHeating": 10000,
                "pollIntervalIdle": 1800000,
                "syncTime": true
            }
        ]
    }
]
```

Each entry in `kettles` becomes one accessory in HomeKit.

| Field | Required | Description |
|---|---|---|
| `name` | yes | Name shown in HomeKit |
| `connection` | yes | `"wifi"` for EKG Pro Wi-Fi, `"ble"` for BLE bridge |
| `url` | yes | Base URL of the kettle (Wi-Fi) or bridge (BLE). No trailing slash. |
| `minTemp` | no | Minimum target temp in °C (default: 40) |
| `maxTemp` | no | Maximum target temp in °C (default: 100) |
| `pollIntervalHeating` | no | Temperature polling interval while heating, in milliseconds (default: 10000 / 10 seconds) |
| `pollIntervalIdle` | no | Temperature polling interval while idle, in milliseconds (default: 1800000 / 30 minutes) |
| `syncTime` | no | For Wi-Fi kettles, set the kettle clock to the host system's local time when Homebridge starts and once per day (default: `false`) |

Temperature polling uses `pollIntervalHeating` while the kettle is heating and
`pollIntervalIdle` otherwise. These settings are configured separately for each
kettle.

## Connection types

### Wi-Fi CLI (`connection: "wifi"`)
Talks directly to the EKG Pro's built-in HTTP CLI (`/cli?cmd=...`). Requires firmware that supports `setstate` and `setsetting settempr`.

Set `syncTime` to `true` to synchronize the kettle clock with the local time of the system running Homebridge during module initialization and once every 24 hours. The plugin uses the kettle's `setclock` CLI command and does not alter BLE bridge clocks.

### BLE bridge (`connection: "ble"`)
Talks to the legacy [stagg-ekg-plus](https://github.com/calvinmclean/stagg-ekg-plus) Python bridge via `/state`, `/current_temp`, `/target_temp`.

## Homebridge UI

A config schema is included — use the graphical form in Homebridge Config UI X to configure the plugin.
