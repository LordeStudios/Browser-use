import crypto from 'node:crypto';

// HMAC-SHA256 bearer tokens mirroring signMcpJwt/verifyMcpJwt in
// studios/src/worker.js so both runtimes share one proven auth contract.
const DEFAULT_TOKEN_TTL_SECONDS = Infinity;

function base64UrlEncode(data) {
  return Buffer.from(data).toString('base64url');
}

function base64UrlDecode(value) {
  try {
    return Buffer.from(String(value), 'base64url');
  } catch {
    return null;
  }
}

export function cleanMcpKey(key) {
  return String(key || '').trim().slice(0, 128);
}

export function makeDaemonSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export function signMcpToken(key, secret, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS) {
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: cleanMcpKey(key),
    iat: now,
    ...(Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? { exp: now + ttlSeconds } : {})
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyMcpToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    if (header.alg !== 'HS256') return null;
    if (payload.exp && Number.isFinite(payload.exp) && Math.floor(Date.now() / 1000) > payload.exp) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const provided = base64UrlDecode(parts[2]);
    if (!provided || provided.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractBearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
  return match?.[1]?.trim() || '';
}

export function requireMcpAuth(request, secret) {
  const token = extractBearerToken(request);
  if (!token) return { ok: false, status: 401, error: 'Unauthorized: missing token.' };
  const claims = verifyMcpToken(token, secret);
  if (!claims?.sub) return { ok: false, status: 401, error: 'Unauthorized: invalid or expired token.' };
  return { ok: true, key: claims.sub };
}
