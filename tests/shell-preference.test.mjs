// Shell preference: PowerShell 7 (pwsh) preferred on Windows with the 5.1
// built-in as fallback, and agent-owned interactive terminal sessions that
// the docked panel can watch without stealing input from the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveWindowsShell } = require('../desktop/terminal/shellPreference.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

test('pwsh wins when installed; the 5.1 built-in is the fallback', () => {
  assert.equal(resolveWindowsShell(() => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  delete process.env.COMSPEC;
  assert.equal(resolveWindowsShell(() => ''), 'powershell.exe');
  process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe';
  assert.equal(resolveWindowsShell(() => ''), 'powershell.exe', 'a non-PowerShell COMSPEC must not be used');
  process.env.COMSPEC = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(resolveWindowsShell(() => ''), process.env.COMSPEC, 'COMSPEC is honored when it points at PowerShell');
  delete process.env.COMSPEC;
});

test('agent-owned terminal sessions are watchable and releasable', async () => {
  const created = [];
  const sessions = new Map();
  const tools = new ComputerTools({
    terminal: {
      backend: 'pty',
      backendInfo: () => 'pty',
      async create(options) {
        const session = { id: `sess-${created.length + 1}`, history: 'PS C:\\> ', alive: true, phase: 'ready', profile: options.profile || 'shell', credentialSource: options.profile === 'claude-code' ? 'api-key' : 'none' };
        created.push(options); sessions.set(session.id, session); return session;
      },
      async dispose(id) { sessions.delete(id); return true; },
      async writeInput() { return true; },
      snapshot(id) { return sessions.get(id) || null; }
    }
  });
  // The agent opens an owned Claude Code PTY session.
  const opened = await tools.execute('computer_terminal', { action: 'open', command: 'claude' }, 'chat:run-1');
  assert.equal(tools.isAgentOwned(opened.sessionId), true);
  assert.equal(tools.agentSessionOwner(opened.sessionId), 'chat:run-1');
  // Another owner cannot touch the agent's session.
  await assert.rejects(tools.execute('computer_terminal', { action: 'input', sessionId: opened.sessionId, text: 'dir\n' }, 'chat:run-2'), /Unknown owned terminal session/);
  // A completed turn releases the UI write lock elsewhere but retains the
  // stable conversation capability for the next continuation turn.
  assert.equal(tools.retainedAgentSessions('chat:run-1'), 1);
  assert.equal(tools.isAgentOwned(opened.sessionId), true);
  const listed = await tools.execute('computer_terminal', { action: 'list' }, 'chat:run-1');
  assert.deepEqual(listed.sessions.map((session) => session.sessionId), [opened.sessionId]);
  const reused = await tools.execute('computer_terminal', { action: 'open', command: 'claude' }, 'chat:run-1');
  assert.equal(reused.sessionId, opened.sessionId);
  assert.equal(reused.reused, true);
  assert.equal(created.length, 1, 'continuation must not open another Claude process');
  await tools.releaseOwner('chat:run-1');
  assert.deepEqual(tools.agentOwnedSessions(), []);
});
