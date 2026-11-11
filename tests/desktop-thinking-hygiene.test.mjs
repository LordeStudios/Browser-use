import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const renderer = () => read('desktop/renderer/app.js');
const agent = () => read('desktop/agent/desktopChatAgent.cjs');

// The renderer is a browser script with no module system, so the pure
// helpers under test are lifted out of the source and evaluated in a VM
// context. That way these tests exercise the SHIPPED filter, not a copy.
function loadRendererHelpers() {
  const source = renderer();
  const pick = (pattern) => {
    const match = source.match(pattern);
    assert.ok(match, `renderer is missing ${pattern}`);
    return match[0];
  };
  const code = [
    pick(/const HARNESS_SCAFFOLD_WORDS = [^\n]*\n/),
    pick(/const HARNESS_RULE_WORDS = [^\n]*\n/),
    pick(/const HARNESS_ACTING_VERBS = [^\n]*\n/),
    pick(/const HARNESS_META_PATTERNS = \[[\s\S]*?\n\];/),
    pick(/function stripHarnessMeta\(text\) \{[\s\S]*?\n\}/)
  ].join('\n');
  const context = vm.createContext({ console });
  vm.runInContext(`${code}\nglobalThis.stripHarnessMeta = stripHarnessMeta;`, context);
  return context.stripHarnessMeta;
}

test('harness meta-talk is stripped from the thought text the user sees', () => {
  const strip = loadRendererHelpers();
  // Every one of these is the model narrating its scaffolding instead of
  // doing the task — the field run's dominant form of visible noise.
  const cases = [
    'The harness wants action NOW. I should just run the build.',
    'Given constraints "ONE tool call per decision", the runtime says batch independent calls.',
    'The gate explicitly offers "mark items skipped with a reason" as an acceptable path.',
    'The constraint from the notebook is strong, so I will do one read.',
    'But the harness said batch independent calls in one decision, so that is fine.',
    'The runtime notice earlier said "The first browser_done must satisfy the WHOLE plan".',
    'Per the harness notice, I must re-verify before finishing.',
    'The harness remedy was "Perform and observe the missing verification".'
  ];
  for (const text of cases) {
    const cleaned = strip(text);
    assert.doesNotMatch(cleaned, /\b(?:harness|runtime|gate|constraint|notice)\b/i,
      `meta-talk survived: ${text} -> ${cleaned}`);
  }
});

test('the strip keeps the task reasoning that rides along with the meta-talk', () => {
  const strip = loadRendererHelpers();
  // The technical facts must survive: the filter targets scaffolding talk,
  // not the model's actual content.
  const keep = [
    'the adb harness passes argv directly, no shell — safe',
    'android_adb runs adb itself and the device is R5CR12E64CA',
    'The build failed on dbghelp.lib, an MSVC import lib, so the host artifacts cannot link.',
    'Wire.sha256 is unresolved because the protocol module is not on the classpath.'
  ];
  for (const text of keep) {
    const cleaned = strip(text);
    assert.ok(cleaned.includes(text.trim().slice(0, 40)),
      `task reasoning was destroyed: ${text} -> ${cleaned}`);
  }
});

test('a thought that is entirely about the task is untouched', () => {
  const strip = loadRendererHelpers();
  const text = 'The manifest points at .ui.PairingActivity but the dex has com.deviceboost.node.PairingActivity, so the rebuild is required.';
  assert.equal(strip(text).trim(), text.trim());
});

