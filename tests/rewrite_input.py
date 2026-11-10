import pathlib
p=pathlib.Path('E:/Users/maximus/Documents/GitHub/uganda-art-pulse/tools/browser-use/src/browser/input.js')
src = r'''
async function client(ctx){return ctx.browser.ensure();}

const FIND_ELEMENT_HELPER = `
  const findElementAndCoords = (selector) => {
    const parseSelector = (sel) => {
      const match = sel.match(/(.*):has-text\\(([\"'])(.*?)\\2\\)/);
      if (match) return { base: match[1] || '*', text: match[3] };
      const matchText = sel.match(/(.*):text\\(([\"'])(.*?)\\2\\)/);
      if (matchText) return { base: matchText[1] || '*', text: matchText[3] };
      return { base: sel, text: null };
    };
    const matchesText = (el, text) => {
      if (!text) return true;
      const t = (el.textContent || '').trim();
      if (t.includes(text)) return true;
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (aria.includes(text)) return true;
      const title = (el.getAttribute('title') || '').trim();
      if (title.includes(text)) return true;
      const value = (el.value || '').trim();
      return value.includes(text);
    };
    const queryInDoc = (doc, parsed) => {
      if (parsed.text) {
        const elements = doc.querySelectorAll(parsed.base);
        for (const el of elements) if (matchesText(el, parsed.text)) return el;
        return null;
      }
      return doc.querySelector(parsed.base);
    };
    const parsed = parseSelector(selector);
    let el;
    try { el = queryInDoc(document, parsed); } catch (e) {}
    if (el) {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), el };
    }
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        el = queryInDoc(doc, parsed);
        if (el) {
          const r = el.getBoundingClientRect();
          const ir = iframe.getBoundingClientRect();
          return { x: Math.round(ir.left + r.left), y: Math.round(ir.top + r.top), w: Math.round(r.width), h: Math.round(r.height), el };
        }
      } catch (e) {}
    }
    return null;
  };
`;

const CURSOR_HELPER = `
  const __browserUseCursor = (() => {
    const SVG = '<svg width="28" height="28" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(1px 1px 1px rgba(255,255,255,0.95))"><path d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    let ptr = document.getElementById('__browser_use_cursor__');
    if (!ptr) {
      ptr = document.createElement('div');
      ptr.id = '__browser_use_cursor__';
      ptr.innerHTML = SVG;
      Object.assign(ptr.style, {
        position: 'fixed', left: '0px', top: '0px', width: '28px', height: '28px',
        pointerEvents: 'none', zIndex: '2147483647', opacity: '1',
        transition: 'left 0.12s ease-out, top 0.12s ease-out',
        margin: '0', padding: '0', border: 'none', background: 'transparent'
      });
      document.body.appendChild(ptr);
    }
    return {
      move(x, y) {
        ptr.style.left = x + 'px';
        ptr.style.top = y + 'px';
        ptr.style.opacity = '1';
      },
      ensure() { ptr.style.opacity = '1'; return ptr; }
    };
  })();
`;

async function moveCursor(ctx, x, y, waitTransition = true) {
  const c = await client(ctx);
  await c.Runtime.evaluate({ expression: `(() => { ${CURSOR_HELPER} __browserUseCursor.move(${x}, ${y}); })()` }).catch(() => {});
  if (waitTransition) await new Promise(r => setTimeout(r, 140));
  return { x, y };
}

async function resolveSelectorCoords(ctx, selector, position) {
  const c = await client(ctx);
  const r = await c.Runtime.evaluate({
    expression: `(() => {
      ${FIND_ELEMENT_HELPER}
      const res = findElementAndCoords(${JSON.stringify(selector)});
      if (!res) return null;
      if (${JSON.stringify(position)}) {
        return { x: Math.round(res.x + ${position.x || 0}), y: Math.round(res.y + ${position.y || 0}), w: res.w, h: res.h };
      }
      return { x: Math.round(res.x + res.w / 2), y: Math.round(res.y + res.h / 2), w: res.w, h: res.h };
    })()`,
    returnByValue: true
  });
  return r.result.value;
}

export async function click(ctx, { x, y }) {
  const c = await client(ctx);
  await moveCursor(ctx, x, y);
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x, y };
}

export async function clickSelector(ctx, { selector }) {
  const c = await client(ctx);
  const found = await c.Runtime.evaluate({
    expression: `(() => {
      ${FIND_ELEMENT_HELPER}
      const res = findElementAndCoords(${JSON.stringify(selector)});
      if (!res) return { found: false, reason: 'selector not found' };
      const style = getComputedStyle(res.el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && res.w > 0 && res.h > 0;
      if (!visible) return { found: true, visible: false, reason: 'element not visible', rect: res };
      res.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      res.el.offsetHeight;
      const r2 = res.el.getBoundingClientRect();
      const cx = Math.round(r2.left + r2.width / 2);
      const cy = Math.round(r2.top + r2.height / 2);
      return { found: true, visible: true, x: cx, y: cy, tag: res.el.tagName, rect: { x: Math.round(r2.left), y: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) } };
    })()`,
    returnByValue: true
  });
  const v = found.result.value;
  if (!v.found) throw new Error(`clickSelector failed: ${v.reason} for "${selector}"`);
  if (!v.visible) throw new Error(`clickSelector failed: ${v.reason} for "${selector}" at ${JSON.stringify(v.rect)}`);

  await moveCursor(ctx, v.x, v.y, true);

  // Use CDP pointer events at the element center; this triggers native handlers and event listeners.
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: v.x, y: v.y });
  await new Promise(r => setTimeout(r, 30));
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: v.x, y: v.y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 60));
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: v.x, y: v.y, button: 'left', clickCount: 1 });

  return { ok: true, selector, x: v.x, y: v.y, rect: v.rect };
}

export async function typeText(ctx, { text }) {
  const c = await client(ctx);
  for (const ch of text) {
    await c.Input.dispatchKeyEvent({ type: 'keyDown', text: ch });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', text: ch });
  }
  return { text };
}

export async function typeSelector(ctx, { selector, text }) {
  const c = await client(ctx);
  const found = await c.Runtime.evaluate({
    expression: `(() => {
      ${FIND_ELEMENT_HELPER}
      const res = findElementAndCoords(${JSON.stringify(selector)});
      if (!res) return { found: false, reason: 'selector not found' };
      const style = getComputedStyle(res.el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && res.w > 0 && res.h > 0;
      if (!visible) return { found: true, visible: false, reason: 'element not visible' };
      res.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      res.el.offsetHeight;
      const r2 = res.el.getBoundingClientRect();
      const cx = Math.round(r2.left + r2.width / 2);
      const cy = Math.round(r2.top + r2.height / 2);
      return { found: true, visible: true, x: cx, y: cy, tag: res.el.tagName, rect: { x: Math.round(r2.left), y: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) } };
    })()`,
    returnByValue: true
  });
  const v = found.result.value;
  if (!v.found) throw new Error(`typeSelector failed: ${v.reason} for "${selector}"`);
  if (!v.visible) throw new Error(`typeSelector failed: ${v.reason} for "${selector}"`);

  await moveCursor(ctx, v.x, v.y, true);

  const typed = await c.Runtime.evaluate({
    expression: `(() => {
      ${FIND_ELEMENT_HELPER}
      const res = findElementAndCoords(${JSON.stringify(selector)});
      if (!res || !res.el) return { typed: false, reason: 'element lost' };
      const el = res.el;
      try {
        el.focus();
        if (el.tagName === 'SELECT') {
          let option = null;
          for (const opt of el.options) {
            if (opt.text.trim() === ${JSON.stringify(text)} || opt.value === ${JSON.stringify(text)}) { option = opt; break; }
          }
          if (!option) return { typed: false, reason: 'option not found: ' + ${JSON.stringify(text)} };
          const before = el.value;
          el.value = option.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { typed: true, value: el.value, before, optionText: option.text };
        }
        if (typeof el.select === 'function') el.select();
        if ('value' in el) {
          const before = el.value;
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { typed: true, value: el.value, before };
        }
        el.textContent = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { typed: true, textContent: el.textContent };
      } catch (e) { return { typed: false, reason: e.message }; }
    })()`,
    returnByValue: true
  });
  await new Promise(r => setTimeout(r, 80));
  return { ok: true, selector, text, coords: { x: v.x, y: v.y }, result: typed.result.value };
}

export async function key(ctx, { key }) {
  const c = await client(ctx);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key });
  return { key };
}

export async function scroll(ctx, { deltaX = 0, deltaY = 0 }) {
  const c = await client(ctx);
  await c.Input.dispatchMouseEvent({ type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY });
  return { deltaX, deltaY };
}

export async function hover(ctx, { x, y }) {
  const c = await client(ctx);
  await moveCursor(ctx, x, y, false);
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  return { x, y };
}

export async function drag(ctx, { fromX, fromY, toX, toY, steps = 10 }) {
  const c = await client(ctx);
  await moveCursor(ctx, fromX, fromY);
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: fromX, y: fromY, button: 'left' });
  const n = Math.max(2, steps || 10);
  for (let i = 1; i <= n; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / n);
    const y = Math.round(fromY + ((toY - fromY) * i) / n);
    await moveCursor(ctx, x, y, false);
    await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
    await new Promise(r => setTimeout(r, 12));
  }
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: toX, y: toY, button: 'left' });
  return { fromX, fromY, toX, toY, steps: n };
}

export const wait = async (_ctx, { ms = 500 }) => { await new Promise(r => setTimeout(r, Math.min(ms, 5000))); return { ms }; };

export async function mousedown(ctx, { x, y, selector, button = 'left' }) {
  const c = await client(ctx);
  let targetX = x, targetY = y;
  if (selector) {
    const coords = await resolveSelectorCoords(ctx, selector);
    if (coords) { targetX = coords.x; targetY = coords.y; }
  }
  await moveCursor(ctx, targetX, targetY, false);
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: targetX, y: targetY, button, clickCount: 1 });
  return { x: targetX, y: targetY, button };
}

export async function mouseup(ctx, { x, y, selector, button = 'left' }) {
  const c = await client(ctx);
  let targetX = x, targetY = y;
  if (selector) {
    const coords = await resolveSelectorCoords(ctx, selector);
    if (coords) { targetX = coords.x; targetY = coords.y; }
  }
  await moveCursor(ctx, targetX, targetY, false);
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: targetX, y: targetY, button, clickCount: 1 });
  return { x: targetX, y: targetY, button };
}

export async function mousemove(ctx, { x, y, selector, position, button = 'left' }) {
  const c = await client(ctx);
  let targetX = x, targetY = y;
  if (selector) {
    const coords = await resolveSelectorCoords(ctx, selector, position);
    if (coords) { targetX = coords.x; targetY = coords.y; }
  }
  await moveCursor(ctx, targetX, targetY, false);
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x: targetX, y: targetY, button });
  return { x: targetX, y: targetY };
}
'''
p.write_text(src, encoding='utf-8')
print('wrote', len(src))
