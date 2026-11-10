
async function client(ctx) {
  return ctx.browser.ensure();
}

function rememberPointer(browser, x, y) {
  browser.lastPointer = { x, y };
}

function lastPointerFor(browser) {
  return browser?.lastPointer || { x: 0, y: 0 };
}

const FIND_ELEMENT_HELPER = `
  const findElementAndCoords = (selector) => {
    const parseSelector = (value) => {
      const hasText = value.match(/(.*):has-text\\((["'])(.*?)\\2\\)/);
      if (hasText) return { base: hasText[1] || '*', text: hasText[3] };
      const text = value.match(/(.*):text\\((["'])(.*?)\\2\\)/);
      return text ? { base: text[1] || '*', text: text[3] } : { base: value, text: null };
    };
    const matchesText = (element, text) => !text || [
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.value
    ].some((value) => String(value || '').trim().includes(text));
    const query = (doc, parsed) => {
      const elements = doc.querySelectorAll(parsed.base);
      return [...elements].find((element) => matchesText(element, parsed.text)) || null;
    };
    const parsed = parseSelector(selector);
    const element = query(document, parsed);
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const isInActivePanel = !element.closest('[data-left-panel]') || Boolean(element.closest('[data-left-panel].is-active'));
    if (!isInActivePanel || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type'),
      selectable: element.tagName === 'SELECT'
    };
  };
`;

async function resolveSelector(ctx, selector, position) {
  const cdp = await client(ctx);
  const result = await cdp.Runtime.evaluate({
    expression: `(() => {
      ${FIND_ELEMENT_HELPER}
      const target = findElementAndCoords(${JSON.stringify(selector)});
      if (!target) return null;
      const offset = ${JSON.stringify(position || null)};
      return {
        ...target,
        x: Math.round(target.x + (offset?.x ?? target.w / 2)),
        y: Math.round(target.y + (offset?.y ?? target.h / 2))
      };
    })()`,
    returnByValue: true
  });
  return result.result?.value || null;
}

async function move(ctx, x, y) {
  const cdp = await client(ctx);
  rememberPointer(ctx.browser, x, y);
  await cdp.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  return { mode: 'cdp-native-input', x, y, pageMutation: false };
}

async function clickAt(ctx, x, y, clickCount = 1) {
  const cdp = await client(ctx);
  const cursor = await move(ctx, x, y);
  await cdp.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
  await cdp.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount });
  return { x, y, clickCount, cursor };
}

export async function click(ctx, { x, y }) {
  return clickAt(ctx, x, y);
}

export async function clickSelector(ctx, { selector }) {
  const target = await resolveSelector(ctx, selector);
  if (!target) throw new Error(`clickSelector: visible interactive element not found: ${selector}`);
  return { ...await clickAt(ctx, target.x, target.y), selector, target };
}

export async function typeText(ctx, { text }) {
  const cdp = await client(ctx);
  await cdp.Input.insertText({ text });
  return { text, length: text.length, method: 'Input.insertText' };
}

export async function insertText(ctx, { text }) {
  return typeText(ctx, { text });
}

export async function typeSelector(ctx, { selector, text }) {
  const target = await resolveSelector(ctx, selector);
  if (!target) throw new Error(`typeSelector: visible editable element not found: ${selector}`);
  if (target.selectable) throw new Error(`typeSelector cannot choose options. Use browser.selectOption for ${selector}`);
  await clickAt(ctx, target.x, target.y);
  const cdp = await client(ctx);
  const focus = await cdp.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { focused: false, reason: 'The selected element is no longer present.' };
      try { element.focus?.({ preventScroll: true }); } catch {}
      const editable = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        && !element.disabled && !element.readOnly
        && !['file', 'hidden', 'password'].includes(String(element.type || '').toLowerCase());
      let selected = false;
      if (editable) {
        try {
          if (typeof element.select === 'function') {
            element.select();
            selected = true;
          } else if (typeof element.setSelectionRange === 'function') {
            element.setSelectionRange(0, String(element.value ?? '').length);
            selected = true;
          }
        } catch {}
      } else if (element.isContentEditable) {
        try {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          selected = true;
        } catch {}
      }
      return { focused: document.activeElement === element, editable, selected };
    })()`,
    returnByValue: true
  });
  if (focus.result?.value?.focused !== true) {
    throw new Error(`typeSelector: ${selector} did not retain focus after click; observe the page and retry.`);
  }
  await cdp.Input.insertText({ text });
  return { ok: true, selector, text, coords: { x: target.x, y: target.y }, target, method: 'Input.insertText' };
}

export async function selectOption(ctx, { selector, value }) {
  const cdp = await client(ctx);
  const result = await cdp.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: 'Select element not found' };
      const option = [...element.options].find((item) => item.value === ${JSON.stringify(value)} || item.text.trim() === ${JSON.stringify(value)});
      if (!option) return { ok: false, error: 'Option not found' };
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: element.value, text: option.text };
    })()`,
    returnByValue: true
  });
  if (!result.result?.value?.ok) throw new Error(`selectOption: ${result.result?.value?.error || 'failed'}`);
  return { selector, ...result.result.value, method: 'DOM select change' };
}

