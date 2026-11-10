import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { foregroundTabPermission, foregroundTabBlockReason } = require('../desktop/agent/tabFocusPolicy.cjs');

function liveAgent(id, ownedTabIds = [], agentIdentity = 'agent1') {
  return { state: () => ({ id, status: 'running', ownedTabIds, agentIdentity }) };
}
function idleAgent(id, ownedTabIds = []) {
  return { state: () => ({ id, status: 'completed', ownedTabIds }) };
}

test('the sole live agent may foreground a tab', () => {
  const permission = foregroundTabPermission([liveAgent('run-1', ['tab-9'])], 'run-1');
  assert.deepEqual(permission, { allowed: true });
  assert.equal(foregroundTabBlockReason(permission), null);
});

test('foregrounding is refused while another live agent owns tabs', () => {
  const permission = foregroundTabPermission([liveAgent('run-1', []), liveAgent('run-2', ['tab-7'], 'agent2')], 'run-1');
  assert.equal(permission.allowed, false);
  assert.deepEqual(permission.owners, ['agent2']);
  assert.match(foregroundTabBlockReason(permission), /another agent owns tabs \(agent2\)/);
});

test('idle or completed agents never block a foreground switch', () => {
  const permission = foregroundTabPermission([liveAgent('run-1', []), idleAgent('run-2', ['tab-7'])], 'run-1');
  assert.deepEqual(permission, { allowed: true });
});

test('live agents that own no tabs do not block either', () => {
  const permission = foregroundTabPermission([liveAgent('run-1', []), liveAgent('run-2', [])], 'run-1');
  assert.deepEqual(permission, { allowed: true });
});
