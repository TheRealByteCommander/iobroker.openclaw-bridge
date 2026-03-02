const test = require('node:test');
const assert = require('node:assert/strict');

const { BridgeRuntime, isAllowedId, normalizeConfig, isCriticalId, retryAsync } = require('../lib/bridge');

class MockAdapter {
  constructor(config = {}) {
    this.version = '0.4.0';
    this.config = config;
    this.states = new Map();
    this.objects = new Map();
    this.foreignStates = new Map();
  }

  async setObjectNotExistsAsync(id, obj) {
    if (!this.objects.has(id)) this.objects.set(id, obj);
  }

  async setStateAsync(id, value, ack) {
    this.states.set(id, { val: value, ack });
  }

  async getStateAsync(id) {
    return this.states.get(id) ?? null;
  }

  async getForeignStateAsync(id) {
    return this.foreignStates.get(id) ?? null;
  }

  async setForeignStateAsync(id, value, ack) {
    this.foreignStates.set(id, { val: value, ack });
  }

  async getObjectViewAsync(_design, _search, query) {
    const rows = [];
    for (const key of this.foreignStates.keys()) {
      if (key >= query.startkey && key <= query.endkey) rows.push({ id: key });
    }
    return { rows };
  }
}

test('isAllowedId enforces prefix ACL', () => {
  assert.equal(isAllowedId('javascript.0.foo', ['javascript.0']), true);
  assert.equal(isAllowedId('system.adapter.admin.0', ['javascript.0']), false);
});

test('isCriticalId marks critical prefixes', () => {
  assert.equal(isCriticalId('system.adapter.admin.0.alive', ['system.']), true);
  assert.equal(isCriticalId('0_userdata.0.safe', ['system.']), false);
});

test('normalizeConfig applies sane defaults', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.allowedPrefixes, ['javascript.0', '0_userdata.0']);
  assert.equal(cfg.commandTimeoutMs, 5000);
  assert.equal(cfg.pvSurplusMinWatts, 1500);
  assert.equal(cfg.maxBatchOperations, 25);
});

test('retryAsync retries and succeeds', async () => {
  let attempts = 0;
  const value = await retryAsync(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error('temporary');
    return 42;
  }, 3, 1);
  assert.equal(value, 42);
});

test('processCommand supports request correlation and getState', async () => {
  const adapter = new MockAdapter({});
  adapter.foreignStates.set('0_userdata.0.test', { val: 42, ack: true });
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'getState',
  });

  const response = await bridge.processCommand({
    requestId: 'req-1',
    action: 'getState',
    id: '0_userdata.0.test',
  });

  assert.equal(response.ok, true);
  assert.equal(response.requestId, 'req-1');
  assert.equal(response.data.state.val, 42);
});

test('action whitelist blocks disallowed actions', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'ping',
  });

  const response = await bridge.processCommand({ action: 'setState', id: '0_userdata.0.x', value: 1 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EACTIONFORBIDDEN');
});

test('batchSetStates supports batched writes', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'batchSetStates',
  });

  const response = await bridge.processCommand({
    action: 'batchSetStates',
    operations: [
      { type: 'setState', id: '0_userdata.0.a', value: 1 },
      { type: 'setState', id: '0_userdata.0.b', value: 2 },
    ],
    confirmation: true,
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.results.length, 2);
});

test('batchSetStates negative path rejects oversized batch', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'batchSetStates',
    maxBatchOperations: 1,
  });

  const response = await bridge.processCommand({
    action: 'batchSetStates',
    operations: [
      { type: 'setState', id: '0_userdata.0.a', value: 1 },
      { type: 'setState', id: '0_userdata.0.b', value: 2 },
    ],
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EBATCHLIMIT');
});

test('syncSnapshot returns allowed prefix states', async () => {
  const adapter = new MockAdapter({});
  adapter.foreignStates.set('0_userdata.0.alpha', { val: 'A', ack: true });
  adapter.foreignStates.set('0_userdata.0.beta', { val: 'B', ack: true });
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'syncSnapshot',
  });

  const response = await bridge.processCommand({ action: 'syncSnapshot' });
  assert.equal(response.ok, true);
  assert.equal(response.data.count, 2);
});

test('getTelemetry returns runtime counters', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'ping,getTelemetry',
  });

  await bridge.processCommand({ action: 'ping' });
  const response = await bridge.processCommand({ action: 'getTelemetry' });
  assert.equal(response.ok, true);
  assert.equal(typeof response.data.avgDurationMs, 'number');
  assert.equal(typeof response.data.queueDepth, 'number');
});

test('handleIntent maps hot/cold comfort routes', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'handleIntent',
    comfortTemperatureStateId: '0_userdata.0.hvac.livingRoom.targetTemperature',
    comfortTempStep: 1,
  });

  const hot = await bridge.processCommand({ action: 'handleIntent', text: 'mir ist heiß', execute: false, currentTargetTemp: 22 });
  assert.equal(hot.ok, true);
  assert.equal(hot.data.plan.operations[0].value, 21);

  const cold = await bridge.processCommand({ action: 'handleIntent', text: 'mir ist kalt', execute: false, currentTargetTemp: 21 });
  assert.equal(cold.ok, true);
  assert.equal(cold.data.plan.operations[0].value, 22);
});
