'use strict';

// DEV RESUME CARD — the proof that this app really restarted.
//
// The agent restarts itself (computer_resume) to make a source change live.
// When it comes back it has NO memory of the restart: the conversation it
// resumes looks exactly like the one it left, so it re-plans the same
// "restart the app" step — and restarts again. Nine times, in a loop.
//
// This card is that evidence. It is built ONCE, in the main process (the
// only place that knows the restart marker, the session file and the clock),
// and it reaches the run as a RUNTIME message: the model sees it in EVERY
// decision of the resumed run, not just the first one.
//
// The card is honest about what it can actually prove:
//   confirmed   — an agent-scheduled restart marker exists AND the restored
//                 session was captured as part of that restart.
//   unconfirmed — the session was restored, but no restart marker backs it
//                 (a manual relaunch). The model must not assume the change
//                 is live just because the app came back.
//
// The card is PURE: no Electron, no clock of its own. The caller passes the
// timestamps in, which is what makes it testable.

const RESTART_BADGE = 'app restart';

// The first line's leading label is what the provider's runtime-message
// bundler keys on (it keeps the NEWEST notice of each kind), so the label
// must stay stable across restarts: every new card REPLACES the previous
// one in the model's context instead of stacking up.
const RESTART_LABEL = 'RESTART RESUMED';

function toIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

function buildResumeCard({ resumedAt = 0, restartedAt = 0, restartCount = 0, reason = '', confirmed = false, restored = true } = {}) {
  const resumedIso = toIso(resumedAt);
  const count = Math.max(0, Number(restartCount) || 0);
  const countText = count ? `, restart #${count} of this session` : '';
  const cleanReason = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const isConfirmed = confirmed === true;
  const didRestore = restored !== false;

  const content = [
    `${RESTART_LABEL} — ${isConfirmed
      ? 'the app restarted and is running the NEW code now'
      : 'the session was restored, but NO agent-scheduled restart backs it (a manual relaunch), so assume nothing about the change being live'} (resumed at ${resumedIso || 'an unknown time'}${countText}).`,
    !didRestore
      ? 'The restart happened, but NO previous session was restored (there was no conversation to resume). Start from the current state of the app and the files — do NOT try to restore or replay anything.'
      : isConfirmed
        ? 'The restart is DONE: do NOT call computer_resume again for this change. Verify the change is live (run the test, or observe the page), then continue the work.'
        : 'Before acting, verify whether the change is actually live (run the test, or observe the page). Do NOT call computer_resume in a loop: if the change is not live, say so instead of restarting again.',
    cleanReason ? `The restart was requested for: ${cleanReason}` : ''
  ].filter(Boolean).join(' ');

  const displayContent = !didRestore
    ? `The app restarted at ${resumedIso || 'an unknown time'}${countText}, but no previous conversation was restored. Start from the current state.`
    : isConfirmed
      ? `Resumed at ${resumedIso || 'an unknown time'}${countText}. The app restarted and the new code is live — verify the change and continue (do not restart again).`
      : `Session restored at ${resumedIso || 'an unknown time'}${countText}, but no agent restart was recorded, so the change may not be live. Verify before continuing.`;

  return {
    badge: RESTART_BADGE,
    content,
    displayContent,
    resumedAt: Number(resumedAt) || 0,
    restartedAt: Number(restartedAt) || 0,
    restartCount: count,
    reason: cleanReason,
    confirmed: isConfirmed,
    restored: didRestore
  };
}

// Turns the raw resume inputs into a card, or null when there was no restart
// at all (a plain dev start must never claim one).
//
//   record   — the dev-session record (null when nothing was restored)
//   marker   — the dev-restart marker {at, reason, count} (null when the app
//              was relaunched by hand)
//   restored — whether a conversation actually came back. Default: inferred
//              from the record. A restart with NOTHING restored is still a
//              restart — that is the "failed restart" the caller must be
//              able to distinguish from a confirmed one.
//   now      — the moment this process came back
function buildResumeCardFrom({ record = null, marker = null, restored = null, now = Date.now() } = {}) {
  const markerAt = Number(marker?.at) || 0;
  const savedAt = Number(record?.savedAt) || 0;
  const didRestore = restored === null ? Boolean(record?.chat) : restored !== false;
  // The session is captured as part of the restart (scheduleDevRestart writes
  // the marker, THEN flushes the session), so a session captured BEFORE the
  // marker belongs to the run before the restart: the restored session does
  // not prove this process came back from that restart. With NO session at
  // all there is nothing to compare against, but the app IS running now, so a
  // marker still confirms that the restart happened — even though nothing
  // came back with it (the failed-restart case).
  const confirmed = markerAt > 0 && (!record || savedAt >= markerAt);
  return buildResumeCard({
    resumedAt: Number(now) || Date.now(),
    restartedAt: markerAt,
    restartCount: Number(marker?.count) || 0,
    reason: marker?.reason || '',
    confirmed,
    restored: didRestore
  });
}

module.exports = { buildResumeCard, buildResumeCardFrom, RESTART_BADGE, RESTART_LABEL };
