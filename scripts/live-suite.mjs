/**
 * Standing live-regression suite: runs the friction-rubric harnesses
 * sequentially against the real provider and prints one verdict line each.
 * Every harness self-reverts nothing — run each against a clean baseline
 * (git reset --hard origin/main for studio-facing runs).
 *
 * Usage: node scripts/live-suite.mjs [moles|program-control|studio-inspector ...]
 * (default: all three, fastest first)
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ALL = ["moles-vision", "program-control", "studio-inspector"];
const requested = process.argv.slice(2);
const names = requested.length ? requested : ALL;
const SCRIPTS = {
  "moles-vision": "live-moles-vision.mjs",
  "program-control": "live-program-control.mjs",
  "studio-inspector": "live-studio-inspector.mjs"
};

const results = [];
for (const name of names) {
  const script = SCRIPTS[name];
  if (!script) { console.error(`unknown harness: ${name}`); process.exit(2); }
  console.log(`\n=== ${name} ===`);
  const run = spawnSync(process.execPath, [join(ROOT, script)], { encoding: "utf8", timeout: 75 * 60_000 });
  const tail = String(run.stdout || "").trim().split("\n").slice(-20).join("\n");
  let verdict = null;
  try { verdict = JSON.parse(String(run.stdout || "").slice(String(run.stdout || "").lastIndexOf("{"))); } catch {}
  results.push({ name, ok: verdict?.ok === true, failures: verdict?.failures || [`exit ${run.status}`], tail: tail.slice(-400) });
  console.log(JSON.stringify(results.at(-1), null, 1));
}
const failed = results.filter((r) => !r.ok);
console.log(`\nSUITE: ${results.length - failed.length}/${results.length} clean`);
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1); }
