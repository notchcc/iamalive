/**
 * 反向地理編碼：座標 → 「城市, 國家」。使用 OSM Nominatim（免費，個人用量符合其使用政策：
 * 每秒 ≤1 次、需帶識別用 User-Agent）。失敗或逾時回傳 null，呼叫端退回時區城市名。
 */
import { logger } from 'firebase-functions/v2';

const UA = 'iamalive/1.0 (personal travel check-in; https://github.com/notchcc/iamalive)';
const TIMEOUT_MS = 4000;

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '10');
  url.searchParams.set('accept-language', 'zh-TW,zh,en');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { address?: NominatimAddress };
    const a = j.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state;
    if (!city && !a.country) return null;
    return [city, a.country].filter(Boolean).join(', ').slice(0, 80);
  } catch (err) {
    logger.warn('reverseGeocode failed', { err: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
