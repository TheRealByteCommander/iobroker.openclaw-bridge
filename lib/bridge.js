const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

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
  'help',
  'speak',
  'transcribe',
  'voiceCommand',
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
    retryAttempts: Number(config.retryAttempts) > 0 ? Number(config.retryAttempts) : 3,
    retryBackoffMs: Number(config.retryBackoffMs) >= 0 ? Number(config.retryBackoffMs) : 100,
    maxBatchOperations: Number(config.maxBatchOperations) > 0 ? Number(config.maxBatchOperations) : 25,
    queueHighWatermark: Number(config.queueHighWatermark) > 0 ? Number(config.queueHighWatermark) : 100,
    alexaTtsStateId: config.alexaTtsStateId || 'alexa2.0.Echo-Devices.Speak',
    sttCommand: config.sttCommand || 'faster-whisper',
    sttModel: config.sttModel || 'small',
    sttLanguage: config.sttLanguage || 'de',
    shutterPositionTolerance: Number(config.shutterPositionTolerance) > 0 ? Number(config.shutterPositionTolerance) : 10,
    shutterPollMs: Number(config.shutterPollMs) > 0 ? Number(config.shutterPollMs) : 1000,
    shutterMoveTimeoutMs: Number(config.shutterMoveTimeoutMs) > 0 ? Number(config.shutterMoveTimeoutMs) : 90000,
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


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryAsync(fn, attempts = 3, backoffMs = 100) {
  let lastErr;
  for (let i = 1; i <= Math.max(1, attempts); i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(backoffMs * i);
    }
  }
  throw lastErr;
}

