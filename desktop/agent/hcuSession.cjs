'use strict';

// Optional Microsoft Hybrid Computer Use (HCU) sidecar. HCU is deliberately
// consumed through its documented MCP executable rather than embedding its
// internal Go packages. The sidecar is disabled unless BROWSER_USE_HCU=on.
const fs = require('node:fs');
const path = require('node:path');
const { McpClientConnection } = require('./mcpClient.cjs');

const HCU_TOOLS = new Set(['AX', 'GUI']);
const HCU_ENABLED = /^(?:on|true|1)$/i;

function hcuExecutablePath({ env = process.env, resourcesPath = process.resourcesPath, moduleDir = __dirname } = {}) {
  const configured = String(env.BROWSER_USE_HCU_PATH || '').trim();
  if (configured) return configured;
  const root = resourcesPath && resourcesPath !== '.' ? resourcesPath : path.resolve(moduleDir, '..', '..');
  return path.join(root, 'hcu', process.platform === 'win32' ? 'computer-use.exe' : 'computer-use');
}

function hcuEnabled(env = process.env) {
  return HCU_ENABLED.test(String(env.BROWSER_USE_HCU || '').trim());
}

function hcuToolName(tool) {
  return `mcp__hcu__${String(tool || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}`;
}

function parseHcuToolName(name) {
  const match = String(name || '').match(/^mcp__hcu__(AX|GUI)$/);
  return match ? match[1] : null;
}

function normalizeHcuTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter(tool => HCU_TOOLS.has(String(tool?.name || '')))
    .map(tool => ({
      name: hcuToolName(tool.name),
      description: `${String(tool.description || '').slice(0, 4000)} Use HCU's live AX/GUI state; never replay stale refs or coordinates after a stale-state error.`,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {}, additionalProperties: false }
    }));
}

function hcuText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(part => part?.type === 'text')
    .map(part => String(part.text || ''))
    .join('\n')
    .slice(0, 120_000);
}

function normalizeHcuResult(raw, tool) {
  const text = hcuText(raw);
  const images = (Array.isArray(raw?.content) ? raw.content : [])
    .filter(part => part?.type === 'image')
    .map(part => ({ type: 'image', mimeType: String(part.mimeType || 'image/png'), data: part.data || null }))
    .filter(part => part.data)
    .slice(0, 4);
  return {
    ok: raw?.isError !== true,
    tool,
    hcu: true,
    ...(text ? { text } : {}),
    ...(images.length ? { images } : {}),
    ...(raw?.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
    ...(raw?.isError === true ? { error: text || 'HCU returned an MCP error.' } : {})
  };
}

class HcuSession {
  constructor({ command = hcuExecutablePath(), spawnFn, fetchImpl, log = null, env = process.env } = {}) {
    this.command = command;
    this.spawnFn = spawnFn;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.env = env;
    this.connection = null;
    this.toolsCache = [];
    this.lastError = null;
  }

  enabled() { return hcuEnabled(this.env); }

  async ensure() {
    if (!this.enabled()) return [];
    if (this.connection?.state === 'ready') return this.toolsCache;
    if (!fs.existsSync(this.command)) {
      this.lastError = `HCU executable not found at ${this.command}`;
      return [];
    }
    if (!this.connection) {
      this.connection = new McpClientConnection({
        name: 'hcu',
        config: {
          command: this.command,
          args: ['mcp'],
          // HCU documents these protocol versions. The generic client falls
          // back to its default for older external servers.
          protocolVersion: String(this.env.BROWSER_USE_HCU_MCP_VERSION || '2025-06-18')
        },
        ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        log: this.log
      });
    }
    try {
      await this.connection.connect();
      this.toolsCache = normalizeHcuTools(this.connection.tools);
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error?.message || error).slice(0, 500);
      this.toolsCache = [];
    }
    return this.toolsCache;
  }

  tools() { return [...this.toolsCache]; }

  async execute(namespacedName, input = {}, { signal } = {}) {
    const tool = parseHcuToolName(namespacedName) || String(namespacedName || '');
    if (!HCU_TOOLS.has(tool)) throw new Error(`Unknown HCU tool: ${namespacedName}`);
    if (signal?.aborted) throw new Error('HCU operation cancelled.');
    await this.ensure();
    if (!this.connection || this.connection.state !== 'ready') {
      throw new Error(this.lastError || 'HCU sidecar is not ready.');
    }
    const raw = await this.connection.callTool(tool, input);
    if (signal?.aborted) throw new Error('HCU operation cancelled.');
    return normalizeHcuResult(raw, tool);
  }

  status() {
    return {
      enabled: this.enabled(),
      command: this.command,
      tools: this.tools(),
      lastError: this.lastError,
      connection: this.connection?.status?.() || null
    };
  }

  close() {
    this.connection?.stop?.();
    this.connection = null;
    this.toolsCache = [];
  }
}

module.exports = { HcuSession, hcuExecutablePath, hcuEnabled, hcuToolName, parseHcuToolName, normalizeHcuTools, normalizeHcuResult };
