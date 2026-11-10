// Wire capture: runs the REAL DesktopChatAgent + REAL OpenAiCompatibleProvider
// against a fake gateway and records the exact request body the model would
// receive, then breaks it down by source with the wire tokenizer.
//
//   node scripts/wire-capture.mjs                 # all scenarios, summary table
//   node scripts/wire-capture.mjs --full hello    # also dump one scenario's raw system prompt
//
// Captures are written to output/wire-capture/<scenario>.json so a model (or a
// human) can be shown byte-for-byte what the harness sent.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const { DesktopChatAgent } = require(path.join(root, 'desktop/agent/desktopChatAgent.cjs'));
const { createOpenAiCompatibleProvider } = require(path.join(root, 'desktop/agent/openAiCompatibleProvider.cjs'));
const { ComputerTools } = require(path.join(root, 'desktop/computer/computerTools.cjs'));
const { breakdownRequest, countTokens } = require(path.join(root, 'desktop/agent/wireTokenizer.cjs'));
const { REPLY_STYLE_PROMPT } = require(path.join(root, 'desktop/agent/replyStyle.cjs'));
const { PUBLIC_FEEDBACK_INSTRUCTION } = require(path.join(root, 'desktop/agent/providers/wire.cjs'));

const outDir = path.join(root, 'output', 'wire-capture');
fs.mkdirSync(outDir, { recursive: true });

// Anchors attribute slices of the system prompt to the code that wrote them.
const ANCHORS = {
  'REPLY STYLE (replyStyle.cjs)': 'REPLY STYLE',
  'public-feedback rule (wire.cjs)': PUBLIC_FEEDBACK_INSTRUCTION.slice(0, 40),
  'AGI playbook (computerCatalog.cjs)': 'Browser-use Agent Chat. Complete the task through tool calls'
};

const SCENARIOS = [
  { name: 'hello', mode: 'browser', task: 'hello' },
  { name: 'complex-agi', mode: 'agi', workspace: root,
    task: 'In the current repo, find the index file that controls the program and analyse and fix its design. 1) find the file 2) list the design problems 3) fix them 4) verify in the browser. Do not touch unrelated files.' },
  { name: 'followup-after-focus-message', mode: 'agi', workspace: root, followup: true,
    task: 'fix that',
    focusMessage: 'Your native desktop focus was released. Tell the requesting agent when your work is complete if needed.' }
];

function makeController() {
  return {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
}

async function runScenario(scenario) {
  const bodies = [];
  const backend = new ComputerTools({
    nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  const gateway = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const content = JSON.stringify({ toolCalls: [{ name: 'browser_done', input: { summary: 'Captured.', success: true, verified: true } }] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const agent = new DesktopChatAgent({
    controller: makeController(), getSelectedTabId: () => 'tab', getControlMode: () => scenario.mode, getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://gateway.invalid/v1', model: 'capture-model', apiKey: 'k', fetchImpl: gateway })
  });
  const settings = { approvalMode: 'unattended', controlMode: scenario.mode };
  const workspace = scenario.workspace ? { root: scenario.workspace, target: scenario.workspace } : undefined;
  try {
    if (scenario.followup) {
      await agent.start({ task: 'find the index file that controls the program', settings, workspace });
      bodies.length = 0;
      // receiveAgentMessage() only accepts a message while a run is live, so a
      // message sent between turns is dropped. initialAgentMessages is the
      // supported way to hand a run its inbox, and it lands in the model's
      // context exactly as a message delivered mid-run does (agentMessages).
      await agent.start({ task: scenario.task, continuation: true, settings, workspace,
        initialAgentMessages: [{ from: 'browser-use-focus', fromLabel: 'Browser-use focus coordinator', text: scenario.focusMessage, reply: true }] });
    } else {
      await agent.start({ task: scenario.task, settings, workspace });
    }
  } finally { await backend.close(); }
  // The FIRST request of the final turn is what a real model reads when it
  // starts working. Later requests in this fake run are retries: the gateway
  // always answers browser_done, which the harness's completion review bounces,
  // so they carry recovery state a real run would not have yet.
  return bodies[0] || null;
}

const rows = [];
for (const scenario of SCENARIOS) {
  const body = await runScenario(scenario);
  if (!body) { console.log(`!! ${scenario.name}: the provider never received a request`); continue; }
  fs.writeFileSync(path.join(outDir, `${scenario.name}.json`), JSON.stringify(body, null, 2));
  const report = breakdownRequest(body, ANCHORS);
  rows.push({ scenario: scenario.name, report });
}

const pad = (value, width) => String(value).padEnd(width);
for (const { scenario, report } of rows) {
  console.log(`\n=== ${scenario}  —  ~${report.totals.tokens.toLocaleString()} tokens, ${report.totals.bytes.toLocaleString()} bytes, ${report.totals.directives} directive words`);
  console.log(`${pad('part', 52)} ${pad('tokens', 8)} ${pad('% of req', 9)} directives`);
  for (const part of [...report.parts].sort((a, b) => b.tokens - a.tokens).slice(0, 14)) {
    const share = report.totals.tokens ? Math.round((part.tokens / report.totals.tokens) * 100) : 0;
    console.log(`${pad(part.label.slice(0, 51), 52)} ${pad(part.tokens, 8)} ${pad(`${share}%`, 9)} ${part.directives}`);
  }
}
const full = process.argv.includes('--full') ? process.argv[process.argv.indexOf('--full') + 1] : null;
if (full) {
  const hit = rows.find((row) => row.scenario === full);
  if (hit) console.log(`\n##### RAW SYSTEM PROMPT (${full}) #####\n${hit.report.system}`);
}
console.log(`\nraw captures: ${outDir}`);
void countTokens; void REPLY_STYLE_PROMPT;
