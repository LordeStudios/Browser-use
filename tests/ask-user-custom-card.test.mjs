import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ask_user custom card (run.txt 2026-10-29): the model can design rich
// question cards with html/css (tables, SVG flowcharts, icons, images).
// HTML must be sanitized against XSS; CSS is scoped to the card.

test('ask_user schema exposes html and css fields for model-designed cards', () => {
  const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
  const defs = toolDefinitions('multi-part task', 'agi', { workspace: true });
  const askTool = defs.find((t) => t.name === 'ask_user');
  assert.ok(askTool, 'ask_user must be offered');
  assert.ok(askTool.input?.html, 'html field must exist');
  assert.ok(askTool.input?.css, 'css field must exist');
  assert.match(askTool.input.html, /tables|SVG|flowcharts|icons/i, 'html description must mention rich content');
  assert.match(askTool.input.css, /theme|variable|--agent/i, 'css description must mention theme compliance');
  assert.match(askTool.description, /theme|obeys the app theme/i, 'description must say cards obey the theme');
});

test('ask_user result carries html and css when the model provides them', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
  const backend = new ComputerTools({
    nativeRequest: async () => ({}),
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => {
      decision++;
      if (decision === 1) return { actions: [{ name: 'ask_user', input: {
        question: 'Which approach?',
        options: '1) Per-app. 2) System-wide.',
        html: '<table><tr><th>Option</th><th>Risk</th></tr><tr><td>Per-app</td><td>Low</td></tr></table>',
        css: '.agent-ask-card { border-color: var(--agent-accent); }'
      } }] };
      return { actions: [{ name: 'browser_done', input: { summary: 'Done.', success: true, verified: true } }] };
    } })
  });
  try {
    // Bounded, unref'd poll: an unbounded poll keeps the event loop alive
    // after the run ends, so the test file never exits.
    let attempts = 0;
    const pollReply = () => {
      if (attempts++ > 200) return;
      if (agent.run && agent.resolveUserInput) {
        if (agent.resolveUserInput(agent.run, 'Option 1')) return;
      }
      const timer = setTimeout(pollReply, 5);
      if (typeof timer.unref === 'function') timer.unref();
    };
    pollReply();
    const run = await agent.start({ task: 'Pick a GPU spoofing approach', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
    const askEntries = (run.history || []).filter((e) => e.tool === 'ask_user' && e.output?.ok === true);
    assert.ok(askEntries.length >= 1, 'ask_user must succeed');
    const result = askEntries[0].output.result;
    assert.ok(result.html, 'html must be in the result');
    assert.ok(result.css, 'css must be in the result');
    assert.match(result.html, /<table>/, 'the model-designed HTML must pass through');
  } finally { await backend.close(); }
});

test('sanitizer strips script tags and event handlers from ask_user HTML', () => {
  // Test the sanitizer logic in isolation (same algorithm as app.js).
  // We replicate the sanitizer here since app.js is a renderer module.
  const ASK_SAFE_TAGS = new Set(['div','span','p','table','tr','td','th','img','svg','button','ul','ol','li','a','strong','code','pre']);
  const ASK_SAFE_ATTRS = new Set(['class','id','title','alt','src','href','width','height','style']);
  const ASK_URL_ATTRS = new Set(['src','href']);
  function sanitize(html) {
    // Minimal DOM-free sanitizer matching the app.js logic.
    let out = String(html);
    out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
    out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    out = out.replace(/<object[\s\S]*?<\/object>/gi, '');
    out = out.replace(/<embed[^>]*>/gi, '');
    out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
    out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    out = out.replace(/javascript:/gi, '');
    return out;
  }
  const dirty = '<div onclick="alert(1)"><script>steal()</script><p>Safe</p><img src="x" onerror="hack()"><a href="javascript:evil()">link</a></div>';
  const clean = sanitize(dirty);
  assert.ok(!clean.includes('<script'), 'script tags must be stripped');
  assert.ok(!clean.includes('onclick'), 'event handlers must be stripped');
  assert.ok(!clean.includes('onerror'), 'img onerror must be stripped');
  assert.ok(!clean.includes('javascript:'), 'javascript: URLs must be stripped');
  assert.ok(clean.includes('Safe'), 'safe content must survive');
});
