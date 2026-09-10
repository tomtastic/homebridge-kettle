'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const http = require('node:http')
const StaggEKGProClient = require('../lib/stagg-ekg-pro-client')
const registerPlugin = require('../index')

const state = 'mode=S_Off\ntempr=28 C\ntemprT=93 C'
const readNames = [
  'CurrentHeatingCoolingState', 'TargetHeatingCoolingState',
  'CurrentTemperature', 'TargetTemperature',
]
const flush = () => new Promise(resolve => setImmediate(resolve))
const networkError = code => new TypeError('fetch failed', {
  cause: Object.assign(new Error(`connect ${code} 192.168.8.196:80`), { code }),
})

for (const code of ['EHOSTUNREACH', 'ECONNREFUSED']) {
  test(`client shares ${code} failures and makes a fresh request after recovery`, async t => {
    const client = new StaggEKGProClient('http://kettle.local')
    const error = networkError(code)
    let fail
    const fetch = t.mock.method(global, 'fetch', () => new Promise((resolve, reject) => { fail = reject }))
    const first = client.commandAsync('state')
    const second = client.commandAsync('state')
    assert.equal(first, second)
    assert.equal(fetch.mock.callCount(), 1)
    fail(error)
    const failures = await Promise.allSettled([first, second])
    assert.ok(failures.every(result => result.status === 'rejected' && result.reason === error))

    fetch.mock.mockImplementation(async () => new Response(state))
    assert.equal(await client.commandAsync('state'), state)
    assert.equal(fetch.mock.callCount(), 2)
  })
}

test('client rejects unsuccessful HTTP responses and releases the body', async t => {
  const response = new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
  t.mock.method(global, 'fetch', async () => response)
  const client = new StaggEKGProClient('http://kettle.local')
  await assert.rejects(client.commandAsync('state'), /HTTP 503 Service Unavailable/)
  assert.equal(response.bodyUsed, true)
})

test('client propagates response-body read failures', async t => {
  const error = networkError('ECONNRESET')
  t.mock.method(global, 'fetch', async () => ({ ok: true, text: async () => { throw error } }))
  const client = new StaggEKGProClient('http://kettle.local')
  await assert.rejects(client.commandAsync('state'), err => err === error)
})

test('client uses a 2500 ms deadline and preserves its timeout reason', async t => {
  const controller = new AbortController()
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal)
  const fetch = t.mock.method(global, 'fetch', async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }))
  const client = new StaggEKGProClient('http://kettle.local')
  const pending = client.commandAsync('state')
  const error = new DOMException('The operation timed out', 'TimeoutError')
  controller.abort(error)
  await assert.rejects(pending, err => err === error)
  assert.deepEqual(timeout.mock.calls[0].arguments, [2500])
  assert.equal(fetch.mock.callCount(), 1)
})

