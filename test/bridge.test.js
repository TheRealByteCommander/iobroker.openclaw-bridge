const test = require('node:test');
const assert = require('node:assert/strict');

const { BridgeRuntime, isAllowedId, normalizeConfig, isCriticalId } = require('../lib/bridge');

class MockAdapter {
  constructor(config = {}) {
    this.version = '0.3.0';
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

  const perRequestState = adapter.states.get('responses.req-1');
  assert.ok(perRequestState);
  const parsed = JSON.parse(perRequestState.val);
  assert.equal(parsed.requestId, 'req-1');
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

test('setState ack policy is enforced', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'setState',
    setStateAckAllowed: false,
  });

  const response = await bridge.processCommand({ action: 'setState', id: '0_userdata.0.target', value: true, ack: true });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'EACKFORBIDDEN');
});

test('getStates returns mixed batch results', async () => {
  const adapter = new MockAdapter({});
  adapter.foreignStates.set('0_userdata.0.a', { val: 'A', ack: true });
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'getStates',
  });

  const response = await bridge.processCommand({
    action: 'getStates',
    ids: ['0_userdata.0.a', 'system.adapter.admin.0.alive'],
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.result['0_userdata.0.a'].ok, true);
  assert.equal(response.data.result['system.adapter.admin.0.alive'].ok, false);
  assert.equal(response.data.result['system.adapter.admin.0.alive'].error.code, 'EIDFORBIDDEN');
});

test('timeout handling returns structured ETIMEOUT', async () => {
  class SlowAdapter extends MockAdapter {
    async getForeignStateAsync() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { val: 1, ack: true };
    }
  }

  const adapter = new SlowAdapter();
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'getState',
    commandTimeoutMs: 10,
  });

  const response = await bridge.processCommand({ action: 'getState', id: '0_userdata.0.slow' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'ETIMEOUT');
});

test('handleIntent maps "mir ist kalt" to comfort operation', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'handleIntent',
    comfortTemperatureStateId: '0_userdata.0.hvac.livingRoom.targetTemperature',
    comfortTempStep: 1,
  });

  const response = await bridge.processCommand({
    action: 'handleIntent',
    text: 'Mir ist kalt',
    currentTargetTemp: 21,
    execute: false,
  });

  assert.equal(response.ok, true);
  const ops = response.data.plan.operations;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, '0_userdata.0.hvac.livingRoom.targetTemperature');
  assert.equal(ops[0].value, 22);
});

test('executePlan blocks critical operation without confirmation', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0,system',
    allowedActions: 'executePlan',
    criticalStatePrefixes: 'system.',
  });

  const response = await bridge.processCommand({
    action: 'executePlan',
    operations: [{ type: 'setState', id: 'system.adapter.admin.0.alive', value: false }],
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.results[0].ok, false);
  assert.equal(response.data.results[0].error.code, 'ECONFIRMREQUIRED');
  assert.ok(adapter.states.get('safety.pendingConfirmation'));
});

test('handlePvSurplus activates surplus load when threshold is reached', async () => {
  const adapter = new MockAdapter({});
  const bridge = new BridgeRuntime(adapter, {
    allowedPrefixes: '0_userdata.0',
    allowedActions: 'handlePvSurplus',
    pvSurplusLoadStateId: '0_userdata.0.energy.pvSurplusMode',
    pvSurplusMinWatts: 1000,
  });

  const response = await bridge.processCommand({
    action: 'handlePvSurplus',
    watts: 1800,
    confirmation: true,
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.enabled, true);
  assert.equal(adapter.foreignStates.get('0_userdata.0.energy.pvSurplusMode').val, true);
});
