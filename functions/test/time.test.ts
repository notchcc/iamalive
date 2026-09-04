import { describe, expect, it } from 'vitest';
import {
  TAIPEI,
  fmtBoth,
  fmtDateTime,
  fmtHours,
  hourIn,
  inQuietHours,
  isMorningWindow,
  monthKey,
  sameAsTaipei,
  tzLabel,
  utcOffset,
} from '../src/time.js';

// 2026-09-05T03:32:00Z = 台北 11:32、東京 12:32、洛杉磯 09-04 20:32
const T = new Date('2026-09-05T03:32:00Z');

describe('time', () => {
  it('formats in a given tz', () => {
    expect(fmtDateTime(T, TAIPEI)).toBe('09/05 11:32');
    expect(fmtDateTime(T, 'Asia/Tokyo')).toBe('09/05 12:32');
    expect(fmtDateTime(T, 'America/Los_Angeles')).toBe('09/04 20:32');
  });

  it('fmtBoth shows Taipei first and local in parentheses', () => {
    expect(fmtBoth(T, 'Asia/Tokyo')).toBe('台北 09/05 11:32（東京 12:32）');
    expect(fmtBoth(T, TAIPEI)).toBe('台北 09/05 11:32');
    // 與台北同偏移的時區不重複顯示
    expect(fmtBoth(T, 'Asia/Shanghai')).toBe('台北 09/05 11:32');
  });

  it('quiet hours are Taipei 23:00–07:00', () => {
    expect(inQuietHours(new Date('2026-09-04T15:00:00Z'))).toBe(true); // 台北 23:00
    expect(inQuietHours(new Date('2026-09-04T22:59:00Z'))).toBe(true); // 台北 06:59
    expect(inQuietHours(new Date('2026-09-04T23:00:00Z'))).toBe(false); // 台北 07:00
    expect(inQuietHours(new Date('2026-09-05T14:59:00Z'))).toBe(false); // 台北 22:59
  });

  it('morning window starts at Taipei 08:00', () => {
    expect(isMorningWindow(new Date('2026-09-04T23:59:00Z'))).toBe(false); // 07:59
    expect(isMorningWindow(new Date('2026-09-05T00:00:00Z'))).toBe(true); // 08:00
    expect(isMorningWindow(new Date('2026-09-05T15:00:00Z'))).toBe(false); // 23:00
  });

  it('monthKey uses Taipei date', () => {
    // 2026-08-31T17:00Z = 台北 09-01 01:00
    expect(monthKey(new Date('2026-08-31T17:00:00Z'))).toBe('2026-09');
    expect(monthKey(new Date('2026-08-31T15:00:00Z'))).toBe('2026-08');
  });

  it('labels and offsets', () => {
    expect(tzLabel('Asia/Tokyo')).toBe('東京');
    expect(tzLabel('Europe/Oslo')).toBe('Oslo');
    expect(utcOffset(T, 'Asia/Tokyo')).toBe('+09:00');
    expect(utcOffset(T, 'Asia/Kathmandu')).toBe('+05:45');
    expect(utcOffset(T, 'America/Los_Angeles')).toBe('-07:00');
    expect(hourIn(T, TAIPEI)).toBe(11);
    expect(sameAsTaipei(T, 'Asia/Manila')).toBe(true);
  });

  it('fmtHours', () => {
    expect(fmtHours(0.4)).toBe('24 分鐘');
    expect(fmtHours(3)).toBe('3 小時');
    expect(fmtHours(3.6)).toBe('3 小時 36 分');
  });
});
