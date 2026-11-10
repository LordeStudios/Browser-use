import crypto from 'node:crypto';
import { listToolDefinitions, callMcpTool, mcpToolMap } from './mcpDispatch.js';

// ChatGPT GPT Action bridge mirroring studios/src/gptBridgeCore.mjs: an
// OpenAPI-friendly REST surface with X-API-Key auth over the same tool
// registry the MCP endpoint exposes, so the two surfaces never drift.

function timingSafeKeyMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function readJson(request, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function gptToolOperationId(toolName) {
  return toolName.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function buildGptOpenApiSchema(registry, baseUrl) {
  const paths = {};
  for (const tool of listToolDefinitions(registry)) {
    paths[`/gpt/call/${encodeURIComponent(tool.name)}`] = {
      post: {
        operationId: gptToolOperationId(tool.name),
        summary: tool.description.slice(0, 120),
        description: `${tool.description}\n\nEquivalent MCP tool: ${tool.name}.`,
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { ...tool.inputSchema, additionalProperties: true } } }
        },
        responses: {
          200: {
            description: 'Tool result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    result: { type: 'object' },
                    error: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Browser-use GPT Action',
      description: 'Drive and inspect the live local Browser-use Chromium session. The browser session is persistent: navigation, diagnostics, and page state survive between calls. Prefer read tools (browser_get_state, browser_screenshot, browser_console_logs) before interaction tools, and verify each interaction with the evidence returned in the result.',
      version: '1.0.0'
    },
    servers: [{ url: baseUrl }],
    components: {
      schemas: {},
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      }
    },
    paths
  };
}

export function formatGptToolResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: true, result: { text: String(result ?? '') } };
  }
  const textParts = [];
  let imageUrl = null;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type === 'text') textParts.push(String(block.text ?? ''));
      if (block?.type === 'image' && block.data) {
        imageUrl = `data:${block.mimeType || 'image/png'};base64,${block.data}`;
      }
    }
  }
  if (result.isError) {
    return { ok: false, error: textParts[0] || 'Tool reported an error' };
  }
  const output = {};
  if (textParts.length > 0) output.text = textParts.join('\n');
  if (imageUrl) output.imageUrl = imageUrl;
  return { ok: true, result: output };
}

export function sanitizeGptError(message) {
  const lower = String(message || '').toLowerCase();
  if (lower.includes('unauthorized') || lower.includes('missing api key') || lower.includes('invalid token')) {
    return 'Authentication failed. Ensure this action sends the configured X-API-Key header.';
  }
  if (lower.includes('unknown mcp tool') || lower.includes('not exposed')) {
    return 'Tool not exposed through the GPT Action bridge.';
  }
  if (lower.includes('timed out')) {
    return 'The browser did not answer in time. Retry the same action once, then report the failure.';
  }
  return 'The bridge could not complete the tool call.';
}

export async function handleGptRequest(server, request, response, url) {
  const baseUrl = `http://${request.headers.host || `${server.host}:${server.actualPort || server.port}`}`;

  if (request.method === 'GET' && (url.pathname === '/gpt' || url.pathname === '/gpt/')) {
    return sendJson(response, 200, {
      ok: true,
      name: 'Browser-use GPT Action Bridge',
      setup: {
        openapiUrl: `${baseUrl}/gpt/openapi.json`,
        apiKeyHeader: 'X-API-Key',
        instructions: 'Paste the OpenAPI schema into GPT Actions, configure X-API-Key, save, and call actions directly.'
      }
    });
  }

  if (!server.gptKey) {
    return sendJson(response, 503, { ok: false, error: 'GPT bridge is disabled. Start the daemon with --gpt-key or BROWSER_USE_GPT_KEY.' });
  }
  const providedKey = String(request.headers['x-api-key'] || '').trim();
  if (!providedKey || !timingSafeKeyMatch(providedKey, server.gptKey)) {
    return sendJson(response, 401, { ok: false, error: 'Missing or invalid X-API-Key header.' });
  }

  if (request.method === 'GET' && url.pathname === '/gpt/openapi.json') {
    return sendJson(response, 200, buildGptOpenApiSchema(server.registry, baseUrl));
  }

  if (request.method === 'GET' && url.pathname === '/gpt/tools') {
    return sendJson(response, 200, { ok: true, tools: listToolDefinitions(server.registry).map((tool) => tool.name) });
  }

  if (request.method === 'POST' && url.pathname.startsWith('/gpt/call/')) {
    const toolName = decodeURIComponent(url.pathname.slice('/gpt/call/'.length));
    if (!toolName || !mcpToolMap[toolName]) {
      return sendJson(response, 403, { ok: false, error: 'Tool not exposed through the GPT Action bridge.' });
    }
    let args;
    try {
      args = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { ok: false, error: `Invalid JSON body: ${error.message}` });
    }
    try {
      const outcome = await callMcpTool(server.ctx, server.registry, toolName, args);
      if (outcome.error) return sendJson(response, 502, { ok: false, error: sanitizeGptError(outcome.error.message) });
      return sendJson(response, 200, formatGptToolResult(outcome.result));
    } catch (error) {
      return sendJson(response, 502, { ok: false, error: sanitizeGptError(error?.message) });
    }
  }

  return sendJson(response, 404, { ok: false, error: 'Endpoint not found. Try /gpt/openapi.json or /gpt/call/<toolName>.' });
}
