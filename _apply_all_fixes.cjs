const fs = require('fs');

// === FIX 1: Rewrite Section 9 of agent card ===
const agentCard = 'src/mcp/prompts/browser-use-agent-card.md';
let ac = fs.readFileSync(agentCard, 'utf8');

const oldSection9 = `## 9. Operational loop

For every task, repeat:

1. `browser.listTabs` > `browser.selectTab(id)` > `browser.info`.
2. `browser.screenshot` + `browser.domSnapshot`.
3. Identify the target element or coordinate from the snapshot/screenshot.
4. Use `browser.clickSelector`, `browser.click_element`, or `browser.mousemove` + `browser.mousedown` + `browser.mouseup`.
5. Verify with another screenshot or `browser.assertVisible` / `browser.assertText`.
6. On error, release pointer with `browser.mouseup`, then re-read state from step 2.

Do not batch actions. Wait for each MCP result before issuing the next tool call.`;

const newSection9 = `## 9. Operational loop

Before acting, plan the full sequence of steps needed to complete the user's request. Then execute multiple dependent actions in a single turn without stopping to replan between each one. Only pause at logical supervision checkpoints.

### Critical: Action over thought

You MUST issue a tool call after every planning pass. Never emit more than one planning/reasoning turn without a concrete tool call. If you find yourself thinking "I need to plan" or "let me re-evaluate", stop and issue the next action immediately.

Thinking loops are forbidden. Each turn must produce exactly one tool call or one final response. If you have a plan, execute its next step now.

1. Plan the full sequence upfront. Before issuing any tool calls, identify all steps needed (e.g., navigate, wait for load, click input, type text, click submit, verify result). Hold this plan in context.

2. Execute dependent actions consecutively. After each successful action, immediately issue the next planned tool call. Do not stop to re-evaluate the plan unless an action fails or produces an unexpected result.

3. Supervision checkpoints. Pause and re-read page state only at these boundaries:
   - After a navigation completes (URL changed or page loaded)
   - After a form submission or button click that triggers a page transition
   - When an action returns an error or unexpected state
   - After completing the entire planned sequence (final verification)

4. On error, recover and continue. If an action failr, release any held pointer state with `browser.mouseup`, take a screenshot to assess the current state, adjust the remaining plan, and continue executing. Do not restart from scratch.

5. Read before first action, not between every action. Take a screenshot and DOM snapshot at the start of a sequence and at supervision checkpoints. Between consecutive actions within a batch (e.g., click, type, click), proceed directly without intermediate reads unless the prior action's result is uncertain.

**Example: login flow**

Instead of: screenshot, plan click username, execute, screenshot, plan type username, execute, screenshot, plan click password, ...

Do: screenshot + domSnapshot, plan [click username field, type username, click password field, type password, click login button, verify dashboard], execute click username, execute type username, execute click password, execute type password, execute click login, checkpoint: screenshot to verify login succeeded.`

if (ac.includes(oldSection9)) {
  ac = ac.replace(oldSection9, newSection9);
  fs.writeFileSync(agentCard, ac, 'utf8');
  console.log('FIX 1: Section 9 rewritten with anti-thinking-loop guard');
} else {
  console.log('FIX 1: SKIPPED - old Section 9 not found');
}

// === FIX 2: HTML file preview routing in desktop renderer ===
const appJs = 'desktop/renderer/app.js';
let ac = fs.readFileSync(appJs, 'utf8');

const oldPreview = `    } else {
      chip.append(label);
    }`

const newPreview = `    } else if (attachment.path && /\\.(html?|txt|md|csv|json|xml|svg)$/i.test(attachment.name)) {
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';
      preview.setAttribute('aria-label', 'Open ' + attachment.name);
      preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));
      chip.append(label, preview);
    } else {
      chip.append(label);
    }`;

if (ac.includes(oldPreview)) {
  ac = ac.replace(oldPreview, newPreview);
  fs.writeFileSync(appJs, ac, 'utf8');
  console.log('FIX 2: HTML file preview routing added');
} else {
  console.log('FIX 2: SKIPPED - old preview code not found');
}

console.log('All fixes applied.');
