const { randomUUID } = require('node:crypto');

const DEFAULT_ALLOWED_ACTIONS = [
  'getState',
  'setState',
  'listStates',
  'getStates',
  'ping',
  'handleIntent',
  'executePlan',
  'validatePlan',
  'emitContextEvent',
  'getContextEvents',
  'handlePvSurplus',
];

function parseList(value, fallback = []) {
  if (value == null || value === '') return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeConfig(config = {}) {
  return {
    allowedPrefixes: parseList(config.allowedPrefixes, ['javascript.0', '0_userdata.0']),
    allowedActions: parseList(config.allowedActions, DEFAULT_ALLOWED_ACTIONS),
    commandTimeoutMs: Number(config.commandTimeoutMs) > 0 ? Number(config.commandTimeoutMs) : 5000,
    setStateAckAllowed: config.setStateAckAllowed !== false,
    criticalStatePrefixes: parseList(config.criticalStatePrefixes, ['system.', 'admin.0']),
    requireConfirmationActions: parseList(config.requireConfirmationActions, ['executePlan']),
    comfortTemperatureStateId: config.comfortTemperatureStateId || '0_userdata.0.hvac.livingRoom.targetTemperature',
    comfortTempStep: Number(config.comfortTempStep) > 0 ? Number(config.comfortTempStep) : 1,
    contextEventHistoryLimit: Number(config.contextEventHistoryLimit) > 0 ? Number(config.contextEventHistoryLimit) : 50,
    pvSurplusMinWatts: Number(config.pvSurplusMinWatts) > 0 ? Number(config.pvSurplusMinWatts) : 1500,
    pvSurplusLoadStateId: config.pvSurplusLoadStateId || '0_userdata.0.energy.pvSurplusMode',
  };
}

function isAllowedId(id, allowedPrefixes) {
  if (!id || typeof id !== 'string') return false;
  if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length === 0) return false;
  return allowedPrefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}.`));
}

function isCriticalId(id, criticalPrefixes) {
  if (!id || typeof id !== 'string') return false;
  return (criticalPrefixes || []).some((prefix) => id.startsWith(prefix));
}

function sanitizeRequest(input) {
  const payload = typeof input === 'string' ? JSON.parse(input) : input;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('command must be a JSON object');
  }
  return payload;
}

function withTimeout(promise, timeoutMs, action) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`action timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEOUT';
      err.details = { action, timeoutMs };
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function toStructuredError(err, fallbackCode = 'EUNKNOWN') {
  const code = err?.code || fallbackCode;
  return {
    code,
    message: err?.message || String(err),
    details: err?.details,
  };
}

class BridgeRuntime {
  constructor(adapter, config) {
    this.adapter = adapter;
    this.config = normalizeConfig(config);
    this.startedAt = Date.now();
    this.counts = {
      total: 0,
      success: 0,
      failed: 0,
      timedOut: 0,
    };
  }

  async ensureResponseState(requestId) {
    const stateId = `responses.${requestId}`;
    await this.adapter.setObjectNotExistsAsync(stateId, {
      type: 'state',
      common: {
        name: `Response for request ${requestId}`,
        type: 'string',
        role: 'json',
        read: true,
        write: false,
        def: '',
      },
      native: {},
    });
    return stateId;
  }

  async ensureState(stateId, name = stateId, role = 'json') {
    await this.adapter.setObjectNotExistsAsync(stateId, {
      type: 'state',
      common: {
        name,
        type: 'string',
        role,
        read: true,
        write: false,
        def: '',
      },
      native: {},
    });
  }

  async setAuditStates(meta) {
    const updates = [
      this.adapter.setStateAsync('info.lastRequestId', meta.requestId || '', true),
      this.adapter.setStateAsync('info.lastAction', meta.action || '', true),
      this.adapter.setStateAsync('info.lastDurationMs', meta.durationMs, true),
      this.adapter.setStateAsync('info.totalCount', this.counts.total, true),
      this.adapter.setStateAsync('info.successCount', this.counts.success, true),
      this.adapter.setStateAsync('info.failureCount', this.counts.failed, true),
      this.adapter.setStateAsync('info.timeoutCount', this.counts.timedOut, true),
      this.adapter.setStateAsync('info.lastUpdated', new Date().toISOString(), true),
    ];

    if (meta.errorMessage != null) {
      updates.push(this.adapter.setStateAsync('info.lastError', meta.errorMessage, true));
    }

    await Promise.all(updates);
  }

