/**
 * 認證：LINE Login（人）與 API 金鑰（捷徑）。
 *
 * - 人：LINE Login 授權碼流程 → 驗 ID token → 簽發 30 天 session JWT，放在 `__session` cookie
 *   （Firebase Hosting 只轉送這個名稱的 cookie 給 Functions）。
 * - 機器：`X-Api-Key: ak_...`，只存 SHA-256 雜湊，可個別撤銷。
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from 'firebase-functions/v2';
import { LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET, PUBLIC_BASE_URL, SESSION_SECRET } from './config.js';
import { FieldValue, Timestamp, apiKeysCol, usersCol } from './db.js';
import { HttpError } from './errors.js';
import type { ApiKey } from './types.js';

export const SESSION_COOKIE = '__session';
export const SESSION_DAYS = 30;
const STATE_TTL_MS = 10 * 60_000;

export type AuthKind = 'session' | 'apikey';
export interface AuthInfo {
  uid: string;
  kind: AuthKind;
}

// ---------- 小工具 ----------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}
function secretOr(param: { value: () => string }, fallback: string): string {
  try {
    return param.value() || fallback;
  } catch {
    return fallback;
  }
}
function sessionSecret(): string {
  const s = secretOr(SESSION_SECRET, '');
  if (!s) throw new Error('SESSION_SECRET not configured');
  return s;
}

// ---------- session JWT（HS256，無外部相依） ----------

export interface SessionClaims {
  uid: string;
  name: string;
  iat: number;
  exp: number;
}

export function signSession(uid: string, name: string, now = new Date()): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now.getTime() / 1000);
  const payload = b64url(JSON.stringify({ uid, name, iat, exp: iat + SESSION_DAYS * 86400 } satisfies SessionClaims));
  const sig = hmac(sessionSecret(), `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

export function verifySession(token: string, now = new Date()): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!safeEq(hmac(sessionSecret(), `${h}.${p}`), s)) return null;
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.uid !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < now.getTime()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------- OAuth state（帶簽章與時效，不需 cookie） ----------

export function makeState(now = new Date()): string {
  const body = `${randomBytes(12).toString('base64url')}.${now.getTime()}`;
  return `${body}.${hmac(sessionSecret(), body)}`;
}

export function verifyState(state: string, now = new Date()): boolean {
  const i = state.lastIndexOf('.');
  if (i < 0) return false;
  const body = state.slice(0, i);
  const sig = state.slice(i + 1);
  if (!safeEq(hmac(sessionSecret(), body), sig)) return false;
  const ts = Number(body.split('.')[1]);
  return Number.isFinite(ts) && now.getTime() - ts < STATE_TTL_MS && now.getTime() >= ts - 60_000;
}

// ---------- cookie ----------

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(value: string, maxAgeSec: number): string {
  const secure = !isEmulator();
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

// ---------- LINE Login ----------

export function lineRedirectUri(): string {
  return `${PUBLIC_BASE_URL.value().replace(/\/+$/, '')}/api/auth/line/callback`;
}

export function lineAuthorizeUrl(state: string): string {
  const u = new URL('https://access.line.me/oauth2/v2.1/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', LINE_LOGIN_CHANNEL_ID.value());
  u.searchParams.set('redirect_uri', lineRedirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('scope', 'profile openid');
  return u.toString();
}

export interface LineProfile {
  userId: string;
  displayName: string;
  pictureUrl: string | null;
}

/** 授權碼 → token → 驗 ID token（含 aud）→ 使用者資料。 */
export async function lineExchangeCode(code: string): Promise<LineProfile> {
  const clientId = LINE_LOGIN_CHANNEL_ID.value();
  const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: lineRedirectUri(),
      client_id: clientId,
      client_secret: LINE_LOGIN_CHANNEL_SECRET.value(),
    }),
  });
  if (!tokenRes.ok) {
    logger.warn('line token exchange failed', { status: tokenRes.status, body: await tokenRes.text() });
    throw new HttpError(401, 'LINE_TOKEN_EXCHANGE_FAILED');
  }
  const tok = (await tokenRes.json()) as { id_token?: string };
  if (!tok.id_token) throw new HttpError(401, 'LINE_NO_ID_TOKEN');

  const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: tok.id_token, client_id: clientId }),
  });
  if (!verifyRes.ok) {
    logger.warn('line id token verify failed', { status: verifyRes.status, body: await verifyRes.text() });
    throw new HttpError(401, 'LINE_ID_TOKEN_INVALID');
  }
  const claims = (await verifyRes.json()) as { sub: string; aud: string; name?: string; picture?: string };
  if (claims.aud !== clientId || !claims.sub) throw new HttpError(401, 'LINE_ID_TOKEN_INVALID');
  return { userId: claims.sub, displayName: claims.name ?? 'LINE 使用者', pictureUrl: claims.picture ?? null };
}

