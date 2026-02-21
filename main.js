/* eslint-disable no-console */
const utils = require('@iobroker/adapter-core');

class OpenclawBridge extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'openclaw-bridge',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.log.info('openclaw-bridge starting ...');
    await this.subscribeStatesAsync('control.command');
    await this.setStateAsync('control.lastResult', JSON.stringify({ ok: true, message: 'bridge ready' }), true);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    if (!id.endsWith('control.command')) return;

    let payload;
    try {
      payload = JSON.parse(state.val);
    } catch {
      await this.setStateAsync('control.lastResult', JSON.stringify({ ok: false, error: 'invalid json command' }), true);
      return;
    }

    const action = payload?.action;
    if (!action) {
      await this.setStateAsync('control.lastResult', JSON.stringify({ ok: false, error: 'missing action' }), true);
      return;
    }

    try {
      if (action === 'getState') {
        const targetId = payload.id;
        if (!targetId) throw new Error('missing id');
        const result = await this.getForeignStateAsync(targetId);
        await this.setStateAsync('control.lastResult', JSON.stringify({ ok: true, action, id: targetId, result }), true);
        return;
      }

      if (action === 'setState') {
        const targetId = payload.id;
        if (!targetId) throw new Error('missing id');
        await this.setForeignStateAsync(targetId, payload.value, !!payload.ack);
        await this.setStateAsync('control.lastResult', JSON.stringify({ ok: true, action, id: targetId }), true);
        return;
      }

      if (action === 'listStates') {
        const prefixes = String(this.config.allowedPrefixes || '').split(',').map(s => s.trim()).filter(Boolean);
        const out = [];
        for (const prefix of prefixes) {
          const view = await this.getObjectViewAsync('system', 'state', { startkey: `${prefix}.`, endkey: `${prefix}.\u9999` });
          for (const row of view.rows || []) {
            out.push(row.id);
          }
        }
        await this.setStateAsync('control.lastResult', JSON.stringify({ ok: true, action, states: out }), true);
        return;
      }

      await this.setStateAsync('control.lastResult', JSON.stringify({ ok: false, error: `unsupported action: ${action}` }), true);
    } catch (err) {
      await this.setStateAsync(
        'control.lastResult',
        JSON.stringify({ ok: false, action, error: err?.message || String(err) }),
        true,
      );
    }
  }

  async onUnload(callback) {
    try {
      this.log.info('openclaw-bridge stopping ...');
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new OpenclawBridge(options);
} else {
  (() => new OpenclawBridge())();
}