  buildIntentPlan(payload) {
    const text = String(payload.text || '').toLowerCase();
    const plan = { operations: [], contextEvents: [] };

    if (!text) {
      const err = new Error('missing text');
      err.code = 'EBADREQUEST';
      throw err;
    }

    if (text.includes('mir ist kalt') || text.includes('zu kalt')) {
      const target = Number(payload.currentTargetTemp ?? 21) + this.config.comfortTempStep;
      plan.operations.push({
        type: 'setState',
        id: this.config.comfortTemperatureStateId,
        value: target,
        ack: false,
        reason: 'comfort.cold',
      });
      plan.contextEvents.push({
        type: 'comfort',
        name: 'user_feels_cold',
        confidence: 0.95,
      });
    }

    if (text.includes('gute nacht') || text.includes('ich gehe schlafen')) {
      plan.contextEvents.push({ type: 'habit', name: 'bedtime', confidence: 0.9 });
    }

    if (plan.operations.length === 0 && plan.contextEvents.length === 0) {
      plan.contextEvents.push({ type: 'intent', name: 'unmapped_intent', confidence: 0.3 });
    }

    return plan;
  }

  async getJsonState(id, fallback) {
    const state = await this.adapter.getStateAsync(id);
    if (!state || state.val == null || state.val === '') return fallback;
    try {
      return JSON.parse(String(state.val));
    } catch {
      return fallback;
    }
  }

  async emitContextEvent(event) {
    const ts = new Date().toISOString();
    const record = { ...event, ts };
    await this.ensureState('events.context.last', 'Last context event', 'json');
    await this.ensureState('events.context.history', 'Recent context events', 'json');

    const history = await this.getJsonState('events.context.history', []);
    const nextHistory = Array.isArray(history)
      ? [...history, record].slice(-this.config.contextEventHistoryLimit)
      : [record];

    await this.adapter.setStateAsync('events.context.last', JSON.stringify(record), true);
    await this.adapter.setStateAsync('events.context.history', JSON.stringify(nextHistory), true);
    return record;
  }

  validateOperation(op) {
    if (!op || op.type !== 'setState' || !op.id) {
      const err = new Error('only setState operations with id are supported');
      err.code = 'EBADREQUEST';
      throw err;
    }
    if (!isAllowedId(op.id, this.config.allowedPrefixes)) {
      const err = new Error(`state id is not allowed: ${op.id}`);
      err.code = 'EIDFORBIDDEN';
      throw err;
    }
  }

  validatePlan(operations, options = {}) {
    if (!Array.isArray(operations) || operations.length === 0) {
      const err = new Error('missing operations array');
      err.code = 'EBADREQUEST';
      throw err;
    }

    const confirmation = options.confirmation === true;
    const checks = [];

    for (const op of operations) {
      const base = {
        id: op?.id,
        type: op?.type,
        critical: false,
        confirmationRequired: false,
        executable: false,
      };

      try {
        this.validateOperation(op);
        const critical = op.critical === true || isCriticalId(op.id, this.config.criticalStatePrefixes);
        const confirmationRequired = critical && !confirmation;
        checks.push({
          ...base,
          critical,
          confirmationRequired,
          executable: !confirmationRequired,
        });
      } catch (err) {
        checks.push({
          ...base,
          executable: false,
          error: toStructuredError(err, 'EBADREQUEST'),
        });
      }
    }

    return {
      valid: checks.every((check) => check.executable),
      confirmationProvided: confirmation,
      checks,
    };
  }

