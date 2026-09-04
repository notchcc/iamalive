import { describe, expect, it } from 'vitest';

process.env.SESSION_SECRET = 'x';
const { toLegs, normalizeFlightNo } = await import('../src/flights-api.js');

const hkgLeg = {
  number: 'CX 451',
  airline: { name: 'Cathay Pacific' },
  departure: { airport: { iata: 'TPE', municipalityName: 'Taipei', timeZone: 'Asia/Taipei' }, scheduledTime: { utc: '2026-09-06 11:30Z', local: '2026-09-06 19:30+08:00' } },
  arrival: { airport: { iata: 'HKG', municipalityName: 'Hong Kong', timeZone: 'Asia/Shanghai' }, scheduledTime: { utc: '2026-09-06 13:30Z', local: '2026-09-06 21:30+08:00' } },
};

describe('toLegs', () => {
  it('uses API city names (translated) and corrects HKG timezone', () => {
    const [l] = toLegs([hkgLeg]);
    expect(l.flightNo).toBe('CX451');
    expect(l.fromCity).toBe('台北');
    expect(l.toCity).toBe('香港');
    expect(l.toTz).toBe('Asia/Hong_Kong');
    expect(l.departLocal).toBe('2026-09-06T19:30');
    expect(l.arriveUtc).toBe('2026-09-06T13:30:00.000Z');
  });
  it('dedupes identical legs and sorts by departure', () => {
    const later = JSON.parse(JSON.stringify(hkgLeg));
    later.departure.scheduledTime = { utc: '2026-09-07 11:30Z', local: '2026-09-07 19:30+08:00' };
    later.arrival.scheduledTime = { utc: '2026-09-07 13:30Z', local: '2026-09-07 21:30+08:00' };
    const legs = toLegs([later, hkgLeg, hkgLeg]);
    expect(legs).toHaveLength(2);
    expect(legs[0].departLocal).toBe('2026-09-06T19:30');
  });
  it('falls back to English city when unknown, skips cargo/incomplete', () => {
    const odd = JSON.parse(JSON.stringify(hkgLeg));
    odd.arrival.airport = { iata: 'XYZ', municipalityName: 'Somewhere', timeZone: 'Europe/Oslo' };
    const [l] = toLegs([odd, { ...hkgLeg, isCargo: true }, { number: 'X1' }]);
    expect(l.toCity).toBe('Somewhere');
    expect(normalizeFlightNo(' br 61 ')).toBe('BR61');
  });
});
