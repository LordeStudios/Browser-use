const pointer = document.getElementById('browser-use-agent-pointer');
const tip = document.getElementById('browser-use-agent-pointer-tip');
const contact = document.getElementById('browser-use-agent-contact');
const host = window.browserUseAgentPointer;

const TIP_X = 2.25;
const TIP_Y = 2.1;
const MOVE_MIN_MS = 140;
const MOVE_MAX_MS = 360;
const MOVE_DISTANCE_FACTOR = 0.35;
// Keep the agent pointer available long enough to inspect the last action.
// Activity still makes it appear immediately and the fade itself remains rapid.
const IDLE_DELAY_MS = 60_000;
const FADE_MS = 110;
const CLICK_MS = 360;
const CONTACT_MS = 430;
const POINTER_RIGHT_MARGIN = 24;
const POINTER_BOTTOM_MARGIN = 28;

const state = {
  initialized: false,
  sequence: 0,
  currentX: 0,
  currentY: 0,
  startX: 0,
  startY: 0,
  targetX: 0,
  targetY: 0,
  startedAt: 0,
  durationMs: 0,
  moving: false,
  pressed: false,
  frame: 0,
  idleTimer: 0,
  activityToken: 0,
  clickCount: 0,
  pendingPressSequence: 0,
  lastPressSequence: 0,
  operationId: null,
  paintToken: 0,
  tabId: null
};

pointer.dataset.instanceId = crypto.randomUUID();

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeOutQuint(progress) {
  return 1 - ((1 - progress) ** 5);
}

function movementDuration(startX, startY, targetX, targetY) {
  const distance = Math.hypot(targetX - startX, targetY - startY);
  return clamp(MOVE_MIN_MS + (distance * MOVE_DISTANCE_FACTOR), MOVE_MIN_MS, MOVE_MAX_MS);
}

function render() {
  pointer.style.transform = `translate3d(${state.currentX - TIP_X}px, ${state.currentY - TIP_Y}px, 0)`;
  pointer.dataset.currentX = String(state.currentX);
  pointer.dataset.currentY = String(state.currentY);
  pointer.dataset.targetX = String(state.targetX);
  pointer.dataset.targetY = String(state.targetY);
  pointer.dataset.sequence = String(state.sequence);
  pointer.dataset.pressed = String(state.pressed);
}

function sample(now) {
  if (!state.moving) return true;
  const progress = state.durationMs <= 0 ? 1 : clamp((now - state.startedAt) / state.durationMs, 0, 1);
  const eased = easeOutQuint(progress);
  state.currentX = state.startX + ((state.targetX - state.startX) * eased);
  state.currentY = state.startY + ((state.targetY - state.startY) * eased);
  if (progress >= 1) {
    state.currentX = state.targetX;
    state.currentY = state.targetY;
    state.moving = false;
  }
  render();
  return !state.moving;
}

function scheduleFrame() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(tick);
}

function tick(now) {
  state.frame = 0;
  const settled = sample(now);
  if (settled) {
    acknowledgeAfterPaint(state.sequence, 'settled', 1, activate);
    return;
  }
  scheduleFrame();
}

function acknowledgeAfterPaint(sequence, status, frameCount, beforeAcknowledge = null) {
  const paintToken = state.paintToken;
  let remaining = Math.max(1, frameCount);
  let settled = false;
  // The ack must never HANG on rAF. A freshly shown, transparent, non-focusable
  // overlay can miss frames (Windows compositor, occlusion), and an un-acked
  // command made the harness hide the window on timeout — which guaranteed the
  // next command could never paint either: a permanent ack-timeout cycle on
  // every click (~700ms x 2 = the observed 1.2s/click). The frame wait is the
  // preferred signal; this bounded fallback keeps the contract alive.
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(fallbackTimer);
    beforeAcknowledge?.();
    pointer.dataset.paintConfirmedAt = String(Date.now());
    host.acknowledge({ sequence, status });
  };
  const fallbackTimer = setTimeout(finish, 180);
  const waitForFrame = () => {
    requestAnimationFrame(() => {
      if (settled || paintToken !== state.paintToken) return;
      remaining -= 1;
      if (remaining > 0) {
        waitForFrame();
        return;
      }
      finish();
    });
  };
  waitForFrame();
}

