/**
 * checkOverdue：每 15 分鐘掃描 active 且已過期限的行程，依 overdue-logic 決策。
 */
import { logger } from 'firebase-functions/v2';
import { familyUrl } from './config.js';
import { Timestamp, pendingPhotosCol, tripsCol } from './db.js';
import { deletePhoto } from './photos.js';
import { alertMessages, pushGroup, pushUser, reminderMessages } from './line.js';
import { REMIND_LEAD_H, decideOverdue, decideReminder, type OverdueState } from './overdue-logic.js';
import { HOUR_MS } from './time.js';
import { endTrip, syncViews } from './trips.js';
import type { Trip } from './types.js';

function toState(t: Trip): OverdueState {
  return {
    flights: (t.flights ?? []).map((f) => ({ departAt: f.departAt.toDate(), arriveAt: f.arriveAt.toDate() })),
    startAt: t.startAt.toDate(),
    endAt: t.endAt.toDate(),
    nextDeadlineAt: t.nextDeadlineAt.toDate(),
    offlineUntil: t.offlineUntil ? t.offlineUntil.toDate() : null,
    alerted: t.alerted,
    alertCount: t.alertCount,
    lastAlertAt: t.lastAlertAt ? t.lastAlertAt.toDate() : null,
    morningResendDue: t.morningResendDue,
    morningResent: t.morningResent,
    reminderSentFor: t.reminderSentFor ? t.reminderSentFor.toDate() : null,
  };
}

/** 刪除過期的待配對照片（含 bucket 物件）。 */
export async function purgeExpiredPendingPhotos(now = new Date()): Promise<number> {
  const q = await pendingPhotosCol.where('expiresAt', '<', Timestamp.fromDate(now)).limit(50).get();
  for (const d of q.docs) {
    const p = d.data();
    await deletePhoto(p.tripId, p.photoId);
    await d.ref.delete();
  }
  return q.size;
}

export interface ScanResult {
  scanned: number;
  alerts: number;
  reminders: number;
  completed: number;
}

/**
 * 掃描 active 行程：期限已過的走警報狀態機；期限在 REMIND_LEAD_H 內的私訊旅人提醒。
 * 查詢範圍放寬到 now + REMIND_LEAD_H，航段順延後的有效期限一定不早於原期限，所以不會漏。
 */
export async function runOverdueScan(now = new Date()): Promise<ScanResult> {
  await purgeExpiredPendingPhotos(now).catch(() => 0);
  const snap = await tripsCol
    .where('status', '==', 'active')
    .where('nextDeadlineAt', '<=', Timestamp.fromDate(new Date(now.getTime() + REMIND_LEAD_H * HOUR_MS)))
    .get();

  let alerts = 0;
  let reminders = 0;
  let completed = 0;
  for (const doc of snap.docs) {
    const trip = doc.data();
    const state = toState(trip);

    const remindFor = decideReminder(state, now);
    if (remindFor) {
      const sent = await pushUser(trip.ownerUid, 'reminder', reminderMessages(trip, remindFor, now), now);
      // 送不出去（未加好友、額度）也記錄，避免每 15 分鐘重試
      await doc.ref.update({ reminderSentFor: Timestamp.fromDate(remindFor), updatedAt: Timestamp.fromDate(now) });
      reminders++;
      logger.info('deadline reminder', { tripId: doc.id, sent, deadline: remindFor.toISOString() });
    }

    const d = decideOverdue(state, now);
    if (d.action === 'none') continue;

    if (d.action === 'complete') {
      await endTrip(doc, '行程已過結束時間 24 小時，系統自動結案。');
      completed++;
      continue;
    }

    const url = familyUrl(trip.groupReadToken);
    const sent = await pushGroup(trip.ownerUid, 'alert', alertMessages(trip, { overdueH: d.overdueH, morning: d.kind === 'morning', final: d.final }, url, now));
    const patch: Partial<Trip> = { updatedAt: Timestamp.fromDate(now) };
    if (d.patch.alerted !== undefined) patch.alerted = d.patch.alerted;
    if (d.patch.alertCount !== undefined) patch.alertCount = d.patch.alertCount;
    if (d.patch.lastAlertAt) patch.lastAlertAt = Timestamp.fromDate(d.patch.lastAlertAt);
    if (d.patch.morningResendDue !== undefined) patch.morningResendDue = d.patch.morningResendDue;
    if (d.patch.morningResent !== undefined) patch.morningResent = d.patch.morningResent;
    await doc.ref.update(patch);
    await syncViews(doc.id, { ...trip, ...patch });
    alerts++;
    logger.info('overdue alert', { tripId: doc.id, kind: d.kind, final: d.final, sent, overdueH: d.overdueH.toFixed(2) });
  }
  return { scanned: snap.size, alerts, reminders, completed };
}
