/** 前端時間格式化：台北為主、旅人當地為輔。與 functions/src/time.ts 對齊。 */
export const TAIPEI = 'Asia/Taipei';

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
    second: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  return out;
}

export function fmtDateTime(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

export function fmtDate(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function fmtTime(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.hour}:${p.minute}`;
}

export function fmtClock(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function utcOffset(date: Date, tz: string): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    const name = dtf.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (!m) return '+00:00';
    const sign = m[1].startsWith('-') ? '-' : '+';
    return `${sign}${String(Math.abs(Number(m[1]))).padStart(2, '0')}:${m[2] ?? '00'}`;
  } catch {
    return '';
  }
}

export function tzLabel(tz: string): string {
  if (CITY_NAMES[tz]) return CITY_NAMES[tz];
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

export function sameAsTaipei(date: Date, tz: string): boolean {
  return tz === TAIPEI || utcOffset(date, tz) === utcOffset(date, TAIPEI);
}

export function fmtBoth(date: Date, localTz: string): string {
  const tpe = `台北 ${fmtDateTime(date, TAIPEI)}`;
  if (sameAsTaipei(date, localTz)) return tpe;
  return `${tpe}（${tzLabel(localTz)} ${fmtTime(date, localTz)}）`;
}

export function fmtAgo(from: Date, to = new Date()): string {
  const min = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} 小時 ${m} 分前` : `${h} 小時前`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小時前`;
}

export function fmtHours(h: number): string {
  const totalMin = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm} 分鐘`;
  if (mm === 0) return `${hh} 小時`;
  return `${hh} 小時 ${mm} 分`;
}
