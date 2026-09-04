/**
 * 航班查詢：AeroDataBox（RapidAPI）。輸入航班號碼 + 日期，回傳各航段的起降機場、時區、表定時間。
 * 結果以「航班_日期」快取 12 小時，省額度。emulator 或未設金鑰時提供固定樣本（E2E1）。
 */
import { logger } from 'firebase-functions/v2';
import { RAPIDAPI_KEY } from './config.js';
import { Timestamp, db } from './db.js';
import { HttpError } from './errors.js';
import { tzLabel } from './time.js';

export type { AdbFlight };

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

/** API 城市名（英文）→ 中文。沒有對照就顯示英文。 */
const CITY_ZH: Record<string, string> = {
  Taipei: '台北', Taoyuan: '台北', Kaohsiung: '高雄', Taichung: '台中',
  'Hong Kong': '香港', Macau: '澳門', Macao: '澳門',
  Tokyo: '東京', Osaka: '大阪', Nagoya: '名古屋', Fukuoka: '福岡', Sapporo: '札幌', Naha: '那霸', Okinawa: '那霸',
  Seoul: '首爾', Busan: '釜山', Shanghai: '上海', Beijing: '北京', Guangzhou: '廣州', Shenzhen: '深圳', Chengdu: '成都', Xiamen: '廈門',
  Bangkok: '曼谷', Singapore: '新加坡', 'Kuala Lumpur': '吉隆坡', Manila: '馬尼拉', Hanoi: '河內', 'Ho Chi Minh City': '胡志明市',
  Jakarta: '雅加達', Denpasar: '峇里島', Bali: '峇里島', Dubai: '杜拜', Doha: '杜哈', 'Abu Dhabi': '阿布達比', Istanbul: '伊斯坦堡',
  Zurich: '蘇黎世', Geneva: '日內瓦', Vienna: '維也納', Frankfurt: '法蘭克福', Munich: '慕尼黑', Berlin: '柏林',
  Paris: '巴黎', London: '倫敦', Amsterdam: '阿姆斯特丹', Brussels: '布魯塞爾', Rome: '羅馬', Milan: '米蘭', Madrid: '馬德里',
  Barcelona: '巴塞隆納', Lisbon: '里斯本', Prague: '布拉格', Copenhagen: '哥本哈根', Stockholm: '斯德哥爾摩', Oslo: '奧斯陸',
  Helsinki: '赫爾辛基', Warsaw: '華沙', Athens: '雅典', Dublin: '都柏林',
  'New York': '紐約', 'Los Angeles': '洛杉磯', 'San Francisco': '舊金山', Seattle: '西雅圖', Chicago: '芝加哥', Vancouver: '溫哥華',
  Toronto: '多倫多', Honolulu: '檀香山', Sydney: '雪梨', Melbourne: '墨爾本', Brisbane: '布里斯本', Auckland: '奧克蘭',
};

/** 部分機場 API 給的時區不精確（同偏移但名稱不同），以 IATA 校正。 */
const TZ_BY_IATA: Record<string, string> = {
  HKG: 'Asia/Hong_Kong',
  MFM: 'Asia/Macau',
  TPE: 'Asia/Taipei',
  TSA: 'Asia/Taipei',
  KHH: 'Asia/Taipei',
  RMQ: 'Asia/Taipei',
};

function cityName(apiCity: string | undefined, tz: string | undefined, iata: string): string {
  if (apiCity) {
    const key = apiCity.trim();
    if (CITY_ZH[key]) return CITY_ZH[key];
    const hit = Object.keys(CITY_ZH).find((k) => key.toLowerCase().startsWith(k.toLowerCase()));
    if (hit) return CITY_ZH[hit];
    return key;
  }
  if (tz) {
    const label = tzLabel(tz);
    if (!/^[A-Za-z_ ]+$/.test(label)) return label;
  }
  return iata;
}

function airportTz(iata: string | undefined, apiTz: string | undefined): string | undefined {
  return (iata && TZ_BY_IATA[iata]) || apiTz;
}

export function toLegs(raw: AdbFlight[]): FlightLeg[] {
  const legs: FlightLeg[] = [];
  for (const f of raw) {
    if (f.isCargo) continue;
    const d = f.departure;
    const a = f.arrival;
    const fromTz = airportTz(d?.airport?.iata, d?.airport?.timeZone);
    const toTz = airportTz(a?.airport?.iata, a?.airport?.timeZone);
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
      fromCity: cityName(d?.airport?.municipalityName, fromTz, fromIata),
      fromTz,
      departLocal,
      departUtc,
      toIata,
      toCity: cityName(a?.airport?.municipalityName, toTz, toIata),
      toTz,
      arriveLocal,
      arriveUtc,
    });
  }
  // 去重（API 可能同一航段回傳多筆），並依起飛時間排序
  const seen = new Set<string>();
  const unique = legs.filter((l) => {
    const k = `${l.fromIata}-${l.toIata}-${l.departUtc}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((x, y) => x.departUtc.localeCompare(y.departUtc));
  return unique;
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
  const raw = (await res.json()) as AdbFlight[] | AdbFlight | { message?: string };
  if (!Array.isArray(raw) && 'message' in raw && raw.message) {
    // RapidAPI 的錯誤有時以 200 回傳 {message}
    if (/rate limit|quota/i.test(raw.message)) throw new HttpError(429, 'FLIGHT_LOOKUP_QUOTA');
    logger.warn('flight lookup message', { message: raw.message });
    throw new HttpError(502, 'FLIGHT_LOOKUP_FAILED');
  }
  const legs = toLegs(Array.isArray(raw) ? raw : [raw as AdbFlight]);
  await cacheRef.set({ legs, fetchedAt: Timestamp.now() });
  return legs;
}
