const SESSION_STATES = new Set(['pairing', 'ready', 'active', 'paused', 'revoked', 'closed']);

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) throw new Error('Capabilities must be an array');
  return new Set(capabilities.filter((capability) => typeof capability === 'string' && capability.length > 0));
}

export class BrowserSession {
  constructor({ id, target, capabilities = [] } = {}) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Session id is required');
    if (!target || typeof target !== 'object') throw new Error('Session target is required');
    this.id = id;
    this.target = { ...target };
    this.capabilities = normalizeCapabilities(capabilities);
    this.state = 'ready';
    this.controllerId = null;
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
    this.pointer = null;
  }

  claimController(controllerId) {
    if (typeof controllerId !== 'string' || controllerId.length === 0) throw new Error('Controller id is required');
    if (this.controllerId && this.controllerId !== controllerId) throw new Error('Session is already controlled by another client');
    this.controllerId = controllerId;
    this.state = 'active';
    return this.controllerId;
  }

  transition(nextState) {
    if (!SESSION_STATES.has(nextState)) throw new Error(`Unknown session state: ${nextState}`);
    this.state = nextState;
    return this.state;
  }

  can(capability) {
    return this.capabilities.has(capability);
  }

  recordKey(key, isPressed) {
    if (isPressed) this.pressedKeys.add(key);
    else this.pressedKeys.delete(key);
  }

  recordButton(button, isPressed) {
    if (isPressed) this.pressedButtons.add(button);
    else this.pressedButtons.delete(button);
  }

  recordPointer(x, y) {
    this.pointer = { x, y };
  }

  inputState() {
    return {
      pressedKeys: [...this.pressedKeys],
      pressedButtons: [...this.pressedButtons],
      pointer: this.pointer ? { ...this.pointer } : null
    };
  }

  releaseInput() {
    const released = {
      keys: [...this.pressedKeys],
      buttons: [...this.pressedButtons]
    };
    this.pressedKeys.clear();
    this.pressedButtons.clear();
    this.pointer = null;
    return released;
  }
}

export { SESSION_STATES };
