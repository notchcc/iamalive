/** 航段判斷（與 functions/src/overdue-logic.ts 對齊）。 */
import type { FlightSeg } from './types';

export const BOARDING_LEAD_H = 2;
export const LANDING_GRACE_H = 3;
const H = 3_600_000;

export interface FlightWin {
  departAt: Date;
  arriveAt: Date;
}

export type FlightView = Omit<FlightSeg, 'departAt' | 'arriveAt'> & FlightWin;

export function toWindows(flights: FlightSeg[] | undefined): FlightView[] {
  return (flights ?? []).map((f) => ({ ...f, departAt: f.departAt.toDate(), arriveAt: f.arriveAt.toDate() }));
}

export function currentFlight<T extends FlightWin>(flights: T[], now: Date): T | null {
  for (const f of flights) {
    if (f.departAt.getTime() - BOARDING_LEAD_H * H <= now.getTime() && now.getTime() <= f.arriveAt.getTime()) return f;
  }
  return null;
}

export function nextFlight<T extends FlightWin>(flights: T[], now: Date): T | null {
  return flights.find((f) => f.departAt.getTime() > now.getTime()) ?? null;
}

export function effectiveDeadline(deadline: Date, flights: FlightWin[]): Date {
  let d = deadline;
  for (const f of [...flights].sort((a, b) => a.departAt.getTime() - b.departAt.getTime())) {
    const winStart = f.departAt.getTime() - BOARDING_LEAD_H * H;
    if (d.getTime() >= winStart && d.getTime() <= f.arriveAt.getTime() + LANDING_GRACE_H * H) {
      const moved = new Date(f.arriveAt.getTime() + LANDING_GRACE_H * H);
      if (moved > d) d = moved;
    }
  }
  return d;
}
