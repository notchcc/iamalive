/**
 * 逾時警報狀態機（純函式）。checkOverdue 排程只負責讀寫，決策集中在這裡以便測試。
 *
 * 規則（spec §7）：
 * - 期限到後先發第 1 則；之後每 REPEAT_H 小時一則，直到 MAX_ALERTS。
 * - 落在台北安靜時段（23:00–07:00）的警報照發，但標記待補發；08:00 後第一次掃描補發一次，
 *   不計入 MAX_ALERTS，每次事件最多一次。
 * - startAt 之前不警報。
 * - endAt + 24h 仍未結案 → 自動結案。
 * - 預告離線期間不警報。
 */
import { HOUR_MS, hoursBetween, inQuietHours, isMorningWindow } from './time.js';

export const REPEAT_H = 3;
export const MAX_ALERTS = 4;
export const AUTO_COMPLETE_GRACE_H = 24;
/** 起飛前多久起算為飛行中（機場報到、關機）。 */
export const BOARDING_LEAD_H = 2;
/** 降落後多久內必須回報。 */
export const LANDING_GRACE_H = 3;

export interface FlightWindow {
  departAt: Date;
  arriveAt: Date;
}

export interface OverdueState {
  flights?: FlightWindow[];
  startAt: Date;
  endAt: Date;
  nextDeadlineAt: Date;
  offlineUntil: Date | null;
  alerted: boolean;
  alertCount: number;
  lastAlertAt: Date | null;
  morningResendDue: boolean;
  morningResent: boolean;
}

export type OverdueDecision =
  | { action: 'none' }
  | { action: 'complete' }
  | {
      action: 'alert';
      kind: 'first' | 'repeat' | 'morning';
      final: boolean;
      overdueH: number;
      patch: Partial<Pick<OverdueState, 'alerted' | 'alertCount' | 'lastAlertAt' | 'morningResendDue' | 'morningResent'>>;
    };

/** 目前是否在飛行中（起飛前 BOARDING_LEAD_H 到降落）。 */
export function currentFlight<T extends FlightWindow>(flights: T[] | undefined, now: Date): T | null {
  for (const f of flights ?? []) {
    if (f.departAt.getTime() - BOARDING_LEAD_H * HOUR_MS <= now.getTime() && now.getTime() <= f.arriveAt.getTime()) return f;
  }
  return null;
}

/**
 * 把期限依航段順延：若期限落在某航段的飛行窗內，改為該航段降落 + LANDING_GRACE_H；
 * 連續套用以處理轉機。
 */
export function effectiveDeadline(deadline: Date, flights: FlightWindow[] | undefined): Date {
  let d = deadline;
  const sorted = [...(flights ?? [])].sort((a, b) => a.departAt.getTime() - b.departAt.getTime());
  for (const f of sorted) {
    const winStart = f.departAt.getTime() - BOARDING_LEAD_H * HOUR_MS;
    if (d.getTime() >= winStart && d.getTime() <= f.arriveAt.getTime() + LANDING_GRACE_H * HOUR_MS) {
      const moved = new Date(f.arriveAt.getTime() + LANDING_GRACE_H * HOUR_MS);
      if (moved.getTime() > d.getTime()) d = moved;
    }
  }
  return d;
}

export function decideOverdue(s: OverdueState, now: Date): OverdueDecision {
  if (s.endAt.getTime() + AUTO_COMPLETE_GRACE_H * HOUR_MS < now.getTime()) {
    return { action: 'complete' };
  }
  // 行程尚未開始：不警報（開始前的打卡只是測試或提早回報）。
  if (s.startAt.getTime() > now.getTime()) return { action: 'none' };
  const deadline = effectiveDeadline(s.nextDeadlineAt, s.flights);
  if (deadline.getTime() > now.getTime()) return { action: 'none' };
  if (s.offlineUntil && s.offlineUntil.getTime() > now.getTime()) return { action: 'none' };
  if (currentFlight(s.flights, now)) return { action: 'none' };

  const overdueH = hoursBetween(deadline, now);

  // 早晨補發優先：上一則落在安靜時段、現在已進入白天、本事件尚未補發。
  if (s.alerted && s.morningResendDue && !s.morningResent && isMorningWindow(now)) {
    return {
      action: 'alert',
      kind: 'morning',
      final: false,
      overdueH,
      patch: { morningResendDue: false, morningResent: true, lastAlertAt: now },
    };
  }

  const quietNow = inQuietHours(now);

  if (!s.alerted) {
    return {
      action: 'alert',
      kind: 'first',
      final: (MAX_ALERTS as number) <= 1,
      overdueH,
      patch: {
        alerted: true,
        alertCount: 1,
        lastAlertAt: now,
        morningResendDue: quietNow,
      },
    };
  }

  const sinceLast = s.lastAlertAt ? hoursBetween(s.lastAlertAt, now) : Infinity;
  if (sinceLast >= REPEAT_H && s.alertCount < MAX_ALERTS) {
    const nextCount = s.alertCount + 1;
    return {
      action: 'alert',
      kind: 'repeat',
      final: nextCount === MAX_ALERTS,
      overdueH,
      patch: {
        alertCount: nextCount,
        lastAlertAt: now,
        morningResendDue: quietNow || s.morningResendDue,
      },
    };
  }

  return { action: 'none' };
}
