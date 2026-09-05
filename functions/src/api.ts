/**
 * HTTP API（Hosting rewrite `/api/**` → 此 Function）。
 * 公開：/health、/p/*（家人頁取圖）、/auth/line/*。其餘需 session cookie 或 X-Api-Key。
 */
import { randomInt } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { checkinUrl, familyUrl } from './config.js';
import { Timestamp, bindCodesCol, getLineConfig, groupIdForOwner, groupsCol, tripsCol, usersCol } from './db.js';
import { MONTHLY_QUOTA } from './line.js';
import {
  SESSION_DAYS,
  createApiKey,
  isEmulator,
  lineAuthorizeUrl,
  lineExchangeCode,
  lineVerifyIdToken,
  listApiKeys,
  makeState,
  requireAuth,
  revokeApiKey,
  sessionCookie,
  signSession,
  uidOf,
  upsertUser,
  verifyState,
  type AuthInfo,
} from './auth.js';
import {
  HttpError,
  createTrip,
  deleteCheckin,
  recentForTrip,
  endTrip,
  resyncTrip,
  getActiveTrip,
  recordCheckin,
  requireActiveTrip,
  setFlights,
  setIntervalHours,
  setOffline,
  ensureCheckinToken,
  rotateCheckinToken,
  getTripByCheckinToken,
} from './trips.js';
import { fmtDateTime, isValidTz, monthKey, zonedToUtc } from './time.js';
import type { FlightSegment } from './types.js';
import { parseMultipart } from './multipart.js';
import { lookupFlight } from './flights-api.js';
import { MAX_PHOTO_BYTES, isAllowedImage, readPhoto, savePhoto } from './photos.js';
import { viewsCol } from './db.js';

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const CheckinSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullable().optional(),
  source: z.enum(['shortcut', 'line', 'web-gps', 'manual', 'photo']).default('shortcut'),
  note: z.string().max(200).optional().default(''),
  nextHours: z.number().min(1).max(168).nullable().optional(),
  clientAt: isoDate.nullable().optional(),
});

/** multipart 欄位皆為字串，先轉型再套用同一套規則。 */
const PhotoFieldsSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().nonnegative().optional(),
  note: z.string().max(200).optional().default(''),
  nextHours: z.coerce.number().min(1).max(168).optional(),
  takenAt: isoDate.optional(),
  clientAt: isoDate.optional(),
});

const CreateTripSchema = z
  .object({
    title: z.string().min(1).max(60),
    startAt: isoDate,
    endAt: isoDate,
    intervalHours: z.number().min(1).max(72),
  })
  .refine((v) => v.endAt > v.startAt, { message: 'endAt must be after startAt' });

const OfflineSchema = z.object({ hours: z.number().min(1).max(168) });
const PatchTripSchema = z.object({ intervalHours: z.number().int().min(1).max(72) });

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/, 'YYYY-MM-DDTHH:mm');
const tzString = z.string().min(1).max(64).refine(isValidTz, 'invalid IANA timezone');
const FlightInputSchema = z
  .object({
    flightNo: z.string().trim().min(2).max(10),
    fromCity: z.string().trim().min(1).max(30),
    fromTz: tzString,
    departLocal: localDateTime,
    toCity: z.string().trim().min(1).max(30),
    toTz: tzString,
    arriveLocal: localDateTime,
  })
  .transform((f) => ({
    flightNo: f.flightNo.toUpperCase(),
    fromCity: f.fromCity,
    fromTz: f.fromTz,
    departAt: zonedToUtc(f.departLocal, f.fromTz),
    toCity: f.toCity,
    toTz: f.toTz,
    arriveAt: zonedToUtc(f.arriveLocal, f.toTz),
  }))
  .refine((f) => f.arriveAt > f.departAt, { message: 'arrive must be after depart' })
  .refine((f) => f.arriveAt.getTime() - f.departAt.getTime() <= 30 * 3600e3, { message: 'segment longer than 30h' });
const FlightsSchema = z.object({ flights: z.array(FlightInputSchema).max(20) });

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

function flightJson(f: FlightSegment) {
  return {
    flightNo: f.flightNo,
    fromCity: f.fromCity,
    fromTz: f.fromTz,
    departAt: f.departAt.toDate().toISOString(),
    departLocal: fmtDateTime(f.departAt.toDate(), f.fromTz),
    toCity: f.toCity,
    toTz: f.toTz,
    arriveAt: f.arriveAt.toDate().toISOString(),
    arriveLocal: fmtDateTime(f.arriveAt.toDate(), f.toTz),
  };
}

