/**
 * 接下來 N 小時的「警報預報」：假設旅人不再打卡，依現有狀態機模擬每 15 分鐘一次掃描，
 * 列出不警報 / 順延 / 延遲補發的區段與事件。給管理頁與打卡頁畫時間軸用。純函式。
 */
import {
  BOARDING_LEAD_H,
  LANDING_GRACE_H,
  REMIND_LEAD_H,
  currentFlight,
  decideOverdue,
  decideReminder,
  deadlineShiftKind,
  effectiveDeadline,
  type OverdueState,
} from './overdue-logic.js';
import { HOUR_MS, QUIET_END_HOUR, QUIET_START_HOUR, TAIPEI, fmtBoth, fmtTime, inQuietHours, localYmdMin, nextYmd, zonedToUtc } from './time.js';
import type { DeadlineShift, SleepWindow } from './types.js';

export interface ForecastFlight {
  flightNo: string;
  fromCity: string;
  toCity: string;
  departAt: Date;
  arriveAt: Date;
}

export interface ForecastInput {
  now: Date;
  hours: number;
  status: 'active' | 'completed';
  travelerTz: string;
  startAt: Date;
  endAt: Date;
  nextDeadlineAt: Date;
  offlineUntil: Date | null;
  flights: ForecastFlight[];
  sleep: SleepWindow | null;
  alerted: boolean;
  alertCount: number;
  lastAlertAt: Date | null;
  morningResendDue: boolean;
  morningResent: boolean;
  reminderSentFor: Date | null;
}

export type SegmentKind = 'flight' | 'sleep' | 'offline' | 'quiet';
export type EventKind = 'deadline' | 'effectiveDeadline' | 'reminder' | 'alert' | 'tripEnd' | 'autoComplete';

export interface ForecastSegment {
  kind: SegmentKind;
  from: string;
  to: string;
  label: string;
}
export interface ForecastEvent {
  kind: EventKind;
  at: string;
  label: string;
  /** 警報落在台北安靜時段：照發，08:00 補發 */
  delayed?: boolean;
  final?: boolean;
}
export interface Forecast {
  now: string;
  hours: number;
  travelerTz: string;
  deadlineShift: DeadlineShift;
  segments: ForecastSegment[];
  events: ForecastEvent[];
  summary: string[];
}

const SCAN_MIN = 15;

function clip(from: Date, to: Date, lo: Date, hi: Date): [Date, Date] | null {
  const a = Math.max(from.getTime(), lo.getTime());
  const b = Math.min(to.getTime(), hi.getTime());
  return b > a ? [new Date(a), new Date(b)] : null;
}

/** 某個「當地 HH:mm–HH:mm」時段在 [lo, hi] 內的所有實例。 */
function dailyWindows(start: string, end: string, tz: string, lo: Date, hi: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  // 從 lo 的前一天掃到 hi 的後一天，涵蓋跨午夜與時差
  let ymd = localYmdMin(new Date(lo.getTime() - 24 * HOUR_MS), tz).ymd;
  const last = localYmdMin(new Date(hi.getTime() + 24 * HOUR_MS), tz).ymd;
  for (let i = 0; i < 6 && ymd <= last; i++) {
    const s = zonedToUtc(`${ymd}T${start}`, tz);
    const e = zonedToUtc(`${start > end ? nextYmd(ymd) : ymd}T${end}`, tz);
    const c = clip(s, e, lo, hi);
    if (c) out.push(c);
    ymd = nextYmd(ymd);
  }
  return out;
}

