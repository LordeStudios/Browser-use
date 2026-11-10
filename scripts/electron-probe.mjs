import { _electron as electron } from "playwright-core";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const root = process.cwd();
const appData = fs.mkdtempSync(path.join(os.tmpdir(), "bu-probe-"));
const app = await electron.launch({
  executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
  args: [".", `--user-data-dir=${appData}`],
  cwd: root,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, BROWSER_USE_DESKTOP_MCP_PORT: "0" }
});
const win = await app.firstWindow();
console.log("WINDOW:", await win.title());
await app.close();
console.log("PROBE-OK");
