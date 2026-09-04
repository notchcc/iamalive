/**
 * checkOverdue：每 15 分鐘掃描 active 且已過期限的行程，依 overdue-logic 決策。
 */
import { logger } from 'firebase-functions/v2';
import { familyUrl } from './config.js';
import { Timestamp, tripsCol } from './db.js';
import { alertMessages, pushGroup } from './line.js';
import { decideOverdue, type OverdueState } from './overdue-logic.js';
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
  };
}

export async function runOverdueScan(now = new Date()): Promise<{ scanned: number; alerts: number; completed: number }> {
  const snap = await tripsCol
    .where('status', '==', 'active')
    .where('nextDeadlineAt', '<=', Timestamp.fromDate(now))
    .get();

  let alerts = 0;
  let completed = 0;
  for (const doc of snap.docs) {
    const trip = doc.data();
    const d = decideOverdue(toState(trip), now);
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
  return { scanned: snap.size, alerts, completed };
}
