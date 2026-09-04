import type { StatusJson, TripJson, WatcherJson } from './types';

const TOKEN_KEY = 'iamalive.writeToken';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(t: string): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

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
    headers: {
      'content-type': 'application/json',
      'x-write-token': getToken(),
    },
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

export const api = {
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
  offline: (id: string, hours: number) =>
    call<{ ok: true; offlineUntil: string; nextDeadlineAt: string; pushed: boolean }>('POST', `/trips/${id}/offline`, { hours }),
  end: (id: string) => call<{ ok: true; pushed: boolean }>('POST', `/trips/${id}/end`),
  watchers: (id: string) => call<WatcherJson[]>('GET', `/trips/${id}/watchers`),
  addWatcher: (id: string, label: string) => call<{ token: string; url: string }>('POST', `/trips/${id}/watchers`, { label }),
  removeWatcher: (id: string, token: string) => call<{ ok: true }>('DELETE', `/trips/${id}/watchers/${token}`),
  unbindLine: () => call<{ ok: true }>('POST', '/line/unbind'),
};
