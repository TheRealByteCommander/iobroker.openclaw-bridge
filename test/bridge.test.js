const test = require('node:test');
const assert = require('node:assert/strict');

const { BridgeRuntime, isAllowedId, normalizeConfig } = require('../lib/bridge');

class MockAdapter {
  constructor(config = {}) {
    this.version = '0.2.0';
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

test('normalizeConfig applies sane defaults', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.allowedPrefixes, ['javascript.0', '0_userdata.0']);
  assert.equal(cfg.commandTimeoutMs, 5000);
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
