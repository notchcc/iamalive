import { describe, expect, it } from 'vitest';
import { MAX_ALERTS, REPEAT_H, decideOverdue, type OverdueState } from '../src/overdue-logic.js';

const H = 3_600_000;
/** 台北 2026-09-05 12:00 = 04:00Z */
const NOON = new Date('2026-09-05T04:00:00Z');
/** 台北 2026-09-05 02:00 = 09-04 18:00Z（安靜時段） */
const NIGHT = new Date('2026-09-04T18:00:00Z');
/** 台北 2026-09-05 08:05 = 00:05Z */
const MORNING = new Date('2026-09-05T00:05:00Z');

function base(over: Partial<OverdueState> = {}): OverdueState {
  return {
    endAt: new Date('2026-09-20T00:00:00Z'),
    nextDeadlineAt: new Date(NOON.getTime() - H), // 一小時前到期
    offlineUntil: null,
    alerted: false,
    alertCount: 0,
    lastAlertAt: null,
    morningResendDue: false,
    morningResent: false,
    ...over,
  };
}

describe('decideOverdue', () => {
  it('does nothing before deadline', () => {
    expect(decideOverdue(base({ nextDeadlineAt: new Date(NOON.getTime() + H) }), NOON)).toEqual({ action: 'none' });
  });

  it('does nothing during announced offline', () => {
    expect(decideOverdue(base({ offlineUntil: new Date(NOON.getTime() + H) }), NOON)).toEqual({ action: 'none' });
  });

  it('auto-completes 24h after endAt', () => {
    const s = base({ endAt: new Date(NOON.getTime() - 25 * H) });
    expect(decideOverdue(s, NOON)).toEqual({ action: 'complete' });
    const s2 = base({ endAt: new Date(NOON.getTime() - 23 * H) });
    expect(decideOverdue(s2, NOON).action).toBe('alert');
  });

  it('fires first alert with count 1 and no morning flag in daytime', () => {
    const d = decideOverdue(base(), NOON);
    expect(d.action).toBe('alert');
    if (d.action !== 'alert') return;
    expect(d.kind).toBe('first');
    expect(d.final).toBe(false);
    expect(d.overdueH).toBeCloseTo(1);
    expect(d.patch).toMatchObject({ alerted: true, alertCount: 1, morningResendDue: false, lastAlertAt: NOON });
  });

  it('flags morning resend when first alert is at night', () => {
    const d = decideOverdue(base({ nextDeadlineAt: new Date(NIGHT.getTime() - H) }), NIGHT);
    expect(d.action).toBe('alert');
    if (d.action !== 'alert') return;
    expect(d.patch.morningResendDue).toBe(true);
  });

  it('repeats every REPEAT_H, and marks the last one final', () => {
    let s = base({ alerted: true, alertCount: 1, lastAlertAt: new Date(NOON.getTime() - (REPEAT_H - 0.5) * H) });
    expect(decideOverdue(s, NOON)).toEqual({ action: 'none' });

    s = base({ alerted: true, alertCount: 1, lastAlertAt: new Date(NOON.getTime() - REPEAT_H * H) });
    let d = decideOverdue(s, NOON);
    expect(d.action).toBe('alert');
    if (d.action === 'alert') {
      expect(d.kind).toBe('repeat');
      expect(d.patch.alertCount).toBe(2);
      expect(d.final).toBe(false);
    }

    s = base({ alerted: true, alertCount: MAX_ALERTS - 1, lastAlertAt: new Date(NOON.getTime() - REPEAT_H * H) });
    d = decideOverdue(s, NOON);
    if (d.action === 'alert') {
      expect(d.final).toBe(true);
      expect(d.patch.alertCount).toBe(MAX_ALERTS);
    } else {
      throw new Error('expected alert');
    }

    s = base({ alerted: true, alertCount: MAX_ALERTS, lastAlertAt: new Date(NOON.getTime() - 10 * H) });
    expect(decideOverdue(s, NOON)).toEqual({ action: 'none' });
  });

  it('sends one morning resend after 08:00 Taipei, not counted toward MAX_ALERTS', () => {
    const s = base({
      nextDeadlineAt: new Date(NIGHT.getTime() - H),
      alerted: true,
      alertCount: MAX_ALERTS, // 已達上限仍可補發
      lastAlertAt: new Date(MORNING.getTime() - 1 * H), // 一小時前才發過，不到 REPEAT_H
      morningResendDue: true,
      morningResent: false,
    });
    const d = decideOverdue(s, MORNING);
    expect(d.action).toBe('alert');
    if (d.action !== 'alert') return;
    expect(d.kind).toBe('morning');
    expect(d.patch).toMatchObject({ morningResendDue: false, morningResent: true });
    expect(d.patch.alertCount).toBeUndefined();

    // 補發過就不再補
    const again = decideOverdue({ ...s, ...d.patch, lastAlertAt: MORNING }, new Date(MORNING.getTime() + 15 * 60_000));
    expect(again).toEqual({ action: 'none' });
  });

  it('does not morning-resend before 08:00', () => {
    const s = base({
      nextDeadlineAt: new Date(NIGHT.getTime() - H),
      alerted: true,
      alertCount: 1,
      lastAlertAt: new Date(NIGHT.getTime()),
      morningResendDue: true,
    });
    const at0730 = new Date('2026-09-04T23:30:00Z');
    const d = decideOverdue(s, at0730);
    // 07:30 距上次 5.5h ≥ REPEAT_H → 一般重複，而非 morning
    expect(d.action).toBe('alert');
    if (d.action === 'alert') {
      expect(d.kind).toBe('repeat');
      expect(d.patch.morningResendDue).toBe(true); // 07:30 仍在安靜時段，旗標保留
    }
  });
});
