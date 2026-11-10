import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// run.txt 2026-10-30 19:45: the user asked for twelve things and began with
// "start with creating a plan". No plan pill ever appeared and most of the
// instructions were never touched. Cause, in order:
//   1. create_plan's wire schema typed `steps` as a NUMBER and `operations` as a
//      STRING (the generated schema reused a numeric-name list meant for
//      browser_drag), so the model sent `steps: 5`.
//   2. The harness then answered {ok:true, steps:0, created:true} even though the
//      plan had been rejected, so the model believed it had a plan.
//   3. With no plan items, the done-gate had nothing to check.
//   4. The design skill was cut at 6,000 of 9,074 characters, so its quality-check
//      sections never reached the model.

const { applyProgressUpdate } = require('../desktop/agent/progressState.cjs');
const { toolInputSchema } = require('../desktop/agent/providers/wire.cjs');
const { SkillsManager, BODY_CAP } = require('../desktop/agent/skillsManager.cjs');
const { DesktopChatAgent, isMultipartTask } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

test('create_plan is typed exactly like update_plan on the wire', () => {
  const create = toolInputSchema({ goals: 'goals', steps: 'x', operations: 'y' }, 'create_plan');
  const update = toolInputSchema({}, 'update_plan');
  assert.equal(create.properties.steps.type, 'array', 'steps must be an array, not a number');
  assert.equal(create.properties.operations.type, 'array', 'operations must be an array, not a string');
  assert.deepEqual(create, update, 'the two plan tools take the same arguments and must share one schema');
});

test('the exact payload from run.txt now produces a plan instead of an empty success', () => {
  const payload = {
    goals: 'Upgrade the homepage into a polished light theme.',
    steps: 5,
    operations: JSON.stringify([
      { op: 'add', id: 'inspect', text: 'Inspect the homepage source', status: 'current', verification: 'Locations identified' },
      { op: 'add', id: 'weather', text: 'Replace the weather SVG', status: 'pending' }
    ])
  };
  const result = applyProgressUpdate([], [], payload);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.plan.length, 2);
  assert.equal(result.goals.length, 1, 'a single goal sentence is a goal list of one');
});

test('a plan sent as a numbered text block or a JSON string is accepted', () => {
  assert.equal(applyProgressUpdate([], [], { steps: '1. inspect\n2. patch\n3. verify' }).plan.length, 3);
  assert.equal(applyProgressUpdate([], [], { steps: JSON.stringify(['a', 'b']) }).plan.length, 2);
});

test('input that is genuinely not a plan is still rejected', () => {
  assert.equal(applyProgressUpdate([], [], { steps: 5 }).ok, false, 'a bare number is a task count, not a plan');
  assert.equal(applyProgressUpdate([], [], { steps: 'do the thing' }).ok, false, 'one line of prose is not a plan');
  assert.equal(applyProgressUpdate([], [], { operations: [{ op: 'weather', text: 'x' }] }).ok, false, 'an unknown op is rejected');
});