export function buildForecast(input: ForecastInput): Forecast {
  const { now, hours, travelerTz: tz } = input;
  const end = new Date(now.getTime() + hours * HOUR_MS);
  const iso = (d: Date) => d.toISOString();
  const segments: ForecastSegment[] = [];
  const events: ForecastEvent[] = [];
  const summary: string[] = [];
  const flightWins = input.flights.map((f) => ({ departAt: f.departAt, arriveAt: f.arriveAt }));

  if (input.status !== 'active') {
    return { now: iso(now), hours, travelerTz: tz, deadlineShift: 'none', segments, events, summary: ['行程已結束，不再監測。'] };
  }

  // ---- 區段 ----
  for (const f of input.flights) {
    const c = clip(new Date(f.departAt.getTime() - BOARDING_LEAD_H * HOUR_MS), new Date(f.arriveAt.getTime() + LANDING_GRACE_H * HOUR_MS), now, end);
    if (c) segments.push({ kind: 'flight', from: iso(c[0]), to: iso(c[1]), label: `${f.flightNo} ${f.fromCity}→${f.toCity}` });
  }
  if (input.sleep && input.sleep.start !== input.sleep.end) {
    for (const [a, b] of dailyWindows(input.sleep.start, input.sleep.end, tz, now, end)) {
      segments.push({ kind: 'sleep', from: iso(a), to: iso(b), label: `睡眠 ${input.sleep.start}–${input.sleep.end}` });
    }
  }
  if (input.offlineUntil && input.offlineUntil > now) {
    const c = clip(now, input.offlineUntil, now, end);
    if (c) segments.push({ kind: 'offline', from: iso(c[0]), to: iso(c[1]), label: '預告離線' });
  }
  const qs = `${String(QUIET_START_HOUR).padStart(2, '0')}:00`;
  const qe = `${String(QUIET_END_HOUR).padStart(2, '0')}:00`;
  for (const [a, b] of dailyWindows(qs, qe, TAIPEI, now, end)) {
    segments.push({ kind: 'quiet', from: iso(a), to: iso(b), label: '台北安靜時段（警報 08:00 補發）' });
  }

  // ---- 期限 ----
  const eff = effectiveDeadline(input.nextDeadlineAt, flightWins, input.sleep, tz);
  const shift = deadlineShiftKind(input.nextDeadlineAt, flightWins, input.sleep, tz);
  if (shift !== 'none' && input.nextDeadlineAt >= now && input.nextDeadlineAt <= end) {
    events.push({ kind: 'deadline', at: iso(input.nextDeadlineAt), label: '原始期限' });
  }
  if (eff >= now && eff <= end) {
    events.push({ kind: 'effectiveDeadline', at: iso(eff), label: shift === 'sleep' ? '期限（睡眠順延）' : shift === 'flight' ? '期限（航段順延）' : '期限' });
  }
  if (input.endAt >= now && input.endAt <= end) events.push({ kind: 'tripEnd', at: iso(input.endAt), label: '行程結束時間' });
  const autoAt = new Date(input.endAt.getTime() + 24 * HOUR_MS);
  if (autoAt >= now && autoAt <= end) events.push({ kind: 'autoComplete', at: iso(autoAt), label: '自動結案' });

  // ---- 模擬掃描：提醒與警報 ----
  const state: OverdueState = {
    flights: flightWins,
    startAt: input.startAt,
    endAt: input.endAt,
    nextDeadlineAt: input.nextDeadlineAt,
    offlineUntil: input.offlineUntil,
    alerted: input.alerted,
    alertCount: input.alertCount,
    lastAlertAt: input.lastAlertAt,
    morningResendDue: input.morningResendDue,
    morningResent: input.morningResent,
    reminderSentFor: input.reminderSentFor,
    sleep: input.sleep,
    travelerTz: tz,
  };
  const alerts: Date[] = [];
  let reminderAt: Date | null = null;
  for (let t = now.getTime(); t <= end.getTime(); t += SCAN_MIN * 60_000) {
    const at = new Date(t);
    const rem = decideReminder(state, at);
    if (rem) {
      state.reminderSentFor = rem;
      if (!reminderAt) {
        reminderAt = at;
        events.push({ kind: 'reminder', at: iso(at), label: `到期前提醒（${Math.round((rem.getTime() - at.getTime()) / 60_000)} 分前）` });
      }
    }
    const d = decideOverdue(state, at);
    if (d.action === 'complete') break;
    if (d.action === 'alert') {
      Object.assign(state, {
        alerted: d.patch.alerted ?? state.alerted,
        alertCount: d.patch.alertCount ?? state.alertCount,
        lastAlertAt: d.patch.lastAlertAt ?? state.lastAlertAt,
        morningResendDue: d.patch.morningResendDue ?? state.morningResendDue,
        morningResent: d.patch.morningResent ?? state.morningResent,
      });
      alerts.push(at);
      const label = d.kind === 'morning' ? '早晨補發' : d.kind === 'first' ? '第 1 則警報' : `第 ${state.alertCount} 則警報`;
      events.push({ kind: 'alert', at: iso(at), label, delayed: d.kind !== 'morning' && inQuietHours(at), final: d.final });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  // ---- 文字摘要 ----
  const both = (d: Date) => fmtBoth(d, tz);
  const shiftNote = shift === 'sleep' ? '，睡眠順延' : shift === 'flight' ? '，航段順延' : '';
  if (eff <= now) {
    summary.push(`目前已逾時（期限 ${both(eff)}${shiftNote}）。`);
  } else {
    summary.push(`若不再打卡：下次期限 ${both(eff)}${shiftNote}。`);
  }
  if (reminderAt) summary.push(`到期前提醒約 ${fmtTime(reminderAt, tz)}（當地）。`);
  const fl = currentFlight(input.flights, now);
  if (fl) summary.push(`目前飛行窗 ${fl.flightNo}，落地後 ${LANDING_GRACE_H} 小時內回報。`);
  if (input.offlineUntil && input.offlineUntil > now) summary.push(`預告離線至 ${both(input.offlineUntil)}，期間不警報。`);
  if (alerts.length) {
    const delayed = events.filter((e) => e.kind === 'alert' && e.delayed).length;
    summary.push(
      `警報：${alerts.map((a) => fmtTime(a, TAIPEI)).join('、')}（台北）` +
        (delayed ? `，其中 ${delayed} 則落在台北深夜，08:00 補發` : '') +
        '。',
    );
  } else if (eff > end) {
    summary.push(`${hours} 小時內不會有警報。`);
  }
  if (REMIND_LEAD_H && !reminderAt && eff > end) summary.push('提醒也在範圍之外。');
  return { now: iso(now), hours, travelerTz: tz, deadlineShift: shift, segments, events, summary };
}
