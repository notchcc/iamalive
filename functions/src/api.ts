/**
 * HTTP API（Hosting rewrite `/api/**` → 此 Function）。寫入端點需 `X-Write-Token`。
 */
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { WRITE_TOKEN, familyUrl } from './config.js';
import { Timestamp, getLineConfig, lineConfigRef, tripsCol } from './db.js';
import { MONTHLY_QUOTA } from './line.js';
import {
  HttpError,
  addWatcher,
  createTrip,
  endTrip,
  getActiveTrip,
  listWatchers,
  recordCheckin,
  removeWatcher,
  requireActiveTrip,
  setFlights,
  setOffline,
} from './trips.js';
import { fmtDateTime, isValidTz, monthKey, zonedToUtc } from './time.js';
import type { FlightSegment } from './types.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function requireWriteToken(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('x-write-token') ?? '';
  const bearer = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const provided = header || bearer;
  if (!safeEqual(provided, WRITE_TOKEN.value())) {
    next(new HttpError(401, 'UNAUTHORIZED'));
    return;
  }
  next();
}

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const CheckinSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().nullable().optional(),
  source: z.enum(['shortcut', 'line', 'web-gps', 'manual']).default('shortcut'),
  note: z.string().max(200).optional().default(''),
  nextHours: z.number().min(1).max(168).nullable().optional(),
  clientAt: isoDate.nullable().optional(),
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
const WatcherSchema = z.object({ label: z.string().min(1).max(20) });

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
  };
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

  r.use(requireWriteToken);

  r.get(
    '/status',
    wrap(async (_req, res) => {
      const cfg = await getLineConfig();
      const active = await getActiveTrip();
      const key = monthKey(new Date());
      res.json({
        groupBound: Boolean(cfg.groupId),
        joinedAt: cfg.joinedAt ? cfg.joinedAt.toDate().toISOString() : null,
        monthKey: key,
        pushCount: cfg.monthKey === key ? cfg.pushCount : 0,
        monthlyQuota: MONTHLY_QUOTA,
        activeTrip: active ? tripJson(active.id, active.data()) : null,
      });
    }),
  );

  r.get(
    '/trips/active',
    wrap(async (_req, res) => {
      const active = await getActiveTrip();
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
      const q = await tripsCol.orderBy('createdAt', 'desc').limit(20).get();
      res.json(q.docs.map((d) => tripJson(d.id, d.data())));
    }),
  );

  r.post(
    '/trips',
    wrap(async (req, res) => {
      const input = CreateTripSchema.parse(req.body);
      const { id, trip, url } = await createTrip(input);
      res.status(201).json({ ...tripJson(id, trip), familyUrl: url });
    }),
  );

  r.post(
    '/checkin',
    wrap(async (req, res) => {
      const input = CheckinSchema.parse(req.body);
      const trip = await requireActiveTrip();
      const result = await recordCheckin(trip, {
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy ?? null,
        source: input.source,
        note: input.note,
        nextHours: input.nextHours ?? null,
        clientAt: input.clientAt ?? null,
      });
      res.json({
        ok: true,
        nextDeadlineAt: result.nextDeadlineAt.toISOString(),
        tz: result.tz,
        pushed: result.pushed,
        recovered: result.recovered,
      });
    }),
  );

  r.post(
    '/trips/:id/offline',
    wrap(async (req, res) => {
      const { hours } = OfflineSchema.parse(req.body);
      const trip = await requireTrip(req.params.id);
      const out = await setOffline(trip, hours);
      res.json({
        ok: true,
        offlineUntil: out.offlineUntil.toISOString(),
        nextDeadlineAt: out.nextDeadlineAt.toISOString(),
        pushed: out.pushed,
      });
    }),
  );

  r.put(
    '/trips/:id/flights',
    wrap(async (req, res) => {
      const { flights } = FlightsSchema.parse(req.body);
      const trip = await requireTrip(req.params.id);
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
      const trip = await requireTrip(req.params.id);
      const out = await endTrip(trip, '旅行者已手動結案');
      res.json({ ok: true, pushed: out.pushed });
    }),
  );

  r.get(
    '/trips/:id/watchers',
    wrap(async (req, res) => {
      const trip = await requireTrip(req.params.id, false);
      res.json(await listWatchers(trip.data()));
    }),
  );

  r.post(
    '/trips/:id/watchers',
    wrap(async (req, res) => {
      const { label } = WatcherSchema.parse(req.body);
      const trip = await requireTrip(req.params.id, false);
      res.status(201).json(await addWatcher(trip, label));
    }),
  );

  r.delete(
    '/trips/:id/watchers/:token',
    wrap(async (req, res) => {
      const trip = await requireTrip(req.params.id, false);
      await removeWatcher(trip, req.params.token);
      res.json({ ok: true });
    }),
  );

  /** 手動綁定群組（從 log 取得 groupId 時用）。 */
  r.post(
    '/line/bind',
    wrap(async (req, res) => {
      const { groupId } = z.object({ groupId: z.string().regex(/^C[0-9a-f]{32}$/) }).parse(req.body);
      await lineConfigRef.set({ groupId, joinedAt: Timestamp.now() }, { merge: true });
      res.json({ ok: true });
    }),
  );

  /** 解除群組綁定（bot 被拉錯群組時用），之後重新邀請即可重綁。 */
  r.post(
    '/line/unbind',
    wrap(async (_req, res) => {
      await lineConfigRef.set({ groupId: null, joinedAt: null }, { merge: true });
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

async function requireTrip(id: string, mustBeActive = true) {
  const snap = await tripsCol.doc(id).get();
  if (!snap.exists) throw new HttpError(404, 'TRIP_NOT_FOUND');
  if (mustBeActive && snap.data()?.status !== 'active') throw new HttpError(409, 'TRIP_NOT_ACTIVE');
  return snap as FirebaseFirestore.QueryDocumentSnapshot<import('./types.js').Trip>;
}
