import type { CheckinPageJson, FlightInput, FlightJson, FlightLegJson, KeyJson, StatusJson, TripJson, UserJson, WatcherJson } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let code = res.statusText;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

async function callForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  if (!res.ok) {
    let code = res.statusText;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export interface CheckinBody {
  lat: number;
  lng: number;
  accuracy?: number | null;
  source: 'web-gps' | 'manual';
  note?: string;
  nextHours?: number | null;
  clientAt?: string;
}
export interface CheckinResult {
  ok: true;
  nextDeadlineAt: string;
  tz: string;
  pushed: boolean;
  recovered: boolean;
}

export const api = {
  me: () => call<UserJson>('GET', '/auth/me'),
  /** LIFF：以 liff.getIDToken() 換 session cookie。 */
  liffLogin: (idToken: string) => call<{ ok: true; uid: string }>('POST', '/auth/liff', { idToken }),
  rotateCheckinToken: (id: string) =>
    call<{ ok: true; checkinToken: string; checkinUrl: string }>('POST', `/trips/${id}/checkin-token/rotate`),
  /** 免登入打卡頁（/c/{token}）。 */
  checkinPage: {
    get: (token: string) => call<CheckinPageJson>('GET', `/c/${encodeURIComponent(token)}`),
    checkin: (token: string, body: CheckinBody) => call<CheckinResult>('POST', `/c/${encodeURIComponent(token)}/checkin`, body),
    photo: (token: string, form: FormData) => callForm<CheckinResult & { photoId: string }>(`/c/${encodeURIComponent(token)}/checkin/photo`, form),
  },
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  keys: () => call<KeyJson[]>('GET', '/keys'),
  createKey: (label: string) => call<{ id: string; key: string; label: string }>('POST', '/keys', { label }),
  revokeKey: (id: string) => call<{ ok: true }>('DELETE', `/keys/${id}`),
  bindCode: () => call<{ code: string; expiresAt: string }>('POST', '/line/bind-code'),
  status: () => call<StatusJson>('GET', '/status'),
  trips: () => call<TripJson[]>('GET', '/trips'),
  createTrip: (input: { title: string; startAt: string; endAt: string; intervalHours: number }) =>
    call<TripJson>('POST', '/trips', input),
  checkin: (input: {
    lat: number;
    lng: number;
    accuracy?: number | null;
    source: 'web-gps' | 'manual';
    note?: string;
    nextHours?: number | null;
    clientAt?: string;
  }) => call<{ ok: true; nextDeadlineAt: string; tz: string; pushed: boolean; recovered: boolean }>('POST', '/checkin', input),
  /** 照片打卡：multipart，欄位由呼叫端組好（photo、lat、lng、note、nextHours、takenAt、clientAt）。 */
  checkinPhoto: async (form: FormData) => {
    const res = await fetch('/api/checkin/photo', { method: 'POST', credentials: 'same-origin', body: form });
    if (!res.ok) {
      let code = res.statusText;
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as { ok: true; photoId: string; nextDeadlineAt: string; tz: string; pushed: boolean; recovered: boolean };
  },
  deleteCheckin: (id: string, checkinId: string) => call<{ ok: true }>('DELETE', `/trips/${id}/checkins/${checkinId}`),
  offline: (id: string, hours: number) =>
    call<{ ok: true; offlineUntil: string; nextDeadlineAt: string; pushed: boolean }>('POST', `/trips/${id}/offline`, { hours }),
  lookupFlight: (flightNo: string, date: string) =>
    call<{ legs: FlightLegJson[] }>('GET', `/flights/lookup?flightNo=${encodeURIComponent(flightNo)}&date=${encodeURIComponent(date)}`),
  setFlights: (id: string, flights: FlightInput[]) => call<{ ok: true; flights: FlightJson[] }>('PUT', `/trips/${id}/flights`, { flights }),
  setInterval: (id: string, hours: number) =>
    call<{ ok: true; intervalHours: number; nextDeadlineAt: string }>('PATCH', `/trips/${id}`, { intervalHours: hours }),
  end: (id: string) => call<{ ok: true; pushed: boolean }>('POST', `/trips/${id}/end`),
  watchers: (id: string) => call<WatcherJson[]>('GET', `/trips/${id}/watchers`),
  addWatcher: (id: string, label: string) => call<{ token: string; url: string }>('POST', `/trips/${id}/watchers`, { label }),
  removeWatcher: (id: string, token: string) => call<{ ok: true }>('DELETE', `/trips/${id}/watchers/${token}`),
  unbindLine: () => call<{ ok: true }>('POST', '/line/unbind'),
};
