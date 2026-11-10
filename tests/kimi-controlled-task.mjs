import assert from 'node:assert/strict';
import { createRuntime } from '../src/index.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import { executeTool } from '../src/tools/toolExecutor.js';
import { chatStream } from '../src/ollama/ollamaClient.js';
import { parseModelCommand } from '../src/ollama/commandParser.js';
import { buildMessages } from '../src/ollama/promptBuilder.js';
import { killBrowserTree } from '../src/browser/chromeLauncher.js';

const model = process.env.OLLAMA_MODEL || 'kimi-k2.7-code:cloud';
const baseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const goal = 'Inspect the page and return one browser_domSnapshot command. Return only a JSON command.';
const options = {
  url: 'data:text/html,' + encodeURIComponent('<title>Kimi controlled task</title><main><h1>Automation fixture</h1><button id="confirm">Confirm</button></main>'),
  port: 9238,
  serverPort: 8778,
  mode: 'controlled',
  connect: null,
  allowDangerous: false,
  maxSeconds: 60,
  args: {}
};

const context = await createRuntime(options);
const registry = createToolRegistry();
try {
  const messages = await buildMessages(context, registry, goal, null);
  const output = await chatStream({ baseUrl, model, messages });
  const parsed = parseModelCommand(output, registry);
  assert.equal(parsed.ok, true, `Kimi did not produce a usable Browser-use command: ${output}`);
  assert.equal(parsed.command, 'browser.domSnapshot', `Expected safe DOM inspection command, received ${parsed.command}`);
  const result = await executeTool(context, registry, parsed.command, parsed.args);
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /Automation fixture/);
  console.log(JSON.stringify({ ok: true, model, command: parsed.command, result: 'fixture inspected' }));
} finally {
  await context.browser.close().catch(() => {});
  await killBrowserTree(context.launch).catch(() => {});
}
