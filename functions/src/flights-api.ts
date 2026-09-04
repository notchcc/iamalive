/**
 * 航班查詢：AeroDataBox（RapidAPI）。輸入航班號碼 + 日期，回傳各航段的起降機場、時區、表定時間。
 * 結果以「航班_日期」快取 12 小時，省額度。emulator 或未設金鑰時提供固定樣本（E2E1）。
 */
import { logger } from 'firebase-functions/v2';
import { RAPIDAPI_KEY } from './config.js';
import { Timestamp, db } from './db.js';
import { HttpError } from './errors.js';
import { tzLabel } from './time.js';

export interface FlightLeg {
  flightNo: string;
  airline: string | null;
  status: string | null;
  fromIata: string;
  fromCity: string;
  fromTz: string;
  /** YYYY-MM-DDTHH:mm（起飛地當地） */
  departLocal: string;
  departUtc: string;
  toIata: string;
  toCity: string;
  toTz: string;
  arriveLocal: string;
  arriveUtc: string;
}

const CACHE_TTL_MS = 12 * 3_600_000;
const HOST = 'aerodatabox.p.rapidapi.com';

interface AdbTime {
  utc?: string;
  local?: string;
}
interface AdbEnd {
  airport?: { iata?: string; icao?: string; name?: string; municipalityName?: string; timeZone?: string };
  scheduledTime?: AdbTime;
  revisedTime?: AdbTime;
}
interface AdbFlight {
  number?: string;
  status?: string;
  codeshareStatus?: string;
  isCargo?: boolean;
  airline?: { name?: string };
  departure?: AdbEnd;
  arrival?: AdbEnd;
}

export function normalizeFlightNo(input: string): string {
  return input.toUpperCase().replace(/\s+/g, '');
}

/** "2026-09-05 22:40+08:00" → "2026-09-05T22:40" */
function localPart(s: string | undefined): string | null {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : null;
}
/** "2026-09-05 14:40Z" → ISO */
function utcIso(s: string | undefined): string | null {
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}:00Z`).toISOString() : null;
}

function cityName(tz: string | undefined, apiCity: string | undefined, iata: string): string {
  if (tz) {
    const label = tzLabel(tz);
    // tzLabel 對未知時區回傳 IANA 最後一段（英文），此時優先用 API 的城市名
    if (!/^[A-Za-z_ ]+$/.test(label)) return label;
  }
  return apiCity || iata;
}

function toLegs(raw: AdbFlight[]): FlightLeg[] {
  const legs: FlightLeg[] = [];
  for (const f of raw) {
    if (f.isCargo) continue;
    const d = f.departure;
    const a = f.arrival;
    const fromTz = d?.airport?.timeZone;
    const toTz = a?.airport?.timeZone;
    const departLocal = localPart(d?.scheduledTime?.local);
    const arriveLocal = localPart(a?.scheduledTime?.local);
    const departUtc = utcIso(d?.scheduledTime?.utc);
    const arriveUtc = utcIso(a?.scheduledTime?.utc);
    if (!fromTz || !toTz || !departLocal || !arriveLocal || !departUtc || !arriveUtc) continue;
    const fromIata = d?.airport?.iata ?? d?.airport?.icao ?? '???';
    const toIata = a?.airport?.iata ?? a?.airport?.icao ?? '???';
    legs.push({
      flightNo: normalizeFlightNo(f.number ?? ''),
      airline: f.airline?.name ?? null,
      status: f.status ?? null,
      fromIata,
      fromCity: cityName(fromTz, d?.airport?.municipalityName, fromIata),
      fromTz,
      departLocal,
      departUtc,
      toIata,
      toCity: cityName(toTz, a?.airport?.municipalityName, toIata),
      toTz,
      arriveLocal,
      arriveUtc,
    });
  }
  legs.sort((x, y) => x.departUtc.localeCompare(y.departUtc));
  return legs;
}

function stubLegs(flightNo: string, date: string): FlightLeg[] {
  return [
    {
      flightNo,
      airline: 'E2E Air',
      status: 'Expected',
      fromIata: 'TPE',
      fromCity: '台北',
      fromTz: 'Asia/Taipei',
      departLocal: `${date}T23:40`,
      departUtc: new Date(`${date}T15:40:00Z`).toISOString(),
      toIata: 'VIE',
      toCity: '維也納',
      toTz: 'Europe/Vienna',
      arriveLocal: `${nextDay(date)}T06:20`,
      arriveUtc: new Date(`${nextDay(date)}T04:20:00Z`).toISOString(),
    },
  ];
}
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function apiKey(): string {
  try {
    return RAPIDAPI_KEY.value();
  } catch {
    return '';
  }
}

export async function lookupFlight(flightNoInput: string, date: string): Promise<FlightLeg[]> {
  const flightNo = normalizeFlightNo(flightNoInput);
  const key = apiKey();
  if (!key || process.env.FUNCTIONS_EMULATOR === 'true') {
    if (flightNo === 'E2E1') return stubLegs(flightNo, date);
    if (!key) throw new HttpError(503, 'FLIGHT_LOOKUP_UNAVAILABLE');
  }

  const cacheRef = db.doc(`flightCache/${flightNo}_${date}`);
  const cached = (await cacheRef.get()).data() as { legs: FlightLeg[]; fetchedAt: Timestamp } | undefined;
  if (cached && Date.now() - cached.fetchedAt.toMillis() < CACHE_TTL_MS) return cached.legs;

  const url = `https://${HOST}/flights/number/${encodeURIComponent(flightNo)}/${date}?withAircraftImage=false&withLocation=false`;
  const res = await fetch(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': HOST } });
  if (res.status === 404) return [];
  if (res.status === 429) throw new HttpError(429, 'FLIGHT_LOOKUP_QUOTA');
  if (!res.ok) {
    logger.warn('flight lookup failed', { status: res.status, body: (await res.text()).slice(0, 300) });
    throw new HttpError(502, 'FLIGHT_LOOKUP_FAILED');
  }
  const raw = (await res.json()) as AdbFlight[] | AdbFlight;
  const legs = toLegs(Array.isArray(raw) ? raw : [raw]);
  await cacheRef.set({ legs, fetchedAt: Timestamp.now() });
  return legs;
}
