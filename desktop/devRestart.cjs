'use strict';

const fs = require('fs');
const path = require('path');

// SELF-RESTART SCHEDULER — the app's half of computer_resume.
//
// The agent used to restart itself by shelling out to the launcher. That
// command looked "still running" in its terminal, so it retried, and every
// retry queued another restart: the app restarted forever. This module makes
// a restart a single, acknowledged decision:
//   • exactly one external timer is spawned per restart,
//   • a second call inside the cooldown is REFUSED (and says so in words the
//     model can act on: "already restarted, do not restart again"),
//   • the cooldown marker is written to disk, so it survives the restart that
//     it guards against — the resumed run cannot immediately restart again,
//   • a packaged build never restarts itself.
const DEFAULT_COOLDOWN_MS = 60_000;
// How long a chain of restarts keeps counting as ONE session. A loop of
// restarts (the agent keeps replanning "restart the app") must be visible as
// a growing number, so the count survives until the user stops working on it.
const CHAIN_WINDOW_MS = 30 * 60_000;

function createDevRestartScheduler({
  isPackaged = false,
  userDataDir = null,
  timerScript = null,
  repoRoot = null,
  spawn = null,
  now = Date.now,
  log = () => {},
  cooldownMs = DEFAULT_COOLDOWN_MS
} = {}) {
  let scheduledAt = 0;

  const markerPath = () => (userDataDir ? path.join(userDataDir, 'dev-restart.json') : null);

  function readMarker() {
    try {
      const filePath = markerPath();
      if (!filePath) return 0;
      return Number(JSON.parse(fs.readFileSync(filePath, 'utf8'))?.at) || 0;
    } catch { return 0; }
  }

  // The WHOLE marker, not just its timestamp: the resume card needs to know
  // how many restarts this chain has already had and why each one was
  // requested, so the agent can see it is looping instead of guessing.
  function readMarkerRecord() {
    try {
      const filePath = markerPath();
      if (!filePath) return null;
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return record && typeof record === 'object' ? record : null;
    } catch { return null; }
  }

  function writeMarker(record) {
    try {
      const filePath = markerPath();
      if (!filePath) return;
      fs.writeFileSync(filePath, JSON.stringify(record), { mode: 0o600 });
    } catch { /* the marker is a guard, not a contract */ }
  }

  // The most recent restart this app knows about, in memory or on disk.
  function lastRestartAt() {
    return Math.max(scheduledAt, readMarker());
  }

  function schedule({ graceSeconds = 5, reason = '' } = {}) {
    if (isPackaged) {
      return { ok: false, packaged: true, note: 'A packaged build cannot restart itself. Relaunch the app to apply the change.' };
    }
    if (!timerScript || !fs.existsSync(timerScript)) {
      return { ok: false, note: 'The restart timer is missing (scripts/dev-resume-deferred.bat); nothing was scheduled.' };
    }
    if (typeof spawn !== 'function') {
      return { ok: false, note: 'This build has no process launcher; nothing was scheduled.' };
    }
    const at = now();
    const last = lastRestartAt();
    if (last && at - last < cooldownMs) {
      const secondsAgo = Math.round((at - last) / 1000);
      const secondsLeft = Math.ceil((cooldownMs - (at - last)) / 1000);
      // The refusal carries the CHAIN EVIDENCE: when the last restart
      // happened and how many this session has had. A model that keeps
      // replanning "restart the app" reads its own loop count here instead
      // of discovering it after the ninth reboot.
      const restartCount = Number(readMarkerRecord()?.count) || 0;
      const lastIso = (() => { try { return new Date(last).toISOString(); } catch { return ''; } })();
      return {
        ok: false,
        alreadyRestarted: true,
        secondsAgo,
        secondsLeft,
        restartCount,
        note: `The app was already restarted ${secondsAgo}s ago${lastIso ? ` (at ${lastIso}${restartCount ? `, restart #${restartCount} of this session` : ''})` : ''}, so that change is ALREADY live. Do NOT restart again — continue the work. Another restart is refused for ${secondsLeft}s.`
      };
    }
    // How many restarts this CHAIN has had. The agent used to restart the app
    // over and over (nine times in one session) because it could not tell a
    // restart from a no-op; the count makes the loop visible in the marker
    // that survives the restart, so the resume card can name it.
    const previous = readMarkerRecord();
    const previousAt = Number(previous?.at) || 0;
    const count = previousAt && (at - previousAt) <= CHAIN_WINDOW_MS ? (Number(previous?.count) || 0) + 1 : 1;
    const seconds = Math.max(1, Math.min(120, Number(graceSeconds) || 5));
    // `start` gives the timer its own console: it must outlive the app it is
    // about to kill.
    const timer = spawn('cmd.exe', ['/c', 'start', '', '/min', 'cmd.exe', '/c', timerScript], {
      cwd: repoRoot || path.dirname(timerScript),
      env: { ...process.env, DEV_RESUME_GRACE: String(seconds) },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    try { timer?.unref?.(); } catch { /* best effort */ }
    scheduledAt = at;
    writeMarker({ at, graceSeconds: seconds, reason: String(reason || '').slice(0, 300), count });
    log(`Restart scheduled in ${seconds}s (computer_resume)${reason ? `: ${String(reason).slice(0, 120)}` : ''}.`);
    return {
      ok: true,
      scheduled: true,
      graceSeconds: seconds,
      restartCount: count,
      note: `Restart scheduled in ${seconds}s. End your turn NOW with browser_done — the app reopens on this conversation, same tabs and model, and this run continues where it stopped. Do not call computer_resume again.`
    };
  }

  return { schedule, readMarker, readMarkerRecord, markerPath, lastRestartAt };
}

module.exports = { createDevRestartScheduler, DEFAULT_COOLDOWN_MS, CHAIN_WINDOW_MS };
