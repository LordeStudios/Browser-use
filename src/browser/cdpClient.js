import CDP from 'chrome-remote-interface';
import { BrowserDiagnostics } from './diagnostics.js';

const DEFAULT_TIMEOUT = 30000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label || 'call'}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export class CdpBrowser {
  constructor(endpoint, cdpModule = CDP) {
    this.endpoint = endpoint;
    this.cdpModule = cdpModule;
    this.host = new URL(endpoint).hostname;
    this.port = Number(new URL(endpoint).port);
    this.rootClient = null;
    this.client = null;
    this.targetId = null;
    this.diagnostics = new BrowserDiagnostics();
    Object.defineProperties(this, {
      console: { get: () => this.diagnostics.console },
      network: { get: () => this.diagnostics.network }
    });
  }

  // Compatibility surface for realtime pairing: selectTarget compares the
  // selected target id and gates reconnects on it.
  get connected() {
    return Boolean(this.client);
  }

  get target() {
    return this.targetId ? { id: this.targetId, targetId: this.targetId, type: 'page' } : null;
  }

  async _connectRoot() {
    if (this.rootClient) return this.rootClient;
    this.rootClient = await this.cdpModule({
      host: this.host,
      port: this.port,
      target: (targets) => targets.find((t) => t.type === 'browser') || targets[0]
    });
    return this.rootClient;
  }

  async listTabs() {
    const client = await this._connectRoot();
    const { targetInfos } = await client.Target.getTargets();
    return targetInfos
      .filter((t) => t.type === 'page' && !t.url.startsWith('chrome://'))
      .map((t) => ({ id: t.targetId, targetId: t.targetId, title: t.title, url: t.url, type: t.type }));
  }

  async createTab(url = 'about:blank') {
    const client = await this._connectRoot();
    const { targetId } = await client.Target.createTarget({ url });
    await this.selectTab(targetId);
    return { id: targetId, targetId, url };
  }

  async selectTab(id) {
    // Short-circuit: the requested target already owns the live client.
    if (id && this.client && this.targetId === id) return this.getCurrentInfo();

    if (this.client) {
      try { await this.client.close(); } catch {}
      this.client = null;
      this.targetId = null;
    }

    const rootClient = await this._connectRoot();
    let targetId = id;
    if (!targetId) {
      const tabs = await this.listTabs();
      const first = tabs[0];
      if (!first) throw new Error('No page tab available');
      targetId = first.targetId;
    }

    await rootClient.Target.attachToTarget({ targetId, flatten: true });
    const tabClient = await this.cdpModule({ host: this.host, port: this.port, target: targetId });
    // The client only becomes live after its domains enable: a failed enable
    // leaves the browser unconnected so ensure() reconnects on the next call.
    try {
      await this._enable(tabClient);
    } catch (error) {
      try { await tabClient.close(); } catch {}
      throw error;
    }
    this.client = tabClient;
    this.targetId = targetId;

    this._attachDiagnostics(tabClient);
    // A disconnect on a superseded client is ignored; only the live client's
    // drop clears the session so ensure() reconnects.
    tabClient.on?.('disconnect', () => {
      if (this.client === tabClient) {
        this.client = null;
        this.targetId = null;
      }
    });
    await withTimeout(tabClient.Page.bringToFront(), DEFAULT_TIMEOUT, 'Page.bringToFront').catch(() => {});
    return this.getCurrentInfo();
  }

  async _enable(client) {
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.Network.enable(),
      client.DOM.enable(),
      client.Log.enable().catch(() => {})
    ]);
    await client.Page.setLifecycleEventsEnabled({ enabled: true });
  }

  _attachDiagnostics(client) {
    const { Runtime, Log, Network } = client;
    Runtime.consoleAPICalled((event) => this.diagnostics.recordConsoleApi(event));
    Runtime.exceptionThrown((event) => this.diagnostics.recordException(event));
    Log.entryAdded((event) => this.diagnostics.recordLogEntry(event));
    Network.requestWillBeSent((event) => this.diagnostics.requestStarted(event));
    Network.responseReceived((event) => this.diagnostics.responseReceived(event));
    Network.loadingFailed((event) => {
      this.diagnostics.requestFailed(event);
      this.diagnostics.finalizeRequest(event);
    });
    Network.loadingFinished((event) => {
      this.diagnostics.requestFinished(event);
      this.diagnostics.finalizeRequest(event);
    });
  }

  async ensure() {
    if (!this.client) await this.selectTab();
    return this.client;
  }

  _waitFor(client, eventName, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for ${eventName} on target ${this.targetId}`));
      }, timeoutMs);
      const handler = (params) => { cleanup(); resolve(params); };
      const cleanup = () => { clearTimeout(timer); try { client.off(eventName, handler); } catch {} };
      client.once(eventName, handler);
    });
  }

  async navigate(url) {
    const client = await this.ensure();
    const waiter = this._waitFor(client, 'Page.loadEventFired', DEFAULT_TIMEOUT);
    const result = await client.Page.navigate({ url, transitionType: 'address_bar' });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await waiter;
    return this.getCurrentInfo();
  }

  async reload({ ignoreCache = false } = {}) {
    const client = await this.ensure();
    const waiter = this._waitFor(client, 'Page.loadEventFired', DEFAULT_TIMEOUT);
    await client.Page.reload({ ignoreCache });
    await waiter;
    return this.getCurrentInfo();
  }

  async evaluate(expression, returnByValue = true) {
    const client = await this.ensure();
    const result = await client.Runtime.evaluate({ expression, returnByValue });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Runtime.evaluate exception: ${text}`);
    }
    return result.result?.value;
  }

  async getCurrentInfo() {
    return this.evaluate(`({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      focused: document.activeElement && {
        tag: document.activeElement.tagName,
        id: document.activeElement.id,
        name: document.activeElement.getAttribute('name'),
        text: document.activeElement.innerText || document.activeElement.value || ''
      }
    })`);
  }

  clearConsole() {
    this.diagnostics.clearConsole();
  }

  clearNetwork() {
    this.diagnostics.clearNetwork();
  }

  async closeTab(id) {
    const client = await this._connectRoot();
    const targetId = id || this.targetId;
    if (!targetId) return;
    try {
      await client.Target.closeTarget({ targetId });
    } catch {}
  }

  async close() {
    if (this.client) {
      try { await this.client.close(); } catch {}
    }
    this.client = null;
    this.targetId = null;
    if (this.rootClient) {
      try { await this.rootClient.close(); } catch {}
    }
    this.rootClient = null;
  }
}

export async function connectToBrowser(endpoint) {
  const browser = new CdpBrowser(endpoint);
  await browser.selectTab();
  return browser;
}