  async executePlan(operations, options = {}) {
    const validation = this.validatePlan(operations, options);

    const confirmation = options.confirmation === true;
    const results = [];

    for (const op of operations) {
      this.validateOperation(op);
      const critical = op.critical === true || isCriticalId(op.id, this.config.criticalStatePrefixes);
      if (critical && !confirmation) {
        await this.ensureState('safety.pendingConfirmation', 'Pending safety confirmation', 'json');
        await this.adapter.setStateAsync('safety.pendingConfirmation', JSON.stringify({ op, requestedAt: new Date().toISOString() }), true);
        results.push({ ok: false, id: op.id, error: { code: 'ECONFIRMREQUIRED', message: 'critical operation needs confirmation' } });
        continue;
      }

      await this.adapter.setForeignStateAsync(op.id, op.value, Boolean(op.ack));
      results.push({ ok: true, id: op.id, value: op.value, ack: Boolean(op.ack) });
    }

    return { results };
  }

  async executeAction(payload) {
    const action = payload.action;
    if (!action) {
      const err = new Error('missing action');
      err.code = 'EBADREQUEST';
      throw err;
    }

    if (!this.config.allowedActions.includes(action)) {
      const err = new Error(`action not allowed: ${action}`);
      err.code = 'EACTIONFORBIDDEN';
      err.details = { allowedActions: this.config.allowedActions };
      throw err;
    }

    if (action === 'ping') {
      return {
        pong: true,
        ts: new Date().toISOString(),
        uptimeMs: Date.now() - this.startedAt,
        version: this.adapter.version,
      };
    }

    if (action === 'emitContextEvent') {
      const event = payload.event || {};
      return { event: await this.emitContextEvent(event) };
    }

    if (action === 'handleIntent') {
      const plan = this.buildIntentPlan(payload);
      await this.ensureState('intents.lastPlan', 'Last generated intent plan', 'json');
      await this.adapter.setStateAsync('intents.lastPlan', JSON.stringify({ input: payload.text, plan }), true);

      for (const event of plan.contextEvents) {
        await this.emitContextEvent(event);
      }

      if (payload.execute === true && plan.operations.length > 0) {
        const execution = await this.executePlan(plan.operations, { confirmation: payload.confirmation === true });
        return { plan, execution };
      }

      return { plan, execution: null };
    }

    if (action === 'handlePvSurplus') {
      const watts = Number(payload.watts);
      if (!Number.isFinite(watts)) {
        const err = new Error('missing numeric watts');
        err.code = 'EBADREQUEST';
        throw err;
      }

      const enabled = watts >= this.config.pvSurplusMinWatts;
      const operations = [
        {
          type: 'setState',
          id: this.config.pvSurplusLoadStateId,
          value: enabled,
          ack: false,
          reason: 'energy.pv_surplus',
        },
      ];

      const execution = await this.executePlan(operations, { confirmation: payload.confirmation === true });
      await this.emitContextEvent({ type: 'energy', name: 'pv_surplus_evaluated', watts, enabled });
      return {
        watts,
        threshold: this.config.pvSurplusMinWatts,
        enabled,
        execution,
      };
    }

    if (action === 'executePlan') {
      const requiresConfirmation = this.config.requireConfirmationActions.includes('executePlan');
      return this.executePlan(payload.operations, {
        confirmation: requiresConfirmation ? payload.confirmation === true : true,
      });
    }

    if (action === 'validatePlan') {
      return this.validatePlan(payload.operations, { confirmation: payload.confirmation === true });
    }

    if (action === 'getContextEvents') {
      const maxLimit = this.config.contextEventHistoryLimit;
      const requestedLimit = Number(payload.limit);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, maxLimit) : 10;
      const history = await this.getJsonState('events.context.history', []);
      const events = Array.isArray(history) ? history.slice(-limit).reverse() : [];
      return { events, limit, total: Array.isArray(history) ? history.length : 0 };
    }

