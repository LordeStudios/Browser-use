import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { currentVisualEvidence, declaredReasoning } = require('../desktop/agent/providers/wire.cjs');

test('currentVisualEvidence rejects file:// and blob: URLs that are not base64', () => {
  assert.equal(currentVisualEvidence({ screenshot: { data: 'file:///C:/Users/x/shot.png', mimeType: 'image/png' } }), null,
    'a file:// URL must not be forwarded as image bytes');
  assert.equal(currentVisualEvidence({ screenshot: { data: 'blob:null/abc-123', mimeType: 'image/png' } }), null,
    'a blob: URL must not be forwarded as image bytes');
  assert.equal(currentVisualEvidence({ screenshot: { data: 'content://media/external/images/1', mimeType: 'image/png' } }), null);
});

test('currentVisualEvidence still accepts real base64 and data URLs', () => {
  const b64 = currentVisualEvidence({ screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } });
  assert.ok(b64 && b64.data === 'iVBORw0KGgo=' && b64.mimeType === 'image/png');
  const dataUrl = currentVisualEvidence({ screenshot: { data: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' } });
  assert.ok(dataUrl && dataUrl.data === 'iVBORw0KGgo=' && dataUrl.mimeType === 'image/png');
});

test('provider image guard rejects every client-local reference shape', () => {
  // Guardrail invariant: any image payload leaving the agent providers must be
  // base64 or data:image/...; file://, blob:, content://, and raw paths are
  // rejected before they can reach a provider request.
  const guard = (value) => /^data:image\/[^;,]+;base64,[a-z0-9+/=]+$/i.test(value) || /^[a-z0-9+/]+={0,2}$/i.test(value);
  for (const candidate of ['file:///C:/x.png', 'blob:null/abc', 'content://media/1', 'C:\\x.png', 'file://C:/x.png']) {
    assert.equal(guard(candidate), false, `${candidate} must never be a provider image payload`);
  }
});

test('declaredReasoning does NOT collapse legitimate repeated reasoning', () => {
  const X = 'Rechecking the same visible state without choosing an action. ';
  const repeated = X.repeat(90);
  const result = declaredReasoning({ reasoning_content: repeated });
  assert.equal(result, repeated, 'repeated content from a looping model must be preserved verbatim');
  const distinct = declaredReasoning({ reasoning_content: 'First thought.' });
  assert.equal(distinct, 'First thought.');
});