function tripJson(id: string, t: FirebaseFirestore.DocumentData) {
  const ts = (v: Timestamp | null | undefined) => (v ? v.toDate().toISOString() : null);
  return {
    flights: ((t.flights ?? []) as FlightSegment[]).map(flightJson),
    id,
    title: t.title,
    status: t.status,
    startAt: ts(t.startAt),
    endAt: ts(t.endAt),
    intervalHours: t.intervalHours,
    travelerTz: t.travelerTz,
    lastCheckinAt: ts(t.lastCheckinAt),
    lastCheckinGeo: t.lastCheckinGeo ? { lat: t.lastCheckinGeo.latitude, lng: t.lastCheckinGeo.longitude } : null,
    lastCheckinPlace: t.lastCheckinPlace ?? null,
    nextDeadlineAt: ts(t.nextDeadlineAt),
    offlineUntil: ts(t.offlineUntil),
    alerted: t.alerted,
    alertCount: t.alertCount,
    groupReadToken: t.groupReadToken,
    familyUrl: familyUrl(t.groupReadToken),
    checkinToken: t.checkinToken ?? null,
    checkinUrl: t.checkinToken ? checkinUrl(t.checkinToken) : null,
  };
}

/** 免登入打卡頁看得到的行程資訊（不含 token、家人連結）。 */
function checkinPageJson(t: FirebaseFirestore.DocumentData) {
  const ts = (v: Timestamp | null | undefined) => (v ? v.toDate().toISOString() : null);
  return {
    title: t.title,
    status: t.status,
    intervalHours: t.intervalHours,
    travelerTz: t.travelerTz,
    lastCheckinAt: ts(t.lastCheckinAt),
    lastCheckinPlace: t.lastCheckinPlace ?? null,
    nextDeadlineAt: ts(t.nextDeadlineAt),
    offlineUntil: ts(t.offlineUntil),
    alerted: t.alerted,
  };
}

type ActiveTripSnap = FirebaseFirestore.QueryDocumentSnapshot<import('./types.js').Trip>;

/** JSON 打卡（登入 / 金鑰 / 打卡頁 token 三條路共用）。 */
async function jsonCheckin(trip: ActiveTripSnap, body: unknown) {
  const input = CheckinSchema.parse(body);
  const result = await recordCheckin(trip, {
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy ?? null,
    source: input.source,
    note: input.note,
    nextHours: input.nextHours ?? null,
    clientAt: input.clientAt ?? null,
  });
  return { ok: true as const, nextDeadlineAt: result.nextDeadlineAt.toISOString(), tz: result.tz, pushed: result.pushed, recovered: result.recovered };
}

/** 照片打卡：multipart/form-data，欄位 photo（檔案）+ lat/lng/note/nextHours/takenAt。 */
async function photoCheckin(req: Request, trip: ActiveTripSnap) {
  let parsed;
  try {
    parsed = await parseMultipart(req, MAX_PHOTO_BYTES);
  } catch (e) {
    throw new HttpError(String((e as Error).message) === 'FILE_TOO_LARGE' ? 413 : 400, String((e as Error).message));
  }
  if (!parsed.file || parsed.file.data.length === 0) throw new HttpError(400, 'PHOTO_REQUIRED');
  if (!isAllowedImage(parsed.file.mimeType)) throw new HttpError(415, 'UNSUPPORTED_IMAGE_TYPE');
  const f = PhotoFieldsSchema.parse(parsed.fields);
  const photoId = await savePhoto(trip.id, parsed.file.data, parsed.file.mimeType);
  const result = await recordCheckin(trip, {
    lat: f.lat,
    lng: f.lng,
    accuracy: f.accuracy ?? null,
    source: 'photo',
    note: f.note,
    nextHours: f.nextHours ?? null,
    clientAt: f.clientAt ?? null,
    photoId,
    takenAt: f.takenAt ?? null,
  });
  return { ok: true as const, photoId, nextDeadlineAt: result.nextDeadlineAt.toISOString(), tz: result.tz, pushed: result.pushed, recovered: result.recovered };
}

const CHECKIN_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 打卡頁 token → active 行程；找不到 404、已結案 410。 */
async function requireTripByCheckinToken(token: string): Promise<ActiveTripSnap> {
  if (!CHECKIN_TOKEN_RE.test(token)) throw new HttpError(404, 'TRIP_NOT_FOUND');
  const snap = await getTripByCheckinToken(token);
  if (!snap) throw new HttpError(404, 'TRIP_NOT_FOUND');
  if (snap.data().status !== 'active') throw new HttpError(410, 'TRIP_ENDED');
  return snap as ActiveTripSnap;
}