function execFileAsync(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || error.message || 'command failed');
        err.code = 'ESTTFAILED';
        err.details = { command, args, stderr: String(stderr || '').slice(0, 2000) };
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
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
  const details = err?.details;
  let nextAction = 'retry';
  if (code === 'EACTIONFORBIDDEN') nextAction = 'use_allowed_action_or_update_config';
  if (code === 'EIDFORBIDDEN') nextAction = 'use_allowed_prefix_or_update_config';
  if (code === 'ECONFIRMREQUIRED') nextAction = 'resend_with_confirmation_true';
  if (code === 'ETIMEOUT') nextAction = 'check_adapter_latency_or_raise_timeout';
  if (code === 'EBADREQUEST' || code === 'EBADJSON') nextAction = 'fix_request_payload';
  return {
    code,
    message: err?.message || String(err),
    details,
    nextAction,
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
      retries: 0,
      queueRejected: 0,
    };
    this.durationMsWindow = [];
    this.queueDepth = 0;
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
      this.adapter.setStateAsync('info.retryCount', this.counts.retries, true),
      this.adapter.setStateAsync('info.queueRejected', this.counts.queueRejected, true),
      this.adapter.setStateAsync('info.queueDepth', this.queueDepth, true),
      this.adapter.setStateAsync('info.avgDurationMs', meta.avgDurationMs ?? 0, true),
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

    if (text.includes('mir ist kalt') || text.includes('zu kalt') || text.includes('wärmer')) {
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

    if (text.includes('zu warm') || text.includes('mir ist heiß')) {
      const target = Number(payload.currentTargetTemp ?? 21) - this.config.comfortTempStep;
      plan.operations.push({
        type: 'setState',
        id: this.config.comfortTemperatureStateId,
        value: target,
        ack: false,
        reason: 'comfort.hot',
      });
      plan.contextEvents.push({ type: 'comfort', name: 'user_feels_hot', confidence: 0.9 });
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
        await this.adapter.setStateAsync('safety.pendingConfirmation', JSON.stringify({ op, requestedAt: new Date().toISOString(), nextAction: 'resend_with_confirmation_true' }), true);
        results.push({ ok: false, id: op.id, error: { code: 'ECONFIRMREQUIRED', message: 'critical operation needs confirmation' } });
        continue;
      }

      const shutterBaseId = this.getShutterBaseId(op.id);
      if (shutterBaseId && typeof op.value !== 'object') {
        const shutter = await this.driveShutterToPosition(shutterBaseId, op.value);
        results.push({ ok: true, id: op.id, value: op.value, ack: Boolean(op.ack), shutter });
        continue;
      }

      await this.setForeignStateWithRetry(op.id, op.value, Boolean(op.ack));
      results.push({ ok: true, id: op.id, value: op.value, ack: Boolean(op.ack) });
    }

    return { results };
  }


  async setForeignStateWithRetry(id, value, ack) {
    return retryAsync(() => this.adapter.setForeignStateAsync(id, value, ack), this.config.retryAttempts, this.config.retryBackoffMs);
  }

  async getForeignStateWithRetry(id) {
    return retryAsync(() => this.adapter.getForeignStateAsync(id), this.config.retryAttempts, this.config.retryBackoffMs);
  }

  getShutterBaseId(stateId) {
    if (typeof stateId !== 'string') return null;
    if (stateId.endsWith('.SHUTTER1')) return stateId.slice(0, -'.SHUTTER1'.length);
    if (stateId.endsWith('.Shutter1_Position')) return stateId.slice(0, -'.Shutter1_Position'.length);
    return null;
  }

  async driveShutterToPosition(baseId, rawTarget) {
    const target = Math.max(0, Math.min(100, Number(rawTarget)));
    if (!Number.isFinite(target)) {
      const err = new Error('invalid shutter target');
      err.code = 'EBADREQUEST';
      throw err;
    }

    const posId = `${baseId}.Shutter1_Position`;
    const dirId = `${baseId}.Shutter1_Direction`;
    const upId = `${baseId}.POWER1`;
    const downId = `${baseId}.POWER2`;

    const currentState = await this.getForeignStateWithRetry(posId);
    const current = Number(currentState?.val ?? 0);
    if (!Number.isFinite(current)) {
      const err = new Error(`cannot read current shutter position: ${posId}`);
      err.code = 'EGETSTATE';
      throw err;
    }

    const tolerance = this.config.shutterPositionTolerance;
    if (Math.abs(current - target) <= tolerance) {
      return { baseId, target, current, reached: true, tolerance, mode: 'already-in-range' };
    }

    const goUp = target > current;
    // power1=hoch, power2=runter
    await this.setForeignStateWithRetry(goUp ? downId : upId, false, false);
    await this.setForeignStateWithRetry(goUp ? upId : downId, true, false);

    if (target === 0 || target === 100) {
      // Endposition: laufen lassen bis Auto-Stop (Direction=0) oder Timeout.
      const startedAt = Date.now();
      while (Date.now() - startedAt < this.config.shutterMoveTimeoutMs) {
        await sleep(this.config.shutterPollMs);
        const dirState = await this.getForeignStateWithRetry(dirId);
        const posState = await this.getForeignStateWithRetry(posId);
        const direction = Number(dirState?.val ?? 0);
        const position = Number(posState?.val ?? 0);
        if (direction === 0) {
          return { baseId, target, current: position, reached: true, tolerance, mode: 'end-stop-auto' };
        }
      }
      return { baseId, target, current, reached: false, tolerance, mode: 'end-stop-timeout' };
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.config.shutterMoveTimeoutMs) {
      await sleep(this.config.shutterPollMs);
      const posState = await this.getForeignStateWithRetry(posId);
      const now = Number(posState?.val ?? current);
      if (Number.isFinite(now) && Math.abs(now - target) <= tolerance) {
        await this.setForeignStateWithRetry(upId, false, false);
        await this.setForeignStateWithRetry(downId, false, false);
        return { baseId, target, current: now, reached: true, tolerance, mode: 'tolerance-stop' };
      }
    }

    await this.setForeignStateWithRetry(upId, false, false);
    await this.setForeignStateWithRetry(downId, false, false);
    return { baseId, target, current, reached: false, tolerance, mode: 'timeout-stop' };
  }

  async getSyncSnapshot() {
    const snapshot = {};
    for (const prefix of this.config.allowedPrefixes) {
      const view = await this.adapter.getObjectViewAsync('system', 'state', {
        startkey: `${prefix}.`,
        endkey: `${prefix}.香`,
      });
      for (const row of view.rows || []) {
        snapshot[row.id] = await this.getForeignStateWithRetry(row.id);
      }
    }
    return snapshot;
  }

  async speakText(text) {
    const message = String(text || '').trim();
    if (!message) {
      const err = new Error('missing text');
      err.code = 'EBADREQUEST';
      throw err;
    }
    const stateId = this.config.alexaTtsStateId;
    if (!isAllowedId(stateId, this.config.allowedPrefixes)) {
      const err = new Error(`state id is not allowed: ${stateId}`);
      err.code = 'EIDFORBIDDEN';
      throw err;
    }
    await this.setForeignStateWithRetry(stateId, message, false);
    return { stateId, text: message };
  }

  async transcribeAudio(payload) {
    const audioPath = String(payload.audioPath || '').trim();
    if (!audioPath) {
      const err = new Error('missing audioPath');
      err.code = 'EBADREQUEST';
      throw err;
    }
    const args = [audioPath, '--model', this.config.sttModel, '--language', this.config.sttLanguage, '--output-format', 'txt'];
    const out = await execFileAsync(this.config.sttCommand, args, this.config.commandTimeoutMs);
    const text = out.stdout.trim();
    if (!text) {
      const err = new Error('STT returned empty transcript');
      err.code = 'ESTTEMPTY';
      throw err;
    }
    return { text, command: this.config.sttCommand, model: this.config.sttModel, language: this.config.sttLanguage };
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

    if (action === 'help') {
      return {
        adapter: 'openclaw-bridge',
        allowedActions: this.config.allowedActions,
        safety: {
          criticalStatePrefixes: this.config.criticalStatePrefixes,
          requireConfirmationActions: this.config.requireConfirmationActions,
          setStateAckAllowed: this.config.setStateAckAllowed,
        },
        quickStart: [
          { action: 'ping', payload: { action: 'ping' } },
          { action: 'getState', payload: { action: 'getState', id: `${this.config.allowedPrefixes[0]}.example` } },
          { action: 'handleIntent', payload: { action: 'handleIntent', text: 'mir ist kalt', execute: false } },
        ],
      };
    }

    if (action === 'speak') {
      return this.speakText(payload.text);
    }

    if (action === 'transcribe') {
      return this.transcribeAudio(payload);
    }

    if (action === 'voiceCommand') {
      const transcript = await this.transcribeAudio(payload);
      const planResult = await this.executeAction({
        action: 'handleIntent',
        text: transcript.text,
        execute: payload.execute !== false,
        confirmation: payload.confirmation === true,
        currentTargetTemp: payload.currentTargetTemp,
      });
      if (payload.speak !== false) {
        const summary = payload.speakText || `Verstanden: ${transcript.text}`;
        await this.speakText(summary);
      }
      return { transcript, planResult };
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
      const state = await this.getForeignStateWithRetry(targetId);
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
          result[id] = { ok: true, state: await this.getForeignStateWithRetry(id) };
        } catch (err) {
          result[id] = { ok: false, error: toStructuredError(err, 'EGETSTATE') };
        }
      }
      return { result };
    }

    if (action === 'batchSetStates') {
      const operations = Array.isArray(payload.operations) ? payload.operations : [];
      if (operations.length === 0) {
        const err = new Error('missing operations array');
        err.code = 'EBADREQUEST';
        throw err;
      }
      if (operations.length > this.config.maxBatchOperations) {
        const err = new Error(`batch too large: max ${this.config.maxBatchOperations}`);
        err.code = 'EBATCHLIMIT';
        throw err;
      }
      return this.executePlan(operations, { confirmation: payload.confirmation === true });
    }

    if (action === 'syncSnapshot') {
      const snapshot = await this.getSyncSnapshot();
      return { snapshot, count: Object.keys(snapshot).length };
    }

    if (action === 'getTelemetry') {
      const avgDurationMs = this.durationMsWindow.length
        ? this.durationMsWindow.reduce((a, b) => a + b, 0) / this.durationMsWindow.length
        : 0;
      return {
        counts: this.counts,
        queueDepth: this.queueDepth,
        avgDurationMs,
        uptimeMs: Date.now() - this.startedAt,
      };
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

      const shutterBaseId = this.getShutterBaseId(targetId);
      if (shutterBaseId && typeof payload.value !== 'object') {
        const result = await this.driveShutterToPosition(shutterBaseId, payload.value);
        return { id: targetId, ack: ackRequested, shutter: result };
      }

      await this.setForeignStateWithRetry(targetId, payload.value, ackRequested);
      return { id: targetId, ack: ackRequested };
    }

    const err = new Error(`unsupported action: ${action}`);
    err.code = 'ENOTSUPPORTED';
    throw err;
  }

  async processCommand(rawPayload) {
    const started = Date.now();
    this.counts.total += 1;
    this.queueDepth += 1;
    if (this.queueDepth > this.config.queueHighWatermark) {
      this.queueDepth -= 1;
      this.counts.failed += 1;
      this.counts.queueRejected += 1;
      const response = {
        ok: false,
        requestId: randomUUID(),
        action: undefined,
        error: { code: 'EQUEUEFULL', message: 'command queue high watermark exceeded' },
        durationMs: 0,
      };
      this.durationMsWindow.push(response.durationMs);
      if (this.durationMsWindow.length > 100) this.durationMsWindow.shift();
      this.durationMsWindow.push(response.durationMs);
      if (this.durationMsWindow.length > 100) this.durationMsWindow.shift();
      await this.publishResponse(response);
      this.queueDepth = Math.max(0, this.queueDepth - 1);
      return response;
    }

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
      this.queueDepth = Math.max(0, this.queueDepth - 1);
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
        operatorHint: action === 'help' ? 'use quickStart samples to avoid payload mistakes' : 'ok',
      };
      await this.publishResponse(response);
      this.queueDepth = Math.max(0, this.queueDepth - 1);
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
      this.queueDepth = Math.max(0, this.queueDepth - 1);
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
      avgDurationMs: this.durationMsWindow.length
        ? this.durationMsWindow.reduce((a, b) => a + b, 0) / this.durationMsWindow.length
        : 0,
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
  retryAsync,
};
