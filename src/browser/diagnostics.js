const DEFAULT_LIMIT = 500;

function boundedPush(records, value, limit = DEFAULT_LIMIT) {
  records.push(value);
  if (records.length > limit) records.splice(0, records.length - limit);
}

function serializableRemoteObject(remoteObject) {
  if (!remoteObject) return null;
  if (remoteObject.value !== undefined) return remoteObject.value;
  return remoteObject.description ?? remoteObject.type ?? null;
}

function serializeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

export class BrowserDiagnostics {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = limit;
    this.console = [];
    this.network = [];
    this.requestsById = new Map();
  }

  addConsole(entry) {
    boundedPush(this.console, entry, this.limit);
  }

  recordConsoleApi(event) {
    this.addConsole({
      time: new Date().toISOString(),
      source: 'Runtime.consoleAPICalled',
      type: event.type,
      text: event.args?.map(serializableRemoteObject).map(String).join(' ') || '',
      args: event.args?.map(serializableRemoteObject) || [],
      url: event.stackTrace?.callFrames?.[0]?.url || null,
      line: event.stackTrace?.callFrames?.[0]?.lineNumber ?? null
    });
  }

  recordException(event) {
    const details = event.exceptionDetails || {};
    this.addConsole({
      time: new Date().toISOString(),
      source: 'Runtime.exceptionThrown',
      type: 'error',
      text: details.exception?.description || details.text || 'Uncaught exception',
      args: [],
      url: details.url || null,
      line: details.lineNumber ?? null
    });
  }

  recordLogEntry(event) {
    const entry = event.entry || {};
    this.addConsole({
      time: new Date().toISOString(),
      source: 'Log.entryAdded',
      type: entry.level === 'error' ? 'error' : entry.level || 'log',
      text: entry.text || '',
      args: [],
      url: entry.url || null,
      line: entry.lineNumber ?? null
    });
  }

  requestStarted(event) {
    this.requestsById.set(event.requestId, {
      id: event.requestId,
      time: new Date().toISOString(),
      url: event.request?.url || null,
      method: event.request?.method || null,
      type: event.type || null,
      requestHeaders: serializeHeaders(event.request?.headers),
      status: null,
      statusText: null,
      responseHeaders: {},
      failed: false,
      failureText: null,
      finished: false
    });
  }

  responseReceived(event) {
    const current = this.requestsById.get(event.requestId) || { id: event.requestId, time: new Date().toISOString() };
    const response = event.response || {};
    const updated = {
      ...current,
      url: response.url || current.url || null,
      type: event.type || current.type || null,
      status: response.status ?? null,
      statusText: response.statusText || null,
      mimeType: response.mimeType || null,
      protocol: response.protocol || null,
      responseHeaders: serializeHeaders(response.headers)
    };
    this.requestsById.set(event.requestId, updated);
    if (updated.status >= 400) {
      boundedPush(this.network, { ...updated, failed: true, finished: true }, this.limit);
      this.requestsById.delete(event.requestId);
    }
  }

  requestFailed(event) {
    const current = this.requestsById.get(event.requestId) || { id: event.requestId, time: new Date().toISOString() };
    this.requestsById.set(event.requestId, {
      ...current,
      failed: true,
      failureText: event.errorText || 'Network request failed',
      canceled: Boolean(event.canceled),
      finished: true
    });
  }

  requestFinished(event) {
    const current = this.requestsById.get(event.requestId);
    if (current) this.requestsById.set(event.requestId, { ...current, finished: true, encodedDataLength: event.encodedDataLength ?? 0 });
  }

  finalizeRequest(event) {
    const request = this.requestsById.get(event.requestId);
    if (!request || !request.finished) return;
    boundedPush(this.network, request, this.limit);
    this.requestsById.delete(event.requestId);
  }

  flushPending() {
    for (const request of this.requestsById.values()) {
      boundedPush(this.network, { ...request, finished: request.finished || false }, this.limit);
    }
    this.requestsById.clear();
  }

  snapshot() {
    return { console: this.console.length, network: this.network.length };
  }

  consoleSince(start = 0) {
    return this.console.slice(start);
  }

  networkSince(start = 0) {
    return this.network.slice(start);
  }

  clearConsole() {
    this.console = [];
  }

  clearNetwork() {
    this.network = [];
    this.requestsById.clear();
  }

  failedRequests() {
    return this.network.filter((request) => request.failed || (request.status != null && request.status >= 400));
  }
}