    if (action === 'listStates') {
      const out = [];
      for (const prefix of this.config.allowedPrefixes) {
        const view = await this.adapter.getObjectViewAsync('system', 'state', {
          startkey: `${prefix}.`,
          endkey: `${prefix}.\u9999`,
        });
        for (const row of view.rows || []) out.push(row.id);
      }
      return { states: out };
    }

    if (action === 'getState') {
      const targetId = payload.id;
      if (!isAllowedId(targetId, this.config.allowedPrefixes)) {
        const err = new Error(`state id is not allowed: ${targetId}`);
        err.code = 'EIDFORBIDDEN';
        throw err;
      }
      const state = await this.adapter.getForeignStateAsync(targetId);
      return { id: targetId, state };
    }

    if (action === 'getStates') {
      const ids = Array.isArray(payload.ids) ? payload.ids : [];
      if (ids.length === 0) {
        const err = new Error('missing ids array');
        err.code = 'EBADREQUEST';
        throw err;
      }
      const result = {};
      for (const id of ids) {
        if (!isAllowedId(id, this.config.allowedPrefixes)) {
          result[id] = { ok: false, error: { code: 'EIDFORBIDDEN', message: `state id is not allowed: ${id}` } };
          continue;
        }
        try {
          result[id] = { ok: true, state: await this.adapter.getForeignStateAsync(id) };
        } catch (err) {
          result[id] = { ok: false, error: toStructuredError(err, 'EGETSTATE') };
        }
      }
      return { result };
    }

    if (action === 'setState') {
      const targetId = payload.id;
      if (!isAllowedId(targetId, this.config.allowedPrefixes)) {
        const err = new Error(`state id is not allowed: ${targetId}`);
        err.code = 'EIDFORBIDDEN';
        throw err;
      }

      const ackRequested = Boolean(payload.ack);
      if (ackRequested && !this.config.setStateAckAllowed) {
        const err = new Error('ack=true is not allowed by policy');
        err.code = 'EACKFORBIDDEN';
        throw err;
      }

      await this.adapter.setForeignStateAsync(targetId, payload.value, ackRequested);
      return { id: targetId, ack: ackRequested };
    }

    const err = new Error(`unsupported action: ${action}`);
    err.code = 'ENOTSUPPORTED';
    throw err;
  }

  async processCommand(rawPayload) {
    const started = Date.now();
    this.counts.total += 1;

    let payload;
    try {
      payload = sanitizeRequest(rawPayload);
    } catch (err) {
      this.counts.failed += 1;
      const requestId = randomUUID();
      const response = {
        ok: false,
        requestId,
        action: undefined,
        error: toStructuredError({ ...err, code: 'EBADJSON' }, 'EBADJSON'),
        durationMs: Date.now() - started,
      };
      await this.publishResponse(response);
      return response;
    }

    const requestId = payload.requestId || randomUUID();
    const action = payload.action;

    try {
      const data = await withTimeout(this.executeAction(payload), this.config.commandTimeoutMs, action);
      this.counts.success += 1;
      const response = {
        ok: true,
        requestId,
        action,
        data,
        durationMs: Date.now() - started,
      };
      await this.publishResponse(response);
      return response;
    } catch (err) {
      this.counts.failed += 1;
      if (err?.code === 'ETIMEOUT') this.counts.timedOut += 1;
      const response = {
        ok: false,
        requestId,
        action,
        error: toStructuredError(err),
        durationMs: Date.now() - started,
      };
      await this.publishResponse(response);
      return response;
    }
  }

  async publishResponse(response) {
    const encoded = JSON.stringify(response);
    await this.adapter.setStateAsync('control.lastResult', encoded, true);
    const perRequestId = await this.ensureResponseState(response.requestId);
    await this.adapter.setStateAsync(perRequestId, encoded, true);

    await this.setAuditStates({
      requestId: response.requestId,
      action: response.action,
      durationMs: response.durationMs,
      errorMessage: response.ok ? '' : `${response.error.code}: ${response.error.message}`,
    });
  }
}

module.exports = {
  BridgeRuntime,
  normalizeConfig,
  isAllowedId,
  sanitizeRequest,
  toStructuredError,
  isCriticalId,
};
