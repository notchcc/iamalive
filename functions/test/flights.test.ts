import { describe, expect, it } from 'vitest';
import { zonedToUtc, tzOffsetMinutes } from '../src/time.js';
import {
  BOARDING_LEAD_H,
  LANDING_GRACE_H,
  currentFlight,
  decideOverdue,
  effectiveDeadline,
  type OverdueState,
} from '../src/overdue-logic.js';

const H = 3_600_000;

describe('zonedToUtc', () => {
  it('converts local wall time with the zone offset', () => {
    expect(zonedToUtc('2026-09-06T19:35', 'Asia/Taipei').toISOString()).toBe('2026-09-06T11:35:00.000Z');
    expect(zonedToUtc('2026-09-07T06:20', 'Europe/Vienna').toISOString()).toBe('2026-09-07T04:20:00.000Z'); // CEST +02:00
    expect(zonedToUtc('2026-12-07T06:20', 'Europe/Vienna').toISOString()).toBe('2026-12-07T05:20:00.000Z'); // CET +01:00
    expect(zonedToUtc('2026-09-06 08:00', 'Asia/Kathmandu').toISOString()).toBe('2026-09-06T02:15:00.000Z');
  });
  it('rejects bad input', () => {
    expect(() => zonedToUtc('2026-09-06', 'Asia/Taipei')).toThrow();
  });
  it('offset minutes', () => {
    expect(tzOffsetMinutes(new Date('2026-09-06T00:00:00Z'), 'Asia/Taipei')).toBe(480);
    expect(tzOffsetMinutes(new Date('2026-09-06T00:00:00Z'), 'America/Los_Angeles')).toBe(-420);
  });
});

// BR61 台北 09/06 23:40 (+08) → 維也納 09/07 06:20 (+02)
const dep = new Date('2026-09-06T15:40:00Z');
const arr = new Date('2026-09-07T04:20:00Z');
const flights = [{ departAt: dep, arriveAt: arr }];

describe('flights: currentFlight / effectiveDeadline', () => {
  it('is in flight from boarding lead until arrival', () => {
    expect(currentFlight(flights, new Date(dep.getTime() - (BOARDING_LEAD_H + 0.1) * H))).toBeNull();
    expect(currentFlight(flights, new Date(dep.getTime() - 1 * H))).not.toBeNull();
    expect(currentFlight(flights, new Date(arr.getTime() - 60_000))).not.toBeNull();
    expect(currentFlight(flights, new Date(arr.getTime() + 60_000))).toBeNull();
  });

  it('moves a deadline inside the flight window to arrival + grace', () => {
    const during = new Date(dep.getTime() + 3 * H);
    expect(effectiveDeadline(during, flights).toISOString()).toBe(new Date(arr.getTime() + LANDING_GRACE_H * H).toISOString());
    const before = new Date(dep.getTime() - 5 * H);
    expect(effectiveDeadline(before, flights)).toEqual(before);
    const after = new Date(arr.getTime() + 10 * H);
    expect(effectiveDeadline(after, flights)).toEqual(after);
    expect(effectiveDeadline(during, undefined)).toEqual(during);
  });

  it('chains through a connection', () => {
    const leg2 = { departAt: new Date(arr.getTime() + 2 * H), arriveAt: new Date(arr.getTime() + 4 * H) };
    const d = effectiveDeadline(new Date(dep.getTime() + 1 * H), [...flights, leg2]);
    expect(d.toISOString()).toBe(new Date(leg2.arriveAt.getTime() + LANDING_GRACE_H * H).toISOString());
  });
});

function base(over: Partial<OverdueState> = {}): OverdueState {
  return {
    flights,
    startAt: new Date('2026-09-01T00:00:00Z'),
    endAt: new Date('2026-09-20T00:00:00Z'),
    nextDeadlineAt: new Date(dep.getTime() + 2 * H), // 期限落在飛行中
    offlineUntil: null,
    alerted: false,
    alertCount: 0,
    lastAlertAt: null,
    morningResendDue: false,
    morningResent: false,
    ...over,
  };
}

describe('decideOverdue with flights', () => {
  it('stays quiet in flight and until landing grace passes', () => {
    expect(decideOverdue(base(), new Date(dep.getTime() + 5 * H))).toEqual({ action: 'none' }); // 飛行中
    expect(decideOverdue(base(), new Date(arr.getTime() + 1 * H))).toEqual({ action: 'none' }); // 落地 1h
  });
  it('alerts after landing + grace, measured from the moved deadline', () => {
    const now = new Date(arr.getTime() + (LANDING_GRACE_H + 1) * H);
    const d = decideOverdue(base(), now);
    expect(d.action).toBe('alert');
    if (d.action === 'alert') expect(d.overdueH).toBeCloseTo(1);
  });
  it('still alerts normally for a deadline before the flight', () => {
    const now = new Date(dep.getTime() - 5 * H);
    const d = decideOverdue(base({ nextDeadlineAt: new Date(now.getTime() - H) }), now);
    expect(d.action).toBe('alert');
  });
});