test('the thinking card still renders its text through the strip', () => {
  const source = renderer();
  assert.match(source, /function userFacingThought\(value\) \{[\s\S]*?stripHarnessMeta\(text\)/,
    'userFacingThought must apply the harness-meta strip');
});

test('near-duplicate reasoning counts as a stall, not just verbatim repeats', () => {
  const source = agent();
  // The field run repeated its reasoning with small edits, so an exact
  // string match never fired and the stall notice stayed silent through
  // 137 repeated sentences.
  assert.match(source, /function sentenceOverlap\(left, right\)/);
  assert.match(source, /sentenceOverlap\(seen, normalized\) >= 0\.72/,
    'near-duplicate sentences must count toward the stall counter');
  assert.match(source, /seen === normalized \|\| sentenceOverlap/,
    'the exact match must still count');
});

test('the provider prompt never names a "harness" the model can narrate', () => {
  // Telling the model about "the harness" is what produced the field run's
  // visible "the harness wants action NOW" reasoning. The prompt must name
  // the MECHANISM, never a meta-actor the model can then talk about.
  for (const file of ['desktop/agent/openAiCompatibleProvider.cjs', 'desktop/agent/ollamaProvider.cjs']) {
    const source = read(file);
    assert.doesNotMatch(source, /The harness starts you at/,
      `${file} tells the model about "the harness"`);
    assert.match(source, /Reasoning effort starts at \$\{(?:effortTier|tier)\}/,
      `${file} must still explain the effort mechanism`);
  }
});

test('a subagent-authored card carries a producer badge', () => {
  const rendererSource = renderer();
  // DSH file split: appendConversationMessage/normalizeConversationMessage —
  // the code that actually stamps the badge — lives in agentInternals.cjs;
  // the call sites stay in the agent file.
  const internalsSource = read('desktop/agent/agentInternals.cjs');
  const agentSource = agent();
  const store = read('desktop/store/chatHistoryStore.cjs');
  // The badge must exist on the message, survive a save/reload, and render.
  assert.match(agentSource, /badge: 'research'/, 'research briefs must be badged');
  assert.match(internalsSource, /\.\.\.\(badge \? \{ badge \} : \{\}\)/, 'messages must carry the badge');
  assert.match(store, /\.\.\.\(badge \? \{ badge \} : \{\}\)/, 'the badge must survive persistence');
  assert.match(rendererSource, /className = 'agent-message-badge'/);
  assert.match(rendererSource, /options\.badge/, 'renderChatMessage must render the badge');
  // And the CSS must actually style it.
  assert.match(read('desktop/renderer/chat-reference.css'), /\.agent-message-badge \{/);
});

test('subagent traffic in the live feed is badged', () => {
  const source = renderer();
  assert.match(source, /renderChatMessage\('agent-message', header, String\(event\.text \|\| ''\),\s*\n\s*null, \{ badge: fromLabel\.startsWith\('subagent '\) \? 'subagent' : 'agent' \}\)/,
    'a subagent message must be badged so it is distinguishable from the agent voice');
});

test('a badged card always shows its header, so the badge is actually visible', () => {
  const source = renderer();
  const css = read('desktop/renderer/chat-reference.css');
  // The generic "You"/"Thought" labels are hidden by CSS. A badged card that
  // kept its header hidden would show no badge at all — the one thing that
  // says who wrote it.
  assert.match(css, /\.agent-message\.is-user header, \.agent-message\.is-assistant header \{ display: none; \}/,
    'the hiding rule must still exist (this test guards the override)');
  assert.match(css, /\.agent-message\.has-badge header \{ display: flex; \}/,
    'a badged card must show its header');
  assert.match(source, /item\.classList\.add\('has-badge'\)/,
    'a badged card must be marked so the override applies');
});

test('a badged message replaces the generic label instead of doubling it', () => {
  const source = renderer();
  // "Agent message · research" reads as two producers; the badge IS the
  // producer name, so it replaces the label.
  assert.match(source, /label\.textContent = '';\s*\n\s*label\.append\(badge\);/,
    'the badge must replace the generic label');
});

test('a badged runtime message is visible in the transcript replay', () => {
  const source = renderer();
  // Runtime messages are model-facing context and stay hidden — except the
  // badged ones (research briefs, subagent findings), which the user asked
  // to be able to tell apart.
  assert.match(source, /if \(entry\.value\.source === 'runtime' && !entry\.value\.badge\) continue;/,
    'only badged runtime messages may render');
});

test('a research brief is published with a badge and a user-facing body', () => {
  const source = agent();
  assert.match(source, /appendConversationMessage\(run, 'user', content, \{ source: 'runtime', badge: 'research', displayContent: findings \}\)/,
    'the research brief must be badged and carry a user-facing body');
  assert.match(source, /badge: 'research', content: findings/,
    'the delivered event must carry the badge and a user-facing body');
});

test('a badged message keeps its model-facing text separate from the user body', () => {
  // DSH file split: normalizeConversationMessage owns the display-body
  // plumbing, so this assertion reads agentInternals.cjs.
  const source = read('desktop/agent/agentInternals.cjs');
  const store = read('desktop/store/chatHistoryStore.cjs');
  // The research brief's content is addressed to the MODEL ("advisory
  // context — do not acknowledge it"). Showing that on a user-facing card
  // would leak instructions aimed at the model into the transcript.
  assert.match(source, /const displayContent = String\(value\?\.displayContent \?\? ''\)/,
    'the message must carry a separate display body');
  assert.match(store, /const displayContent = clean\(message\?\.displayContent, 8_000\)/,
    'the display body must survive persistence');
  assert.match(renderer(), /entry\.value\.displayContent \|\| entry\.value\.content/,
    'the transcript must prefer the display body');
});
