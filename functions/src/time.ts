/**
 * 時間與時區工具。伺服器內部一律 UTC；所有面向家人的顯示以台北為主、旅人當地為輔。
 * 純函式，無外部相依，方便單元測試。
 */

export const TAIPEI = 'Asia/Taipei';
export const HOUR_MS = 3_600_000;

/** 安靜時段（台北）：23:00–07:00。 */
export const QUIET_START_HOUR = 23;
export const QUIET_END_HOUR = 7;
/** 早晨補發時間（台北）。 */
export const MORNING_RESEND_HOUR = 8;

const CITY_NAMES: Record<string, string> = {
  'Asia/Taipei': '台北',
  'Asia/Tokyo': '東京',
  'Asia/Seoul': '首爾',
  'Asia/Shanghai': '上海',
  'Asia/Hong_Kong': '香港',
  'Asia/Macau': '澳門',
  'Asia/Manila': '馬尼拉',
  'Asia/Bangkok': '曼谷',
  'Asia/Ho_Chi_Minh': '胡志明市',
  'Asia/Singapore': '新加坡',
  'Asia/Kuala_Lumpur': '吉隆坡',
  'Asia/Jakarta': '雅加達',
  'Asia/Kathmandu': '加德滿都',
  'Asia/Kolkata': '印度',
  'Asia/Dubai': '杜拜',
  'Europe/London': '倫敦',
  'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林',
  'Europe/Rome': '羅馬',
  'Europe/Madrid': '馬德里',
  'Europe/Amsterdam': '阿姆斯特丹',
  'Europe/Zurich': '蘇黎世',
  'Europe/Prague': '布拉格',
  'Europe/Vienna': '維也納',
  'Europe/Istanbul': '伊斯坦堡',
  'America/New_York': '紐約',
  'America/Chicago': '芝加哥',
  'America/Denver': '丹佛',
  'America/Los_Angeles': '洛杉磯',
  'America/Vancouver': '溫哥華',
  'America/Toronto': '多倫多',
  'Pacific/Honolulu': '檀香山',
  'Australia/Sydney': '雪梨',
  'Australia/Melbourne': '墨爾本',
  'Pacific/Auckland': '奧克蘭',
};

function parts(date: Date, tz: string): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 某時區的小時（0–23）。 */
export function hourIn(date: Date, tz: string): number {
  return Number(parts(date, tz).hour);
}

/** `MM/DD HH:mm` */
export function fmtDateTime(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** `HH:mm` */
export function fmtTime(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.hour}:${p.minute}`;
}

/** `YYYY-MM`（台北），供月額度計數。 */
export function monthKey(date: Date): string {
  const p = parts(date, TAIPEI);
  return `${p.year}-${p.month}`;
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 時區的 UTC 偏移字串，如 `+09:00`。 */
export function utcOffset(date: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const name = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+00:00';
  const sign = m[1].startsWith('-') ? '-' : '+';
  const hh = String(Math.abs(Number(m[1]))).padStart(2, '0');
  const mm = m[2] ?? '00';
  return `${sign}${hh}:${mm}`;
}

/** 時區的顯示名稱：已知城市用中文，否則用 IANA 最後一段。 */
export function tzLabel(tz: string): string {
  if (CITY_NAMES[tz]) return CITY_NAMES[tz];
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

/** 是否與台北同一時區（以當下偏移判斷，避免 Asia/Shanghai 等同偏移時區重複顯示）。 */
export function sameAsTaipei(date: Date, tz: string): boolean {
  return tz === TAIPEI || utcOffset(date, tz) === utcOffset(date, TAIPEI);
}

/**
 * 「台北 MM/DD HH:mm（當地 HH:mm）」。當地與台北同偏移時省略括號。
 */
export function fmtBoth(date: Date, localTz: string): string {
  const tpe = `台北 ${fmtDateTime(date, TAIPEI)}`;
  if (sameAsTaipei(date, localTz)) return tpe;
  return `${tpe}（${tzLabel(localTz)} ${fmtTime(date, localTz)}）`;
}

/** 台北安靜時段：23:00–07:00。 */
export function inQuietHours(date: Date): boolean {
  const h = hourIn(date, TAIPEI);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** 已過台北早晨補發時間（08:00 之後、23:00 之前）。 */
export function isMorningWindow(date: Date): boolean {
  const h = hourIn(date, TAIPEI);
  return h >= MORNING_RESEND_HOUR && h < QUIET_START_HOUR;
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

/** 小時數的人類可讀格式：0.4 → "25 分鐘"，3.6 → "3 小時 36 分"。 */
export function fmtHours(h: number): string {
  const totalMin = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm} 分鐘`;
  if (mm === 0) return `${hh} 小時`;
  return `${hh} 小時 ${mm} 分`;
}
