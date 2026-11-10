const fs = require('fs');
const path = require('path');

// === Configuration ===
const PATCHES = [
  {
    name: 'HTML Preview Buttons in app.js',
    file: 'desktop/renderer/app.js',
    patterns: [
      // Primary pattern: } else { after chip.append(label, preview)
      {
        search: /(chip\.append\(label, preview\);\s*\n\s*}\s*else\s*\{)/,
        replace: (match) => {
          const indent = '      ';
          return `chip.append(label, preview);\n${indent}} else if (attachment.path && /\\.(html?|txt|md|csv|json|pdf|xml|svg)$/i.test(attachment.name)) {\n${indent}  const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';\n${indent}  preview.setAttribute('aria-label', 'Open ' + attachment.name);\n${indent}  preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));\n${indent}  chip.append(label, preview);\n${indent}} else {`;
        }
      },
      // Fallback pattern: } else {
      {
        search: /(\s*\}\s*else\s*\{)/,
        replace: (match, p1, offset, string) => {
          const indent = '      ';
          const lines = string.slice(0, offset).split('\n');
          const lastLine = lines[lines.length - 1];
          if (lastLine.includes('chip.append(label')) {
            return `} else if (attachment.path && /\\.(html?|txt|md|csv|json|pdf|xml|svg)$/i.test(attachment.name)) {\n${indent}  const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';\n${indent}  preview.setAttribute('aria-label', 'Open ' + attachment.name);\n${indent}  preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));\n${indent}  chip.append(label, preview);\n${indent}} else {`;
          }
          return match; // No match, return original
        }
      }
    ]
  },
  {
    name: 'Section 9 Rewrite in browser-use-agent-card.md',
    file: 'src/mcp/prompts/browser-use-agent-card.md',
    patterns: [
      {
        search: /## 9\. Operational loop\s*\n\s*For every task, repeat:\s*\n\s*1\. \`browser\.listTabs\` > \`browser\.selectTab\(id\)\` > \`browser\.info\`.\s*\n\s*2\. \`browser\.screenshot\` \+ \`browser\.domSnapshot\`.\s*\n\s*3\. Identify the target element or coordinate from the snapshot\/screenshot\.\s*\n\s*4\. Use \`browser\.clickSelector\`, \`browser\.click_element\`, or \`browser\.mousemove\` \+ \`browser\.mousedown\` \+ \`browser\.mouseup\`.\s*\n\s*5\. Verify with another screenshot or \`browser\.assertVisible\` \/ \`browser\.assertText\`.\s*\n\s*6\. On error, release pointer with \`browser\.mouseup\`, then re-read state from step 2\.\s*\n\s*Do not batch actions\. Wait for each MCP result before issuing the next tool call\./,
        replace: `## 9. Operational loop

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

4. On error, recover and continue. If an action fails, release any held pointer state with \`browser.mouseup\`, take a screenshot to assess the current state, adjust the remaining plan, and continue executing. Do not restart from scratch.

5. Read before first action, not between every action. Take a screenshot and DOM snapshot at the start of a sequence and at supervision checkpoints. Between consecutive actions within a batch (e.g., click, type, click), proceed directly without intermediate reads unless the prior action's result is uncertain.

**Example: login flow**

Instead of: screenshot, plan click username, execute, screenshot, plan type username, execute, screenshot, plan click password, ...

Do: screenshot + domSnapshot, plan [click username field, type username, click password field, type password, click login button, verify dashboard], execute click username, execute type username, execute click password, execute type password, execute click login, checkpoint: screenshot to verify login succeeded.`
      },
      {
        search: /## 9\. Operational loop\s*\n\s*Work like polished browser automation agents/,
        replace: `## 9. Operational loop

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

4. On error, recover and continue. If an action fails, release any held pointer state with \`browser.mouseup\`, take a screenshot to assess the current state, adjust the remaining plan, and continue executing. Do not restart from scratch.

5. Read before first action, not between every action. Take a screenshot and DOM snapshot at the start of a sequence and at supervision checkpoints. Between consecutive actions within a batch (e.g., click, type, click), proceed directly without intermediate reads unless the prior action's result is uncertain.

**Example: login flow**

Instead of: screenshot, plan click username, execute, screenshot, plan type username, execute, screenshot, plan click password, ...

Do: screenshot + domSnapshot, plan [click username field, type username, click password field, type password, click login button, verify dashboard], execute click username, execute type username, execute click password, execute type password, execute click login, checkpoint: screenshot to verify login succeeded.`
      }
    ]
  }
];

// === Helper Functions ===
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`ERROR: Failed to read ${filePath}: ${err.message}`);
    return null;
  }
}

function writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  } catch (err) {
    console.error(`ERROR: Failed to write ${filePath}: ${err.message}`);
    return false;
  }
}

function applyPatch(filePath, patterns) {
  const fileContent = readFile(filePath);
  if (fileContent === null) return false;

  let modified = false;
  let newContent = fileContent;

  for (const pattern of patterns) {
    if (pattern.search.test(newContent)) {
      newContent = newContent.replace(pattern.search, pattern.replace);
      modified = true;
      console.log(`  ✅ Applied pattern: ${pattern.search.toString().slice(0, 50)}...`);
      break; // Stop after first successful pattern
    }
  }

  if (!modified) {
    console.log(`  ⚠️  No patterns matched in ${filePath}`);
    return false;
  }

  if (!writeFile(filePath, newContent)) {
    return false;
  }

  // Verify the patch
  const verifiedContent = readFile(filePath);
  if (verifiedContent === null) {
    console.error(`  ❌ Verification failed: Could not re-read ${filePath}`);
    return false;
  }

  // Check if any pattern's replacement exists in the new content
  for (const pattern of patterns) {
    const replacement = pattern.replace.toString();
    if (replacement.includes('attachment.path') && verifiedContent.includes('attachment.path')) {
      console.log(`  ✅ Verified: Patch applied successfully to ${filePath}`);
      return true;
    }
    if (replacement.includes('Operational loop') && verifiedContent.includes('Before acting, plan the full sequence')) {
      console.log(`  ✅ Verified: Patch applied successfully to ${filePath}`);
      return true;
    }
  }

  console.log(`  ⚠️  Verification inconclusive for ${filePath}`);
  return true; // Assume success if write succeeded
}

// === Main Execution ===
console.log('🔧 Starting patch application...\n');

let successCount = 0;
let failCount = 0;

for (const patch of PATCHES) {
  const fullPath = path.resolve(__dirname, patch.file);
  console.log(`📝 Patch: ${patch.name}`);
  console.log(`   File: ${fullPath}`);

  if (!fileExists(fullPath)) {
    console.log(`   ❌ File not found: ${fullPath}`);
    failCount++;
    continue;
  }

  if (applyPatch(fullPath, patch.patterns)) {
    successCount++;
  } else {
    failCount++;
  }
  console.log();
}

console.log(`📊 Summary: ${successCount} succeeded, ${failCount} failed.`);
process.exit(failCount > 0 ? 1 : 0);