function activate() {
  state.activityToken += 1;
  const token = state.activityToken;
  clearTimeout(state.idleTimer);
  pointer.style.transition = 'none';
  pointer.style.opacity = '1';
  pointer.dataset.visible = 'true';
  state.idleTimer = setTimeout(() => {
    if (token !== state.activityToken) return;
    pointer.style.transition = `opacity ${FADE_MS}ms cubic-bezier(0.4, 0, 1, 1)`;
    pointer.style.opacity = '0';
    pointer.dataset.visible = 'false';
  }, IDLE_DELAY_MS);
}

function hide({ reset = false } = {}) {
  if (state.moving) sample(performance.now());
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = 0;
  state.moving = false;
  state.startX = state.currentX;
  state.startY = state.currentY;
  state.targetX = state.currentX;
  state.targetY = state.currentY;
  state.operationId = null;
  state.paintToken += 1;
  state.activityToken += 1;
  clearTimeout(state.idleTimer);
  pointer.style.transition = 'none';
  pointer.style.opacity = '0';
  pointer.dataset.visible = 'false';
  state.pressed = false;
  state.pendingPressSequence = 0;
  state.lastPressSequence = 0;
  cancelClickFeedback();
  if (reset) {
    state.initialized = false;
  }
  render();
}

function move(command) {
  const targetX = Number(command.x);
  const targetY = Number(command.y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return;
  if (state.pendingPressSequence) {
    state.pendingPressSequence = 0;
    cancelClickFeedback();
  }
  activate();
  const now = performance.now();
  if (state.moving) sample(now);
  state.paintToken += 1;
  state.sequence = Number(command.sequence) || (state.sequence + 1);
  state.operationId = normalizeOperationId(command.operationId);
  state.targetX = targetX;
  state.targetY = targetY;
  if (!state.initialized) {
    state.initialized = true;
    state.currentX = targetX;
    state.currentY = targetY;
    state.startX = targetX;
    state.startY = targetY;
    state.moving = false;
    render();
    acknowledgeAfterPaint(state.sequence, 'settled', 2, activate);
    return;
  }

  state.startX = state.currentX;
  state.startY = state.currentY;
  state.startedAt = now;
  state.durationMs = Number.isFinite(Number(command.durationMs)) && Number(command.durationMs) > 0
    ? clamp(Number(command.durationMs), 16, MOVE_MAX_MS)
    : movementDuration(state.startX, state.startY, targetX, targetY);
  state.moving = Math.hypot(targetX - state.startX, targetY - state.startY) > 0.1;
  render();
  if (!state.moving) {
    acknowledgeAfterPaint(state.sequence, 'settled', 2, activate);
    return;
  }
  scheduleFrame();
}

function press(command) {
  activate();
  sample(performance.now());
  state.paintToken += 1;
  state.sequence = Number(command.sequence) || (state.sequence + 1);
  state.operationId = normalizeOperationId(command.operationId);
  const pressSequence = state.sequence;
  state.pendingPressSequence = pressSequence;
  state.lastPressSequence = pressSequence;
  state.pressed = true;
  state.clickCount += 1;
  pointer.dataset.clickCount = String(state.clickCount);
  pointer.dataset.clickX = String(state.currentX);
  pointer.dataset.clickY = String(state.currentY);
  pointer.dataset.clickStartedAt = String(Date.now());
  render();

  for (const animation of tip.getAnimations()) animation.cancel();
  tip.animate([
    { transform: 'rotate(0deg) scale(1)', offset: 0 },
    { transform: 'rotate(-10deg) scale(0.78)', offset: 0.24 },
    { transform: 'rotate(2deg) scale(1.08)', offset: 0.58 },
    { transform: 'rotate(0deg) scale(1)', offset: 1 }
  ], { duration: CLICK_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });

  for (const animation of contact.getAnimations()) animation.cancel();
  contact.style.transform = `translate3d(${state.currentX}px, ${state.currentY}px, 0) scale(0.25)`;
  contact.animate([
    { transform: `translate3d(${state.currentX}px, ${state.currentY}px, 0) scale(0.25)`, opacity: 0.95, offset: 0 },
    { opacity: 0.55, offset: 0.48 },
    { transform: `translate3d(${state.currentX}px, ${state.currentY}px, 0) scale(2.45)`, opacity: 0, offset: 1 }
  ], { duration: CONTACT_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });

  // Acknowledge only after the click state has crossed a paint opportunity, so
  // native mouse-down never leads the visible contact feedback.
  acknowledgeAfterPaint(pressSequence, 'painted', 2, () => {
    activate();
    if (state.pendingPressSequence === pressSequence) state.pendingPressSequence = 0;
  });
}

function cancelClickFeedback() {
  for (const animation of tip.getAnimations()) animation.cancel();
  for (const animation of contact.getAnimations()) animation.cancel();
  tip.style.transform = '';
  contact.style.opacity = '0';
}

function cancelPress(command) {
  const sequence = Number(command.sequence) || 0;
  if (sequence && sequence !== state.lastPressSequence) return;
  state.paintToken += 1;
  state.pendingPressSequence = 0;
  state.pressed = false;
  cancelClickFeedback();
  render();
}

function resizeViewport(command) {
  const width = Math.max(1, Number(command.width) || 1);
  const height = Math.max(1, Number(command.height) || 1);
  if (command.preserveInteraction) {
    if (command.preserveMotion && state.moving) {
      const now = performance.now();
      const remainingDuration = Math.max(16, state.durationMs - Math.max(0, now - state.startedAt));
      sample(now);
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
      state.paintToken += 1;
      // The child surface has already shrunk. Clamp the sampled current point
      // into the visible portion immediately, then continue toward the exact
      // pending destination so the pointer cannot be clipped mid-flight.
      state.currentX = clamp(state.currentX, 0, Math.max(0, width - POINTER_RIGHT_MARGIN));
      state.currentY = clamp(state.currentY, 0, Math.max(0, height - POINTER_BOTTOM_MARGIN));
      state.startX = state.currentX;
      state.startY = state.currentY;
      state.startedAt = now;
      state.durationMs = clamp(remainingDuration, 16, MOVE_MAX_MS);
      state.moving = Math.hypot(state.targetX - state.startX, state.targetY - state.startY) > 0.1;
      render();
      if (state.moving) scheduleFrame();
      else acknowledgeAfterPaint(state.sequence, 'settled', 2, activate);
      return;
    }
    if (state.moving) sample(performance.now());
    render();
    return;
  }
  if (state.moving) sample(performance.now());
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = 0;
  state.moving = false;
  state.sequence = Number(command.sequence) || state.sequence;
  if (state.initialized) {
    state.currentX = clamp(state.currentX, 0, Math.max(0, width - POINTER_RIGHT_MARGIN));
    state.currentY = clamp(state.currentY, 0, Math.max(0, height - POINTER_BOTTOM_MARGIN));
    state.startX = state.currentX;
    state.startY = state.currentY;
    state.targetX = state.currentX;
    state.targetY = state.currentY;
  }
  state.pendingPressSequence = 0;
  state.pressed = false;
  state.operationId = null;
  state.paintToken += 1;
  cancelClickFeedback();
  render();
}

function release(command) {
  const operationId = normalizeOperationId(command.operationId);
  if (operationId !== null && operationId !== state.operationId) return;
  activate();
  state.pressed = false;
  render();
}

function cancelMotion(command) {
  const operationId = normalizeOperationId(command.operationId);
  if (operationId !== null && operationId !== state.operationId) return;
  if (state.moving) sample(performance.now());
  if (state.frame) cancelAnimationFrame(state.frame);
  state.frame = 0;
  state.moving = false;
  state.startX = state.currentX;
  state.startY = state.currentY;
  state.targetX = state.currentX;
  state.targetY = state.currentY;
  state.sequence = Number(command.sequence) || state.sequence;
  state.operationId = null;
  state.pendingPressSequence = 0;
  state.pressed = false;
  state.paintToken += 1;
  cancelClickFeedback();
  render();
}

function activity(command) {
  const operationId = normalizeOperationId(command.operationId);
  if (operationId !== null && operationId !== state.operationId) return;
  activate();
}

function normalizeOperationId(operationId) {
  const numeric = Number(operationId);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function onCommand(command = {}) {
  if (command.type === 'reset') {
    state.tabId = command.tabId || null;
    state.sequence = Number(command.sequence) || state.sequence;
    hide({ reset: true });
    return;
  }
  if (command.type === 'hide') {
    hide();
    return;
  }
  if (command.type === 'move') {
    move(command);
    return;
  }
  if (command.type === 'press') {
    press(command);
    return;
  }
  if (command.type === 'release') {
    release(command);
    return;
  }
  if (command.type === 'cancel-press') {
    cancelPress(command);
    return;
  }
  if (command.type === 'cancel-motion') {
    cancelMotion(command);
    return;
  }
  if (command.type === 'viewport') {
    resizeViewport(command);
    return;
  }
  if (command.type === 'activity') activity(command);
}

host.onCommand(onCommand);
render();

export {
  CLICK_MS,
  CONTACT_MS,
  FADE_MS,
  IDLE_DELAY_MS,
  MOVE_MAX_MS,
  MOVE_MIN_MS,
  easeOutQuint,
  movementDuration
};
