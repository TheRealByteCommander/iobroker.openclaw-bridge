/* eslint-disable no-console */
const utils = require('@iobroker/adapter-core');
const { BridgeRuntime } = require('./lib/bridge');

class OpenclawBridge extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'openclaw-bridge',
    });

    this.bridge = null;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  async onReady() {
    this.log.info('openclaw-bridge starting ...');

    this.bridge = new BridgeRuntime(this, this.config);

    await this.subscribeStatesAsync('control.command');
    await this.setStateAsync('control.lastResult', JSON.stringify({ ok: true, message: 'bridge ready' }), true);
    await this.setStateAsync('info.lastUpdated', new Date().toISOString(), true);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;
    if (!id.endsWith('control.command')) return;

    try {
      await this.bridge.processCommand(state.val);
    } catch (err) {
      this.log.error(`unexpected command processing error: ${err?.stack || err}`);
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
