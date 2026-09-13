import { describe, expect, it } from 'vitest';
import { buildForecast, type ForecastInput } from '../src/forecast.js';

const H = 3_600_000;
/** 台北 2026-09-05 12:00 */
const NOW = new Date('2026-09-05T04:00:00Z');

function input(over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    now: NOW,
    hours: 24,
    status: 'active',
    travelerTz: 'Asia/Taipei',
    startAt: new Date('2026-09-01T00:00:00Z'),
    endAt: new Date('2026-09-20T00:00:00Z'),
    nextDeadlineAt: new Date(NOW.getTime() + 4 * H), // 台北 16:00
    offlineUntil: null,
    flights: [],
    sleep: { start: '23:00', end: '08:00' },
    alerted: false,
    alertCount: 0,
    lastAlertAt: null,
    morningResendDue: false,
    morningResent: false,
    reminderSentFor: null,
    ...over,
  };
}

describe('buildForecast', () => {
  it('lists sleep and Taipei quiet segments within the window', () => {
    const f = buildForecast(input());
    const kinds = f.segments.map((s) => s.kind);
    expect(kinds).toContain('sleep');
    expect(kinds).toContain('quiet');
    const sleep = f.segments.find((s) => s.kind === 'sleep')!;
    expect(sleep.from).toBe('2026-09-05T15:00:00.000Z'); // 台北 23:00
    expect(sleep.to).toBe('2026-09-06T00:00:00.000Z'); // 台北 08:00
  });

  it('simulates reminder, first alert and repeats (no further check-ins)', () => {
    const f = buildForecast(input());
    const rem = f.events.find((e) => e.kind === 'reminder')!;
    expect(rem.at).toBe('2026-09-05T06:45:00.000Z'); // 15:00 台北：距 16:00 60–75 分內第一次掃描
    const alerts = f.events.filter((e) => e.kind === 'alert');
    expect(alerts.map((a) => a.at.slice(11, 16))).toEqual(['08:00', '11:00', '14:00', '17:00', '00:00']); // 16:00、19:00、22:00、01:00 台北 + 早晨補發 08:00
    expect(alerts[3].delayed).toBe(true); // 台北 01:00
    expect(alerts[4].label).toBe('早晨補發');
    expect(f.summary[0]).toContain('下次期限');
  });

  it('marks the deadline as sleep-shifted and pushes alerts to the morning', () => {
    const f = buildForecast(input({ nextDeadlineAt: new Date('2026-09-05T18:00:00Z') })); // 台北 02:00
    expect(f.deadlineShift).toBe('sleep');
    expect(f.events.find((e) => e.kind === 'deadline')?.at).toBe('2026-09-05T18:00:00.000Z');
    expect(f.events.find((e) => e.kind === 'effectiveDeadline')?.at).toBe('2026-09-06T01:00:00.000Z'); // 09:00 台北
    const first = f.events.find((e) => e.kind === 'alert')!;
    expect(first.at).toBe('2026-09-06T01:00:00.000Z');
    expect(first.delayed).toBe(false);
  });

  it('shows the flight window and no alerts while offline', () => {
    const dep = new Date(NOW.getTime() + 2 * H);
    const arr = new Date(NOW.getTime() + 6 * H);
    const f = buildForecast(input({ flights: [{ flightNo: 'BR61', fromCity: '台北', toCity: '維也納', departAt: dep, arriveAt: arr }], sleep: null }));
    const fl = f.segments.find((s) => s.kind === 'flight')!;
    expect(fl.from).toBe(NOW.toISOString()); // 起飛前 2h = 現在
    expect(fl.to).toBe(new Date(arr.getTime() + 3 * H).toISOString());
    const off = buildForecast(input({ offlineUntil: new Date(NOW.getTime() + 30 * H), sleep: null }));
    expect(off.events.filter((e) => e.kind === 'alert')).toHaveLength(0);
    expect(off.segments.find((s) => s.kind === 'offline')?.to).toBe(new Date(NOW.getTime() + 24 * H).toISOString());
  });

  it('is quiet for completed trips', () => {
    const f = buildForecast(input({ status: 'completed' }));
    expect(f.events).toHaveLength(0);
    expect(f.summary[0]).toContain('結束');
  });
});