test('native fetch times out even after the HTTP response headers arrive', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('mode=S_Off\n') // Leave the response body unfinished.
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const client = new StaggEKGProClient(`http://127.0.0.1:${server.address().port}`)
    await assert.rejects(client.commandAsync('state'), { name: 'TimeoutError' })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function setupPlatform(t, config = {}) {
  const logs = { warn: [], info: [], debug: [] }
  const log = Object.fromEntries(Object.keys(logs).map(level => [level, (...args) => logs[level].push(args.join(' '))]))
  const scheduled = []
  const intervals = []
  const updates = []
  let fetchImpl = async () => new Response(state)
  const fetch = t.mock.method(global, 'fetch', (...args) => fetchImpl(...args))
  t.mock.method(global, 'setTimeout', (fn, delay) => {
    scheduled.push({ fn, delay })
    return { unref() {} }
  })
  t.mock.method(global, 'setInterval', (fn, delay) => {
    intervals.push({ fn, delay })
    return { unref() {} }
  })

  class HapStatusError extends Error {
    constructor(hapStatus) { super(String(hapStatus)); this.hapStatus = hapStatus }
  }
  class Service {
    constructor() { this.characteristics = new Map() }
    setCharacteristic() { return this }
    updateCharacteristic(name, value) { updates.push({ name, value }); return this }
    getCharacteristic(name) {
      if (!this.characteristics.has(name)) {
        this.characteristics.set(name, {
          setProps() { return this },
          onGet(fn) { this.get = fn; return this },
          onSet(fn) { this.set = fn; return this },
        })
      }
      return this.characteristics.get(name)
    }
  }
  const thermostat = new Service()
  class Accessory {
    constructor(name, uuid) { this.UUID = uuid; this.context = {} }
    getService(name) { return name === 'Thermostat' ? thermostat : new Service() }
  }
  let Platform, launch
  const api = {
    registerPlatform(plugin, alias, cls) { Platform = cls },
    on(event, fn) { launch = fn },
    registerPlatformAccessories() {},
    platformAccessory: Accessory,
    hap: {
      Service: { Thermostat: 'Thermostat', AccessoryInformation: 'AccessoryInformation' },
      Characteristic: Object.fromEntries([...readNames, 'TemperatureDisplayUnits', 'Manufacturer', 'Model', 'SerialNumber'].map(name => [name, name])),
      HapStatusError,
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      uuid: { generate: name => name },
    },
  }
  registerPlugin(api)
  new Platform(log, { kettles: [{
    name: 'Kettle', connection: 'wifi', url: 'http://192.168.8.196',
    pollIntervalHeating: 10000, pollIntervalIdle: 900000, ...config,
  }] }, api)
  launch()
  return {
    logs, updates, fetch, intervals, scheduled,
    char: name => thermostat.getCharacteristic(name),
    respond: fn => { fetchImpl = fn },
    isHapError: err => err instanceof HapStatusError && err.hapStatus === -70402,
    async poll() {
      const next = scheduled.shift()
      assert.equal(next.delay, 10000)
      next.fn()
      await flush()
    },
  }
}

test('all Wi-Fi reads and writes report HomeKit errors with one outage warning', async t => {
  const h = setupPlatform(t)
  await flush()
  h.respond(async () => { throw networkError('EHOSTUNREACH') })
  const before = h.fetch.mock.callCount()
  await Promise.all(readNames.map(name => assert.rejects(h.char(name).get(), h.isHapError)))
  assert.equal(h.fetch.mock.callCount() - before, 1)
  await assert.rejects(h.char('TargetHeatingCoolingState').set(1), h.isHapError)
  await assert.rejects(h.char('TargetTemperature').set(93), h.isHapError)
  await h.poll()
  assert.equal(h.logs.warn.length, 1)
  assert.match(h.logs.warn[0], /Kettle unavailable.*192\.168\.8\.196.*EHOSTUNREACH/)

  h.respond(async () => new Response(state))
  const values = await Promise.all(readNames.map(name => h.char(name).get()))
  assert.deepEqual(values, [0, 0, 28, 93])
  assert.equal(h.logs.info.filter(line => line.includes('restored')).length, 1)
})

for (const failure of ['poll', 'HomeKit read', 'write']) {
  test(`${failure} failure makes idle temperature due immediately after reconnection`, async t => {
    const h = setupPlatform(t)
    await flush()
    assert.equal(h.updates.length, 1)
    await h.poll()
    assert.equal(h.updates.length, 1) // Still inside the 15-minute idle interval.
    h.respond(async () => { throw networkError('ECONNREFUSED') })
    if (failure === 'poll') {
      await h.poll()
      await h.poll()
    } else if (failure === 'HomeKit read') {
      await assert.rejects(h.char('CurrentTemperature').get(), h.isHapError)
    } else {
      await assert.rejects(h.char('TargetHeatingCoolingState').set(0), h.isHapError)
    }
    h.respond(async () => new Response(state.replace('28 C', '29 C')))
    await h.poll()
    assert.equal(h.updates.length, 2)
    assert.deepEqual(h.updates[1], { name: 'CurrentTemperature', value: 29 })
    assert.equal(h.logs.warn.length, 1)
    assert.equal(h.logs.info.filter(line => line.includes('restored')).length, 1)
    await h.poll()
    assert.equal(h.updates.length, 2)
  })
}

test('clock failures share outage reporting and only valid state reads report recovery', async t => {
  const h = setupPlatform(t, { syncTime: true })
  await flush()
  assert.equal(h.intervals[0].delay, 24 * 60 * 60 * 1000)
  h.respond(async () => { throw networkError('EHOSTUNREACH') })
  await h.intervals[0].fn()
  await h.poll()
  assert.equal(h.logs.warn.length, 1)

  h.respond(async () => new Response('OK'))
  await h.intervals[0].fn()
  await assert.rejects(h.char('CurrentHeatingCoolingState').get(), h.isHapError)
  assert.equal(h.logs.info.filter(line => line.includes('restored')).length, 0)
  assert.equal(h.logs.warn.length, 1)

  h.respond(async () => new Response(state))
  await h.poll()
  assert.equal(h.logs.info.filter(line => line.includes('restored')).length, 1)
  h.respond(async () => { throw networkError('EHOSTUNREACH') })
  await h.poll()
  assert.equal(h.logs.warn.length, 2)
})

test('off-base readings keep their existing HomeKit behavior without a connection warning', async t => {
  const h = setupPlatform(t)
  await flush()
  h.respond(async () => new Response(state.replace('28 C', 'nan')))
  await assert.rejects(h.char('CurrentTemperature').get(), h.isHapError)
  assert.equal(await h.char('CurrentHeatingCoolingState').get(), 0)
  await h.poll()
  assert.equal(h.logs.warn.length, 0)
  assert.equal(h.updates.length, 1)
  h.respond(async () => new Response(state))
  await h.poll()
  assert.equal(h.updates.length, 2)
  assert.equal(h.logs.info.filter(line => line.includes('restored')).length, 0)
})

test('HTTP, body-read, timeout and invalid-state failures become HomeKit errors', async t => {
  const h = setupPlatform(t)
  await flush()
  for (const respond of [
    async () => new Response('unavailable', { status: 503 }),
    async () => ({ ok: true, text: async () => { throw networkError('ECONNRESET') } }),
    async () => { throw new DOMException('Timed out', 'TimeoutError') },
    async () => new Response('not a kettle state'),
  ]) {
    h.respond(respond)
    await Promise.all(readNames.map(name => assert.rejects(h.char(name).get(), h.isHapError)))
  }
})
