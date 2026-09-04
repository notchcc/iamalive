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

export interface OverdueState {
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

export function decideOverdue(s: OverdueState, now: Date): OverdueDecision {
  if (s.endAt.getTime() + AUTO_COMPLETE_GRACE_H * HOUR_MS < now.getTime()) {
    return { action: 'complete' };
  }
  // 行程尚未開始：不警報（開始前的打卡只是測試或提早回報）。
  if (s.startAt.getTime() > now.getTime()) return { action: 'none' };
  if (s.nextDeadlineAt.getTime() > now.getTime()) return { action: 'none' };
  if (s.offlineUntil && s.offlineUntil.getTime() > now.getTime()) return { action: 'none' };

  const overdueH = hoursBetween(s.nextDeadlineAt, now);

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