async function runCreatePlan(input) {
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const events = [];
  let turn = 0;
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: (event) => events.push(event),
    createProvider: () => ({ complete: async () => {
      turn += 1;
      if (turn === 1) return { actions: [{ name: 'create_plan', input }] };
      return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
    } }) });
  try {
    const run = await agent.start({ task: 'plan then work', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
    return { run, events, call: (run.history || []).find((entry) => entry.tool === 'create_plan') };
  } finally { await backend.close(); }
}

test('a rejected create_plan tells the model it failed and draws no pill', async () => {
  const { call, events } = await runCreatePlan({ goals: 'g', steps: 5 });
  assert.equal(call.output.ok, false, 'the model must NOT be told it succeeded');
  assert.match(call.output.error, /NOT created/);
  assert.equal(events.filter((event) => event.type === 'plan.updated').length, 0);
});

test('a valid create_plan stores the plan and publishes the pill event', async () => {
  const { run, call, events } = await runCreatePlan({ goals: 'ship the redesign', steps: [{ id: 'a', text: 'inspect' }, { id: 'b', text: 'patch' }] });
  assert.equal(call.output.ok, true);
  assert.equal(call.output.result.tasks, 2, 'the result must report the real task count, not zero');
  assert.equal(run.plan.length >= 1, true);
  assert.ok(events.some((event) => event.type === 'plan.updated' && event.plan.length === 2), 'the plan pill needs a plan.updated event');
  assert.ok(events.some((event) => event.type === 'plan.updated' && event.goals.length === 1), 'and the goal pill needs its goal');
});

const RUN_TXT_MESSAGE = 'Youfind where the index.html div_3_div_1_svg_1 i want this to a real weather standard icon not custom drawn svg, weather_card this card to feature a real branding + background that animates without any cuts ie animates in realtime from night to day to rainy to sunny (day/night) weather system should be very accurate and realtime. reorganize the card to feature the a weather timeline from 5hr for upto 12hrs from current time, to show the real time based on device timezone. everything should be very organized (use design skill) .thes cards should feature the official logos instead of dots search_with_google search_with_bing search_with_duck_duck_go html_1_body_1_div_4 no em dashes div_5_div_2_div_2 this is space wastage div_2_div_1_div_1 div_2_div_1_img_1 (should pull real posts from lordemaximus.com lorde_maximus_studios (should use real favicon/icon of studios.lordemaximus.com)) also leaving the page dark theme feels so empty and ugly use a light them + dark div_1_a_1_svg_1 its browser use by LordeStudios not lorde browser also fix the icon. start with creating a plan';

test('a long list of separate requests counts as multi-part work, with no sequence words', () => {
  // The old detector only knew "and then" / "audit ... fix", so this message —
  // twelve requests in plain prose — never armed the plan prompt, the
  // plan-missing flow check, or the forced completion review.
  assert.equal(isMultipartTask(RUN_TXT_MESSAGE), true);
  assert.equal(isMultipartTask('please start with creating a plan and then fix it'), true);
  assert.equal(isMultipartTask('make a plan first'), true, 'an explicit request for a plan is always multi-part');
});

test('short chat messages are never treated as multi-part work', () => {
  // The cost of a false positive is a plan prompt on a one-line question, so
  // the detector must stay quiet on everything a person says in passing.
  for (const message of ['hello', 'fix that', 'continue', 'how many skills do have', 'test and see if the profile really appears in the programs', 'dont disturb me again', 'what is the weather today']) {
    assert.equal(isMultipartTask(message), false, `"${message}" must not be multi-part`);
  }
});

async function runDeclaringDoneEarly(task, doneInput = {}) {
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => ({ actions: [{ name: 'browser_done', input: { summary: 'The homepage is done.', success: true, verified: true, ...doneInput } }] }) }) });
  try {
    const run = await Promise.race([agent.start({ task, settings: { approvalMode: 'unattended', controlMode: 'agi' } }), new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
    return (run?.history || []).filter((entry) => entry.tool === 'browser_done');
  } finally { await backend.close(); }
}

async function runWithPlan(task, actions) {
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  let turn = 0;
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => ({ actions: [actions[Math.min(turn++, actions.length - 1)]] }) }) });
  try {
    const run = await Promise.race([agent.start({ task, settings: { approvalMode: 'unattended', controlMode: 'agi' } }), new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
    return (run?.history || []).filter((entry) => entry.tool === 'browser_done');
  } finally { await backend.close(); }
}

test('a multi-ask message cannot be closed on the first done, and the bounce quotes every ask', async () => {
  const dones = await runDeclaringDoneEarly(RUN_TXT_MESSAGE);
  assert.ok(dones.length >= 2, 'the first done must be bounced so the model gets a chance to account for each ask');
  assert.equal(dones[0].output.ok, false);
  // The accounting gate fires first: a summary that names no instruction is
  // the run.txt ending, and it must not be accepted.
  assert.equal(dones[0].output.recoverySource, 'done_uncovered_instructions');
  const demand = dones[0].output.error;
  // Quoted from the request as it was actually written. "light them" is the
  // user's own spelling, and the bounce must carry the request VERBATIM —
  // a corrected spelling would be a different text than the one the model
  // was asked to follow.
  for (const ask of ['official logos', 'no em dashes', 'real posts', 'LordeStudios', 'light them', 'start with creating a plan']) {
    assert.ok(demand.includes(ask), `the bounce does not carry the ask "${ask}", so the model can still skip it`);
  }
  assert.match(demand, /DONE:/);
  assert.match(demand, /SKIPPED:/);
});

test('a summary that accounts for every instruction passes the accounting gate', async () => {
  // The request holds about twenty instructions (eleven verbs and eleven
  // pasted element ids), so a complete account is twenty lines.
  const lines = Array.from({ length: 20 }, (_, i) => `DONE: instruction ${i + 1} of the request was carried out`);
  const dones = await runDeclaringDoneEarly(RUN_TXT_MESSAGE, { summary: lines.join('\n') });
  const gated = dones.filter((entry) => entry.output.recoverySource === 'done_uncovered_instructions');
  assert.equal(gated.length, 0, 'a complete account must not be rejected for being incomplete');
});

test('a summary that accounts for only part of the request is rejected', async () => {
  const dones = await runDeclaringDoneEarly(RUN_TXT_MESSAGE, { summary: 'DONE: the weather icon was replaced' });
  const gated = dones.filter((entry) => entry.output.recoverySource === 'done_uncovered_instructions');
  assert.ok(gated.length >= 1, 'a partial account must be rejected');
  assert.match(gated[0].output.error, /accounts for 1 instruction/);
});

test('a comma-separated list of requests is caught, not just a list of sentences', async () => {
  // A list written as ONE sentence is ONE clause, so the clause count missed
  // it — and that is exactly how the 2026-10-30 request was written.
  const dones = await runDeclaringDoneEarly('fix the icon, change the theme, add a favicon, remove the dots');
  const gated = dones.filter((entry) => entry.output.recoverySource === 'done_uncovered_instructions');
  assert.ok(gated.length >= 1, 'a one-sentence list of requests must still be accounted for');
});

test('one bounce carries one demand: the accounting and the plan gates do not speak over each other', async () => {
  // A run with an open plan AND a missing accounting must be told about ONE
  // thing at a time. When both gates fired at once, the second overwrote the
  // first's message while both counters advanced, so the model was told to
  // close plan items while its accounting was still missing.
  const dones = await runWithPlan(RUN_TXT_MESSAGE, [
    { name: 'create_plan', input: { goals: ['redesign the homepage'], steps: ['weather icon', 'light theme'] } },
    { name: 'browser_done', input: { summary: 'The homepage is done.', success: true, verified: true } }
  ]);
  const first = dones[0];
  assert.equal(first.output.ok, false);
  assert.equal(first.output.recoverySource, 'done_uncovered_instructions', 'the accounting demand comes first');
  assert.doesNotMatch(first.output.error, /Plan items open/, 'the two demands must not be merged into one message');
  // The accounting demand carries the request, so the model can comply.
  assert.match(first.output.error, /The user's request, verbatim/);
});

test('a one-line message gets no checklist and the unchanged review text', async () => {
  const dones = await runDeclaringDoneEarly('what is two plus two');
  for (const entry of dones.filter((item) => item.output.recoverySource === 'completion_review')) {
    assert.doesNotMatch(entry.output.error, /The user's request, verbatim/);
  }
});

test('the whole design skill reaches the model, including its quality-check sections', () => {
  const claudeDir = path.resolve(import.meta.dirname, '..', '.claude', 'skills');
  const manager = new SkillsManager({ userDir: path.join(os.tmpdir(), 'bu-no-user-skills'), claudeDir });
  const skill = manager.get('inst-claude-frontend-design');
  assert.ok(skill, 'the .claude/skills folder must be discovered');
  const served = skill.steps[0].detail;
  const onDisk = fs.readFileSync(path.join(claudeDir, 'frontend-design', 'SKILL.md'), 'utf8');
  assert.ok(onDisk.length - onDisk.indexOf('\n---', 3) > 6000, 'this skill is longer than the old 6,000-character cap');
  for (const heading of ['## Restraint and self-critique', '## More on writing in design']) {
    assert.ok(served.includes(heading), `${heading} was cut off and never reached the model`);
  }
});

test('an over-long skill is cut at a section boundary with a notice, never mid-word', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-big-skill-'));
  const dir = path.join(root, 'huge');
  fs.mkdirSync(dir, { recursive: true });
  const sections = Array.from({ length: 8 }, (_, index) => `## Section ${index}\n${'rule text '.repeat(260)}`).join('\n\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: huge\ndescription: a very long skill\n---\n\n${sections}\n`);
  const served = new SkillsManager({ userDir: root }).get('inst-user-huge').steps[0].detail;
  assert.ok(served.length <= BODY_CAP + 400, 'the cap still bounds the result');
  assert.match(served, /\[Skill shortened: \d+ of \d+ characters omitted at a section boundary/);
  assert.doesNotMatch(served.replace(/\[Skill shortened[\s\S]*$/, ''), /rule te?x?t?$/, 'it must not stop in the middle of a sentence');
  const beforeNotice = served.slice(0, served.indexOf('[Skill shortened'));
  assert.ok(/rule text\s*$/.test(beforeNotice), 'the cut lands after a complete section');
});

test('the instruction floor counts the things the user pointed at, not only the verbs', async () => {
  // The request names eleven pasted element ids (weather_card,
  // search_with_google, div_3_div_1_svg_1, ...) and uses about ten verbs.
  // Counting only the verbs said this request held eleven instructions when
  // it holds about twenty, and an agent that wrote eleven lines and skipped
  // the other nine passed the gate.
  const lines = Array.from({ length: 11 }, (_, i) => `DONE: instruction ${i + 1} of the request was carried out`);
  const dones = await runDeclaringDoneEarly(RUN_TXT_MESSAGE, { summary: lines.join('\n') });
  const gated = dones.filter((entry) => entry.output.recoverySource === 'done_uncovered_instructions');
  assert.ok(gated.length >= 1, 'eleven lines must not satisfy a request that holds about twenty instructions');
  assert.match(gated[0].output.error, /about 20 instructions/);
});
