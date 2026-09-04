import { beforeAll, describe, expect, it } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-secret-please-be-long-enough';
process.env.LINE_LOGIN_CHANNEL_ID = '1234567890';
process.env.PUBLIC_BASE_URL = 'https://example.test';

let auth: typeof import('../src/auth.js');
beforeAll(async () => {
  auth = await import('../src/auth.js');
});

describe('session JWT', () => {
  it('round-trips and expires', () => {
    const now = new Date('2026-09-04T00:00:00Z');
    const tok = auth.signSession('Uabc', '小明', now);
    expect(tok.split('.')).toHaveLength(3);
    const claims = auth.verifySession(tok, now);
    expect(claims?.uid).toBe('Uabc');
    expect(claims?.name).toBe('小明');
    const later = new Date(now.getTime() + (auth.SESSION_DAYS * 86400 + 1) * 1000);
    expect(auth.verifySession(tok, later)).toBeNull();
  });
  it('rejects tampering', () => {
    const tok = auth.signSession('Uabc', 'x');
    const [h, p, s] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'Uevil', name: 'x', iat: 0, exp: 4e9 })).toString('base64url');
    expect(auth.verifySession(`${h}.${forged}.${s}`)).toBeNull();
    expect(auth.verifySession(`${h}.${p}.AAAA`)).toBeNull();
    expect(auth.verifySession('garbage')).toBeNull();
  });
});

describe('oauth state', () => {
  it('verifies within 10 minutes only', () => {
    const now = new Date();
    const st = auth.makeState(now);
    expect(auth.verifyState(st, now)).toBe(true);
    expect(auth.verifyState(st, new Date(now.getTime() + 11 * 60_000))).toBe(false);
    expect(auth.verifyState(`${st}x`, now)).toBe(false);
  });
});

describe('api key', () => {
  it('hash is stable and hex', () => {
    const h = auth.hashApiKey('ak_test');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.hashApiKey('ak_test')).toBe(h);
  });
  it('authorize url points at LINE with our redirect', () => {
    const u = new URL(auth.lineAuthorizeUrl('state123'));
    expect(u.origin).toBe('https://access.line.me');
    expect(u.searchParams.get('client_id')).toBe('1234567890');
    expect(u.searchParams.get('redirect_uri')).toBe('https://example.test/api/auth/line/callback');
    expect(u.searchParams.get('scope')).toBe('profile openid');
  });
});
