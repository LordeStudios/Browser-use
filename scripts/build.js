import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimeFiles = [
  'src/index.js', 'src/config.js', 'src/replay.js', 'src/seaBootstrap.cjs',
  'src/upstream/runtime.js', 'scripts/run-upstream-browser-use.mjs',
  'src/browser/browserPool.js', 'src/browser/cdpClient.js', 'src/browser/chromeLauncher.js',
  'src/browser/diagnostics.js', 'src/browser/domSnapshot.js',
  'src/browser/input.js', 'src/browser/nativePointer.js', 'src/browser/screenshot.js',
  'src/ui/controlCenter.js',
  'src/mcp/mcpAdapter.js', 'src/mcp/mcpServer.js',
  'src/ollama/agentLoop.js', 'src/ollama/commandParser.js', 'src/ollama/ollamaClient.js', 'src/ollama/promptBuilder.js',
  'src/server/eventBus.js', 'src/server/websocketServer.js',
  'src/tools/browserTools.js', 'src/tools/permissions.js', 'src/tools/toolExecutor.js', 'src/tools/toolRegistry.js', 'src/tools/verification.js'
];
const dependencies = ['chrome-remote-interface', 'ws'];

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  if (!fs.existsSync(source)) throw new Error(`Required build file missing: ${relativePath}`);
  const destination = path.join(output, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

const requestedOutput = process.env.BROWSER_USE_BUILD_OUTPUT;
const output = requestedOutput ? path.resolve(root, requestedOutput) : path.join(root, 'release', `browser-use-${packageInfo.version}`);
if (fs.existsSync(output)) {
  throw new Error(`Release already exists and will not be overwritten: ${output}`);
}
fs.mkdirSync(output, { recursive: true });
runtimeFiles.forEach(copyFile);
['README.md', 'repo-map.md', 'browser-use_flow_chat.md', 'implementation_plan.md', 'sea-config.release.json'].forEach((file) => copyFile(file));

const upstreamSource = path.join(root, '.upstream-browser-use');
if (fs.existsSync(path.join(upstreamSource, 'pyproject.toml'))) {
  fs.cpSync(upstreamSource, path.join(output, '.upstream-browser-use'), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`)
  });
}

for (const dependency of dependencies) {
  const source = path.join(root, 'node_modules', dependency);
  if (!fs.existsSync(source)) throw new Error(`Required npm dependency missing: ${dependency}`);
  copyDirectory(source, path.join(output, 'node_modules', dependency));
}

copyFile('package.json');
fs.writeFileSync(path.join(output, 'browser-use.bat'), '@echo off\r\nsetlocal\r\nset NODE_NO_WARNINGS=1\r\nstart "Browser-use" /D "%~dp0" "%~dp0browser-use.exe" %*\r\n');
fs.writeFileSync(path.join(output, 'browser-use.ps1'), '& (Join-Path $PSScriptRoot "browser-use.exe") @args\n');
fs.writeFileSync(path.join(output, 'RUN_BROWSER_USE.cmd'), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0browser-use.exe"\r\nif errorlevel 1 pause\r\n');
fs.writeFileSync(path.join(output, 'README-LAUNCH.txt'), 'Double-click RUN_BROWSER_USE.cmd to launch Browser-use visibly. It opens Chrome with the Browser-use Control Center in the foreground. If startup fails, the command window stays open with the error.\r\n');
fs.writeFileSync(path.join(output, 'mcp-config.example.json'), JSON.stringify({
  mcpServers: {
    'browser-use': {
      command: 'E:\\path\\to\\browser-use\\browser-use.bat',
      args: []
    }
  }
}, null, 2));

const executablePath = path.join(output, 'browser-use.exe');
const nodeExecutable = process.execPath;
const seaConfig = path.join(root, 'sea-config.release.json');
const seaBlob = path.join(output, 'browser-use.blob');
let executable = false;
let executableNote = 'Portable launchers are available.';

try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(nodeExecutable, ['--experimental-sea-config', seaConfig], { cwd: output, stdio: 'pipe' });
  fs.copyFileSync(nodeExecutable, executablePath);
  const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
  execFileSync(process.execPath, [postject, executablePath, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: output, stdio: 'pipe' });
  fs.rmSync(seaBlob, { force: true });
  executable = true;
  executableNote = 'Windows Node SEA launcher built. Keep this executable beside the generated src/ and node_modules folders.';
} catch (error) {
  executableNote = `SEA executable was not built: ${error.message}. Portable launchers remain available.`;
}

console.log(JSON.stringify({
  ok: true,
  output,
  runtimeFiles: runtimeFiles.length,
  dependencies,
  upstreamBundled: fs.existsSync(path.join(upstreamSource, 'pyproject.toml')),
  executable,
  executablePath: executable ? executablePath : null,
  note: executableNote
}, null, 2));