/** 同站檢查（cookie 相關的公開端點用）。 */
function assertSameSite(req: Request): void {
  const site = req.header('sec-fetch-site');
  const origin = req.header('origin');
  const host = req.header('x-forwarded-host') ?? req.header('host') ?? '';
  const sameOrigin = origin ? new URL(origin).host === host : true;
  if ((site && site !== 'same-origin' && site !== 'none') || !sameOrigin) throw new HttpError(403, 'CSRF');
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  const r = express.Router();

  r.get(
    '/health',
    wrap(async (_req, res) => {
      res.json({ ok: true });
    }),
  );

  /** 家人頁取圖：以 readToken 驗證，不需寫入 token。 */
  r.get(
    '/p/:token/:photoId',
    wrap(async (req, res) => {
      const token = String(req.params.token);
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
        res.status(404).end();
        return;
      }
      const view = await viewsCol.doc(token).get();
      const tripId = view.data()?.tripId;
      if (!tripId) {
        res.status(404).end();
        return;
      }
      const photo = await readPhoto(tripId, String(req.params.photoId));
      if (!photo) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', photo.contentType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(photo.data);
    }),
  );

  // ---------- LINE Login ----------
  r.get(
    '/auth/line/start',
    wrap(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, lineAuthorizeUrl(makeState()));
    }),
  );

  r.get(
    '/auth/line/callback',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const { code, state, error } = req.query as Record<string, string | undefined>;
      if (error) {
        res.redirect(302, `/me?login=denied`);
        return;
      }
      if (!code || !state || !verifyState(state)) {
        res.redirect(302, `/me?login=invalid`);
        return;
      }
      const profile = await lineExchangeCode(code);
      await upsertUser(profile);
      res.setHeader('Set-Cookie', sessionCookie(signSession(profile.userId, profile.displayName), SESSION_DAYS * 86400));
      res.redirect(302, '/me');
    }),
  );

  /** LIFF：前端 liff.getIDToken() → 驗證 → 同一種 session cookie。 */
  r.post(
    '/auth/liff',
    wrap(async (req, res) => {
      assertSameSite(req);
      const { idToken } = z.object({ idToken: z.string().min(20).max(4096) }).parse(req.body);
      const profile = await lineVerifyIdToken(idToken);
      await upsertUser(profile);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', sessionCookie(signSession(profile.userId, profile.displayName), SESSION_DAYS * 86400));
      res.json({ ok: true, uid: profile.userId, displayName: profile.displayName, pictureUrl: profile.pictureUrl });
    }),
  );

  // ---------- 免登入打卡頁 /c/{token}（能力型 token，僅能看該行程摘要與打卡） ----------
  r.get(
    '/c/:token',
    wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const snap = await requireTripByCheckinToken(req.params.token);
      res.json(checkinPageJson(snap.data()));
    }),
  );
  r.post(
    '/c/:token/checkin',
    wrap(async (req, res) => {
      const snap = await requireTripByCheckinToken(req.params.token);
      res.json(await jsonCheckin(snap, req.body));
    }),
  );
  r.post(
    '/c/:token/checkin/photo',
    wrap(async (req, res) => {
      const snap = await requireTripByCheckinToken(req.params.token);
      res.json(await photoCheckin(req, snap));
    }),
  );

  r.post(
    '/auth/logout',
    wrap(async (_req, res) => {
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      res.json({ ok: true });
    }),
  );

  /** 只在 emulator 註冊：測試用登入。 */
  if (isEmulator()) {
    r.post(
      '/auth/dev-login',
      wrap(async (req, res) => {
        const { uid, name } = z.object({ uid: z.string().min(3), name: z.string().default('測試者') }).parse(req.body);
        await upsertUser({ userId: uid, displayName: name, pictureUrl: null });
        res.setHeader('Set-Cookie', sessionCookie(signSession(uid, name), SESSION_DAYS * 86400));
        res.json({ ok: true, uid });
      }),
    );
  }

  r.use(requireAuth);

  r.get(
    '/auth/me',
    wrap(async (_req, res) => {
      const auth = res.locals.auth as AuthInfo;
      const u = (await usersCol.doc(auth.uid).get()).data();
      res.json({ uid: auth.uid, kind: auth.kind, displayName: u?.displayName ?? null, pictureUrl: u?.pictureUrl ?? null });
    }),
  );

  r.get(
    '/status',
    wrap(async (_req, res) => {
      const uid = uidOf(res);
      const [cfg, groupId, active, user] = await Promise.all([
        getLineConfig(),
        groupIdForOwner(uid),
        getActiveTrip(uid),
        usersCol.doc(uid).get(),
      ]);
      const key = monthKey(new Date());
      const auth = res.locals.auth as AuthInfo;
      const checkinToken = active ? await ensureCheckinToken(active) : null;
      res.json({
        user: { uid, kind: auth.kind, displayName: user.data()?.displayName ?? null, pictureUrl: user.data()?.pictureUrl ?? null },
        groupBound: Boolean(groupId),
        monthKey: key,
        pushCount: cfg.monthKey === key ? cfg.pushCount : 0,
        monthlyQuota: MONTHLY_QUOTA,
        activeTrip: active ? tripJson(active.id, { ...active.data(), checkinToken }) : null,
      });
    }),
  );

  // ---------- API 金鑰 ----------
  r.get(
    '/keys',
    wrap(async (_req, res) => {
      const keys = await listApiKeys(uidOf(res));
      res.json(
        keys.map((k) => ({
          id: k.id,
          label: k.label,
          prefix: k.prefix,
          createdAt: k.createdAt.toDate().toISOString(),
          lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toDate().toISOString() : null,
        })),
      );
    }),
  );

  r.post(
    '/keys',
    wrap(async (req, res) => {
      const { label } = z.object({ label: z.string().trim().min(1).max(30) }).parse(req.body);
      const uid = uidOf(res);
      if ((await listApiKeys(uid)).length >= 10) throw new HttpError(409, 'TOO_MANY_KEYS');
      const { key, id } = await createApiKey(uid, label);
      res.status(201).json({ id, key, label });
    }),
  );

  r.delete(
    '/keys/:id',
    wrap(async (req, res) => {
      await revokeApiKey(uidOf(res), String(req.params.id));
      res.json({ ok: true });
    }),
  );

  // ---------- 群組綁定 ----------
  r.post(
    '/line/bind-code',
    wrap(async (_req, res) => {
      const uid = uidOf(res);
      // 清掉這個人先前未用的碼
      const old = await bindCodesCol.where('uid', '==', uid).get();
      await Promise.all(old.docs.map((d) => d.ref.delete()));
      let code = '';
      for (let i = 0; i < 5; i++) {
        code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        if (!(await bindCodesCol.doc(code).get()).exists) break;
      }
      const expiresAt = Timestamp.fromMillis(Date.now() + 10 * 60_000);
      await bindCodesCol.doc(code).set({ uid, expiresAt });
      res.json({ code, expiresAt: expiresAt.toDate().toISOString() });
    }),
  );

  r.post(
    '/line/unbind',
    wrap(async (_req, res) => {
      const uid = uidOf(res);
      const q = await groupsCol.where('ownerUid', '==', uid).get();
      await Promise.all(q.docs.map((d) => d.ref.delete()));
      res.json({ ok: true });
    }),
  );

  r.get(
    '/trips/active',
    wrap(async (_req, res) => {
      const active = await getActiveTrip(uidOf(res));
      if (!active) {
        res.status(404).json({ error: 'NO_ACTIVE_TRIP' });
        return;
      }
      res.json(tripJson(active.id, active.data()));
    }),
  );

  r.get(
    '/trips',
    wrap(async (_req, res) => {
      const q = await tripsCol.where('ownerUid', '==', uidOf(res)).orderBy('createdAt', 'desc').limit(20).get();
      res.json(q.docs.map((d) => tripJson(d.id, d.data())));
    }),
  );

  r.post(
    '/trips',
    wrap(async (req, res) => {
      const input = CreateTripSchema.parse(req.body);
      const { id, trip, url } = await createTrip(uidOf(res), input);
      res.status(201).json({ ...tripJson(id, trip), familyUrl: url });
    }),
  );

  r.post(
    '/checkin',
    wrap(async (req, res) => {
      const trip = await requireActiveTrip(uidOf(res));
      res.json(await jsonCheckin(trip, req.body));
    }),
  );

  r.post(
    '/checkin/photo',
    wrap(async (req, res) => {
      const trip = await requireActiveTrip(uidOf(res));
      res.json(await photoCheckin(req, trip));
    }),
  );

  /** 輪替免登入打卡頁 token：舊的主畫面捷徑立即失效。 */
  r.post(
    '/trips/:id/checkin-token/rotate',
    wrap(async (req, res) => {
      const trip = await requireTrip(uidOf(res), req.params.id);
      const token = await rotateCheckinToken(trip);
      res.json({ ok: true, checkinToken: token, checkinUrl: checkinUrl(token) });
    }),
  );

  /** 行程中更改打卡頻率：立即重算期限（見 setIntervalHours）。 */
  r.patch(
    '/trips/:id',
    wrap(async (req, res) => {
      const { intervalHours } = PatchTripSchema.parse(req.body);
      const trip = await requireTrip(uidOf(res), req.params.id);
      const out = await setIntervalHours(trip, intervalHours);
      res.json({ ok: true, intervalHours: out.intervalHours, nextDeadlineAt: out.nextDeadlineAt.toISOString() });
    }),
  );

  r.post(
    '/trips/:id/offline',
    wrap(async (req, res) => {
      const { hours } = OfflineSchema.parse(req.body);
      const trip = await requireTrip(uidOf(res), req.params.id);
      const out = await setOffline(trip, hours);
      res.json({
        ok: true,
        offlineUntil: out.offlineUntil.toISOString(),
        nextDeadlineAt: out.nextDeadlineAt.toISOString(),
        pushed: out.pushed,
      });
    }),
  );

  /** 航班查詢（AeroDataBox）：回傳該班號當日各航段，供前端帶入表單。 */
  r.get(
    '/flights/lookup',
    wrap(async (req, res) => {
      const q = z
        .object({
          flightNo: z.string().trim().regex(/^[A-Za-z0-9]{2,3}\s?\d{1,4}[A-Za-z]?$/, 'flight number like BR61'),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
        })
        .parse(req.query);
      const legs = await lookupFlight(q.flightNo, q.date);
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.json({ legs });
    }),
  );

  r.put(
    '/trips/:id/flights',
    wrap(async (req, res) => {
      const { flights } = FlightsSchema.parse(req.body);
      const trip = await requireTrip(uidOf(res), req.params.id);
      const saved = await setFlights(
        trip,
        flights.map((f) => ({ ...f, departAt: Timestamp.fromDate(f.departAt), arriveAt: Timestamp.fromDate(f.arriveAt) })),
      );
      res.json({ ok: true, flights: saved.map(flightJson) });
    }),
  );

  r.post(
    '/trips/:id/end',
    wrap(async (req, res) => {
      const trip = await requireTrip(uidOf(res), req.params.id);
      const out = await endTrip(trip, '旅行者已手動結案');
      res.json({ ok: true, pushed: out.pushed });
    }),
  );

  /** 打卡清單（新到舊），給 /me 打卡管理頁籤。 */
  r.get(
    '/trips/:id/checkins',
    wrap(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit);
      const trip = await requireTrip(uidOf(res), req.params.id, false);
      const items = await recentForTrip(trip.id, limit);
      res.json(
        items.map((it) => ({
          id: it.id,
          lat: it.lat,
          lng: it.lng,
          acc: it.acc,
          src: it.src,
          tz: it.tz,
          place: it.place ?? null,
          note: it.note,
          photoId: it.photoId ?? null,
          takenAt: it.takenAt ? it.takenAt.toDate().toISOString() : null,
          at: it.at.toDate().toISOString(),
        })),
      );
    }),
  );

  r.delete(
    '/trips/:id/checkins/:checkinId',
    wrap(async (req, res) => {
      const trip = await requireTrip(uidOf(res), req.params.id, false);
      await deleteCheckin(trip, String(req.params.checkinId));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/trips/:id/resync',
    wrap(async (req, res) => {
      const trip = await requireTrip(uidOf(res), req.params.id, false);
      await resyncTrip(trip);
      res.json({ ok: true });
    }),
  );

  app.use('/api', r);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'VALIDATION', issues: err.issues });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'BAD_JSON' });
      return;
    }
    logger.error('api error', { err: String(err) });
    res.status(500).json({ error: 'INTERNAL' });
  });

  return app;
}

async function requireTrip(uid: string, id: string, mustBeActive = true) {
  const snap = await tripsCol.doc(id).get();
  // 不是自己的行程一律 404，避免列舉
  if (!snap.exists || snap.data()?.ownerUid !== uid) throw new HttpError(404, 'TRIP_NOT_FOUND');
  if (mustBeActive && snap.data()?.status !== 'active') throw new HttpError(409, 'TRIP_NOT_ACTIVE');
  return snap as FirebaseFirestore.QueryDocumentSnapshot<import('./types.js').Trip>;
}