export async function upsertUser(p: LineProfile): Promise<void> {
  const ref = usersCol.doc(p.userId);
  const snap = await ref.get();
  const now = Timestamp.now();
  if (snap.exists) {
    await ref.update({ displayName: p.displayName, pictureUrl: p.pictureUrl, lastLoginAt: now });
  } else {
    await ref.set({ displayName: p.displayName, pictureUrl: p.pictureUrl, createdAt: now, lastLoginAt: now });
  }
}

// ---------- API 金鑰 ----------

export const API_KEY_PREFIX = 'ak_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(uid: string, label: string): Promise<{ key: string; id: string }> {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  const id = hashApiKey(key);
  const doc: ApiKey = { uid, label, prefix: key.slice(0, 8), createdAt: Timestamp.now(), lastUsedAt: null };
  await apiKeysCol.doc(id).set(doc);
  return { key, id };
}

export async function listApiKeys(uid: string): Promise<Array<ApiKey & { id: string }>> {
  const q = await apiKeysCol.where('uid', '==', uid).get();
  return q.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
}

export async function revokeApiKey(uid: string, id: string): Promise<void> {
  const ref = apiKeysCol.doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.uid !== uid) throw new HttpError(404, 'KEY_NOT_FOUND');
  await ref.delete();
}

async function resolveApiKey(key: string): Promise<string | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length < 20 || key.length > 80) return null;
  const ref = apiKeysCol.doc(hashApiKey(key));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  // lastUsedAt 每小時最多寫一次
  if (!data.lastUsedAt || Date.now() - data.lastUsedAt.toMillis() > 3_600_000) {
    void ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
  }
  return data.uid;
}

// ---------- 中介層 ----------

/** 解析身分（不強制）。結果放在 res.locals.auth。 */
export async function resolveAuth(req: Request): Promise<AuthInfo | null> {
  const apiKey = req.header('x-api-key') ?? (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (apiKey) {
    const uid = await resolveApiKey(apiKey);
    if (uid) return { uid, kind: 'apikey' };
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const claims = verifySession(cookie);
    if (claims) return { uid: claims.uid, kind: 'session' };
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  resolveAuth(req)
    .then((auth) => {
      if (!auth) {
        next(new HttpError(401, 'UNAUTHORIZED'));
        return;
      }
      // cookie 身分的變更請求需為同站（CSRF）
      if (auth.kind === 'session' && req.method !== 'GET' && req.method !== 'HEAD') {
        const site = req.header('sec-fetch-site');
        const origin = req.header('origin');
        const host = req.header('x-forwarded-host') ?? req.header('host') ?? '';
        const sameOrigin = origin ? new URL(origin).host === host : true;
        if ((site && site !== 'same-origin' && site !== 'none') || !sameOrigin) {
          next(new HttpError(403, 'CSRF'));
          return;
        }
      }
      res.locals.auth = auth;
      next();
    })
    .catch(next);
}

export function uidOf(res: Response): string {
  const auth = res.locals.auth as AuthInfo | undefined;
  if (!auth) throw new HttpError(401, 'UNAUTHORIZED');
  return auth.uid;
}