export async function key(ctx, { key }) {
  const cdp = await client(ctx);
  const chord = key?.match?.(/^(Control|Alt|Shift|Meta)\+(.+)$/i);
  if (!chord) {
    await cdp.Input.dispatchKeyEvent({ type: 'keyDown', key });
    await cdp.Input.dispatchKeyEvent({ type: 'keyUp', key });
    return { key };
  }
  const [, modifierName, keyName] = chord;
  const modifier = modifierName.toLowerCase();
  const modifierEvent = { type: 'keyDown', key: modifierName, [modifier]: true };
  await cdp.Input.dispatchKeyEvent(modifierEvent);
  await cdp.Input.dispatchKeyEvent({ type: 'keyDown', key: keyName, [modifier]: true });
  await cdp.Input.dispatchKeyEvent({ type: 'keyUp', key: keyName, [modifier]: true });
  await cdp.Input.dispatchKeyEvent({ type: 'keyUp', key: modifierName, [modifier]: true });
  return { key };
}

export async function scroll(ctx, { deltaX = 0, deltaY = 0 }) {
  const cdp = await client(ctx);
  const { x, y } = lastPointerFor(ctx.browser);
  await cdp.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
  return { deltaX, deltaY };
}

export async function hover(ctx, { x, y }) {
  return move(ctx, x, y);
}

export async function drag(ctx, { fromX, fromY, toX, toY, steps = 20 }) {
  const cdp = await client(ctx);
  const totalSteps = Math.max(2, Math.min(100, Number(steps) || 20));
  await move(ctx, fromX, fromY);
  await cdp.Input.dispatchMouseEvent({ type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  let pressed = true;
  try {
    for (let index = 1; index <= totalSteps; index += 1) {
      const progress = index / totalSteps;
      const x = Math.round(fromX + (toX - fromX) * progress);
      const y = Math.round(fromY + (toY - fromY) * progress);
      rememberPointer(ctx.browser, x, y);
      await cdp.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
  } finally {
    if (pressed) {
      await cdp.Input.dispatchMouseEvent({ type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
    }
  }
  rememberPointer(ctx.browser, toX, toY);
  return { fromX, fromY, toX, toY, steps: totalSteps, cursor: { mode: 'cdp-native-input', x: toX, y: toY, pageMutation: false } };
}

export async function mousedown(ctx, { x, y, selector, button = 'left' }) {
  const target = selector ? await resolveSelector(ctx, selector) : { x, y };
  if (!target || target.x == null || target.y == null) throw new Error('mousedown requires coordinates or a visible selector');
  const cdp = await client(ctx);
  await move(ctx, target.x, target.y);
  await cdp.Input.dispatchMouseEvent({ type: 'mousePressed', x: target.x, y: target.y, button, buttons: 1, clickCount: 1 });
  return { x: target.x, y: target.y, button };
}

export async function mouseup(ctx, { x, y, selector, button = 'left' }) {
  const target = selector ? await resolveSelector(ctx, selector) : { x, y };
  if (!target || target.x == null || target.y == null) throw new Error('mouseup requires coordinates or a visible selector');
  const cdp = await client(ctx);
  await move(ctx, target.x, target.y);
  await cdp.Input.dispatchMouseEvent({ type: 'mouseReleased', x: target.x, y: target.y, button, buttons: 0, clickCount: 1 });
  return { x: target.x, y: target.y, button };
}

export async function mousemove(ctx, { x, y, selector, position }) {
  const target = selector ? await resolveSelector(ctx, selector, position) : { x, y };
  if (!target || target.x == null || target.y == null) throw new Error('mousemove requires coordinates or a visible selector');
  return move(ctx, target.x, target.y);
}

function assertFiniteCoordinate(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

export async function dispatchRealtimeInput(ctx, event) {
  const cdp = await client(ctx);
  if (!event || typeof event !== 'object') throw new Error('Realtime input event is required');

  if (event.type === 'input.key') {
    if (typeof event.key !== 'string' || !event.key) throw new Error('Realtime key input requires a key');
    if (!['down', 'up'].includes(event.action)) throw new Error('Realtime key action must be down or up');
    await cdp.Input.dispatchKeyEvent({ type: event.action === 'down' ? 'keyDown' : 'keyUp', key: event.key, code: event.code || event.key });
    return { kind: 'key', key: event.key, action: event.action };
  }

  if (event.type === 'input.text') {
    if (typeof event.text !== 'string') throw new Error('Realtime text input requires text');
    await cdp.Input.insertText({ text: event.text });
    return { kind: 'text', length: event.text.length };
  }

  if (event.type === 'input.wheel') {
    const deltaX = Number(event.deltaX || 0);
    const deltaY = Number(event.deltaY || 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('Realtime wheel deltas must be finite');
    await cdp.Input.dispatchMouseEvent({ type: 'mouseWheel', x: Number(event.x || 0), y: Number(event.y || 0), deltaX, deltaY });
    return { kind: 'wheel', deltaX, deltaY };
  }

  if (event.type === 'input.pointer') {
    assertFiniteCoordinate(event.x, 'Pointer x');
    assertFiniteCoordinate(event.y, 'Pointer y');
    const button = event.button || 'left';
    const types = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
    const type = types[event.action];
    if (!type) throw new Error('Realtime pointer action must be move, down, or up');
    rememberPointer(ctx.browser, event.x, event.y);
    await cdp.Input.dispatchMouseEvent({ type, x: event.x, y: event.y, button, buttons: event.action === 'down' ? 1 : 0, clickCount: event.action === 'move' ? 0 : 1 });
    return { kind: 'pointer', action: event.action, x: event.x, y: event.y, button, pageMutation: false };
  }

  throw new Error(`Unsupported realtime input type: ${event.type}`);
}

export async function wait(_ctx, { ms } = {}) {
  const requestedMs = Number(ms);
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) throw new Error('Wait requires a positive ms value.');
  const safeMs = Math.min(Math.round(requestedMs), 10_000);
  await new Promise((resolve) => setTimeout(resolve, safeMs));
  return { ms: safeMs };
}
