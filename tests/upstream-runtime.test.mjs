import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUpstreamCommand, resolveUpstreamRuntime } from '../src/upstream/runtime.js';

test('uses the checked-in upstream Browser Use source by default', () => {
  const runtime = resolveUpstreamRuntime({
    toolRoot: 'E:/uganda-art-pulse/tools/browser-use',
    exists: (candidate) => candidate.endsWith('pyproject.toml')
  });

  assert.equal(runtime.sourceDir, 'E:/uganda-art-pulse/tools/browser-use/.upstream-browser-use');
  assert.equal(runtime.uv, 'uv');
});

test('builds the official upstream MCP launch command', () => {
  const command = buildUpstreamCommand({
    sourceDir: 'E:/uganda-art-pulse/tools/browser-use/.upstream-browser-use',
    uv: 'uv',
    mode: 'agent'
  });

  assert.equal(command.command, 'uv');
  assert.deepEqual(command.args, [
    'run',
    '--directory',
    'E:/uganda-art-pulse/tools/browser-use/.upstream-browser-use',
    'browser-use',
    '--mcp'
  ]);
});

test('builds the official upstream CLI MCP launch command', () => {
  const command = buildUpstreamCommand({
    sourceDir: 'E:/uganda-art-pulse/tools/browser-use/.upstream-browser-use',
    uv: 'uv',
    mode: 'cli'
  });

  assert.deepEqual(command.args.slice(-2), ['browser-use', '--cli-mcp']);
});

test('fails closed when the upstream source is absent', () => {
  assert.throws(
    () => resolveUpstreamRuntime({
      toolRoot: 'E:/uganda-art-pulse/tools/browser-use',
      exists: () => false
    }),
    /Upstream Browser Use source is unavailable/
  );
});

test('rejects unsupported upstream modes', () => {
  assert.throws(
    () => buildUpstreamCommand({ sourceDir: 'E:/uganda-art-pulse/tools/browser-use/.upstream-browser-use', mode: 'unknown' }),
    /Unsupported upstream Browser Use mode/
  );
});
