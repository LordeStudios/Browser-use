import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, '_patch_html_preview.cjs');
const source = path.join(repo, 'desktop', 'renderer', 'app.js');

async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

test('HTML attachment preview patch is idempotent and repairs duplicate branches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-preview-patch-'));
  const targetDir = path.join(root, 'desktop', 'renderer');
  await fs.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, 'app.js');
  const patchedScript = path.join(root, '_patch_html_preview.cjs');
  const current = await fs.readFile(source, 'utf8');
  const duplicate = current.replace(
    /    } else \{\n      chip\.append\(label\);\n    \}/,
    `      } else if (attachment.path && /\\.(html?|txt|md|csv|json|xml|svg)$/i.test(attachment.name)) {\n        const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';\n        preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));\n        chip.append(label, preview);\n    } else {\n      chip.append(label);\n    }`
  );
  await Promise.all([
    fs.writeFile(target, duplicate),
    fs.copyFile(script, patchedScript)
  ]);

  try {
    const first = await exec(process.execPath, [patchedScript], { cwd: root });
    assert.match(first.stdout, /PATCHED OK/);
    const afterFirst = await sha256(target);
    const second = await exec(process.execPath, [patchedScript], { cwd: root });
    assert.match(second.stdout, /ALREADY PATCHED/);
    assert.equal(await sha256(target), afterFirst, 'a second run must not mutate the file');
    const repaired = await fs.readFile(target, 'utf8');
    assert.equal((repaired.match(/attachment\.path &&/g) || []).length, 1);
    assert.equal((repaired.match(/openReportPreview\(\{ path: attachment\.path \}\)/g) || []).length, 0);
    await exec(process.execPath, ['--check', target]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
