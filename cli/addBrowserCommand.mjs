import { readFileSync, writeFileSync } from 'fs';

const file = 'C:\\Users\\london\\Desktop\\browser-use\\browser-use\\cli\\tui.mjs';
let content = readFileSync(file, 'utf8');

// Add import after appConfig.mjs import
const importLine = "import { startServer, getServerUrl, isServerRunning } from './tui/guiServer.mjs';";
if (!content.includes(importLine)) {
  const marker = "} from './tui/appConfig.mjs';";
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    const endIdx = idx + marker.length;
    content = content.slice(0, endIdx) + '\n' + importLine + content.slice(endIdx);
  }
}

// Add /browser command before /headed
const browserCmd = `registry.register({
  name: 'browser',
  args: '',
  description: 'open the browser-use GUI in your default browser',
  detail: [
    'Starts a local HTTP server on port 4200 (if not already running) and opens',
    'the browser-use desktop renderer at http://localhost:4200'
  ],
  handler: async () => {
    if (isServerRunning()) {
      const url = getServerUrl();
      out(" GUI server already running at " + url, 'accent');
    } else {
      try {
        const { url } = await startServer();
        out(" GUI server started at " + url, 'ok');
      } catch (error) {
        out(" error: could not start GUI server (" + String(error?.message || error) + ")", 'err');
        return;
      }
    }
    const url = getServerUrl();
    // Open in default browser
    try {
      const { exec } = await import('node:child_process');
      exec("start \"\" \"" + url + "\"", { windowsHide: true });
      out(" opening " + url + " in your browser", 'ok');
    } catch (error) {
      out(" error: could not open browser (" + String(error?.message || error) + ")", 'err');
    }
  }
});

`;

if (!content.includes("name: 'browser'")) {
  const headedIdx = content.indexOf("name: 'headed'");
  if (headedIdx !== -1) {
    content = content.slice(0, headedIdx) + browserCmd + content.slice(headedIdx);
  }
}

writeFileSync(file, content);
console.log('Done - /browser command added');
