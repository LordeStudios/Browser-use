import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM_DIRECTORY = '.upstream-browser-use';

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

export function resolveUpstreamRuntime({ toolRoot, sourceDir = process.env.BROWSER_USE_UPSTREAM_DIR, uv = process.env.BROWSER_USE_UPSTREAM_UV, exists = fs.existsSync } = {}) {
  if (!toolRoot) throw new Error('toolRoot is required to resolve the upstream Browser Use runtime');

  const resolvedSourceDir = sourceDir || path.join(toolRoot, UPSTREAM_DIRECTORY);
  const manifest = path.join(resolvedSourceDir, 'pyproject.toml');
  if (!exists(manifest)) {
    throw new Error(`Upstream Browser Use source is unavailable at ${resolvedSourceDir}. Expected ${manifest}.`);
  }

  return {
    sourceDir: normalizePath(resolvedSourceDir),
    uv: uv || 'uv'
  };
}

export function buildUpstreamCommand({ sourceDir, uv = 'uv', mode = 'agent' }) {
  if (!sourceDir) throw new Error('sourceDir is required to build the upstream Browser Use command');
  if (!['agent', 'cli'].includes(mode)) throw new Error(`Unsupported upstream Browser Use mode: ${mode}`);

  return {
    command: uv,
    args: ['run', '--directory', sourceDir, 'browser-use', mode === 'agent' ? '--mcp' : '--cli-mcp']
  };
}
