/**
 * /me 管理頁：寫入 token、狀態、建立/結束行程、備援打卡（定位或手動選點）、預告離線、家人連結。
 */
import L from 'leaflet';
import { ApiError, api, getToken, setToken } from './api';
import { renderFamilyPage } from './family';
import { createMap } from './mapview';
import { CITY_NAMES, TAIPEI, fmtBoth, fmtDateTime, toLocalInput } from './time';
import type { FlightInput, FlightJson, StatusJson, TripJson, WatcherJson } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderMePage(root: HTMLElement): () => void {
  let status: StatusJson | null = null;
  let watchers: WatcherJson[] = [];
  let familyCleanup: (() => void) | null = null;
  let pickMap: L.Map | null = null;
  let pickMarker: L.CircleMarker | null = null;
  let picked: { lat: number; lng: number } | null = null;

  const toast = (msg: string, kind: 'ok' | 'err' = 'ok'): void => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 4000);
  };

  const errText = (e: unknown): string => {
    if (e instanceof ApiError) {
      const map: Record<string, string> = {
        UNAUTHORIZED: 'token 錯誤',
        NO_ACTIVE_TRIP: '目前沒有進行中的行程',
        ACTIVE_TRIP_EXISTS: '已有進行中的行程',
        TRIP_NOT_ACTIVE: '行程不是進行中',
        VALIDATION: '欄位格式錯誤',
      };
      return map[e.code] ?? e.message;
    }
    return String((e as Error)?.message ?? e);
  };

  const renderGate = (): void => {
    root.innerHTML = `
      <div class="page me">
        <h1>iamalive 管理</h1>
        <form id="gate" class="card">
          <label>寫入 token<input name="token" type="password" autocomplete="off" required /></label>
          <button type="submit">進入</button>
          <p class="muted">token 只存在這台裝置的瀏覽器中。</p>
        </form>
      </div>`;
    root.querySelector<HTMLFormElement>('#gate')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget as HTMLFormElement);
      setToken(String(fd.get('token') ?? '').trim());
      await load();
    });
  };

  const load = async (): Promise<void> => {
    try {
      status = await api.status();
      watchers = status.activeTrip ? await api.watchers(status.activeTrip.id) : [];
      renderMain();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setToken('');
        renderGate();
        toast('token 錯誤', 'err');
      } else {
        toast(errText(e), 'err');
      }
    }
  };

  const renderMain = (): void => {
    if (!status) return;
    familyCleanup?.();
    familyCleanup = null;
    pickMap?.remove();
    pickMap = null;
    pickMarker = null;
    picked = null;

    const t = status.activeTrip;
    root.innerHTML = `
      <div class="page me">
        <h1>iamalive 管理 <button id="logout" class="link">登出</button></h1>

        <section class="card">
          <h2>系統狀態</h2>
          <div>LINE 群組：${status.groupBound ? '<b class="ok-text">已綁定</b>' : '<b class="bad-text">未綁定</b>（把官方帳號邀進家人群組）'}
            ${status.groupBound ? '<button id="unbind" class="link danger">解除綁定</button>' : ''}</div>
          <div>本月推播：${status.pushCount} / ${status.monthlyQuota}（${esc(status.monthKey)}）</div>
        </section>

        ${t ? renderTripSection(t) : renderCreateSection()}

        ${t ? `<section class="card"><h2>家人連結</h2><ul id="watchers"></ul>
          <form id="add-watcher" class="row"><input name="label" placeholder="稱呼（如 媽媽）" maxlength="20" required /><button>新增連結</button></form></section>` : ''}

        ${t ? `<section class="card"><h2>家人頁預覽</h2><div id="family-embed"></div></section>` : ''}
      </div>`;

    root.querySelector('#logout')!.addEventListener('click', () => {
      setToken('');
      renderGate();
    });
    root.querySelector('#unbind')?.addEventListener('click', async () => {
      if (!confirm('確定解除 LINE 群組綁定？之後重新邀請官方帳號進群組即可重綁。')) return;
      await api.unbindLine();
      await load();
    });

    if (t) bindTripSection(t);
    else bindCreateSection();

    if (t) {
      renderWatchers(t);
      root.querySelector<HTMLFormElement>('#add-watcher')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget as HTMLFormElement);
        try {
          await api.addWatcher(t.id, String(fd.get('label')));
          watchers = await api.watchers(t.id);
          renderWatchers(t);
          (e.target as HTMLFormElement).reset();
        } catch (err) {
          toast(errText(err), 'err');
        }
      });
      familyCleanup = renderFamilyPage(root.querySelector<HTMLElement>('#family-embed')!, t.groupReadToken);
    }
  };

  const renderTripSection = (t: TripJson): string => {
    const now = new Date();
    const deadline = new Date(t.nextDeadlineAt);
    const offline = t.offlineUntil ? new Date(t.offlineUntil) : null;
    return `
      <section class="card">
        <h2>${esc(t.title)} <span class="muted">每 ${t.intervalHours} 小時</span></h2>
        <div>${fmtDateTime(new Date(t.startAt), TAIPEI)} → ${fmtDateTime(new Date(t.endAt), TAIPEI)}（台北）</div>
        <div>最後回報：${t.lastCheckinAt ? `${t.lastCheckinPlace ? `📍 ${esc(t.lastCheckinPlace)} · ` : ''}${esc(fmtBoth(new Date(t.lastCheckinAt), t.travelerTz))}` : '尚無'}</div>
        <div>下次期限：${esc(fmtBoth(deadline, t.travelerTz))} ${deadline < now ? '<b class="bad-text">已逾時</b>' : ''}</div>
        ${offline && offline > now ? `<div>✈️ 預告離線至 ${esc(fmtBoth(offline, t.travelerTz))}</div>` : ''}
        ${t.alerted ? `<div class="bad-text">⚠️ 已發出逾時警報 ${t.alertCount} 則</div>` : ''}
      </section>

      <section class="card">
        <h2>備援打卡</h2>
        <label>備註<input id="note" maxlength="200" placeholder="可空" /></label>
        <label>下次回報（小時，可空）<input id="nextHours" type="number" min="1" max="168" step="1" /></label>
        <div class="row">
          <button id="gps">用瀏覽器定位打卡</button>
          <button id="pick-toggle" class="secondary">地圖選點</button>
        </div>
        <div id="pick-wrap" hidden>
          <div id="pick-map" class="map small"></div>
          <div class="row"><span id="pick-coord" class="muted">點地圖選擇位置</span><button id="pick-submit" disabled>以此位置打卡</button></div>
        </div>
      </section>

      <section class="card">
        <h2>航段 <span class="muted">飛行中不警報，落地後 3 小時內回報</span></h2>
        <ul id="flight-list" class="flight-list"></ul>
        <form id="add-flight">
          <div class="grid2">
            <label>航班號碼<input name="flightNo" maxlength="10" required placeholder="BR61" /></label>
            <label>起飛城市<input name="fromCity" maxlength="30" required placeholder="台北" /></label>
            <label>起飛時區<input name="fromTz" list="tzlist" required value="Asia/Taipei" /></label>
            <label>起飛時間（當地）<input name="departLocal" type="datetime-local" required /></label>
            <label>降落城市<input name="toCity" maxlength="30" required placeholder="維也納" /></label>
            <label>降落時區<input name="toTz" list="tzlist" required placeholder="Europe/Vienna" /></label>
            <label>降落時間（當地）<input name="arriveLocal" type="datetime-local" required /></label>
          </div>
          <button type="submit">新增航段</button>
          <datalist id="tzlist">${Object.entries(CITY_NAMES)
            .map(([tz, name]) => `<option value="${tz}">${esc(name)}</option>`)
            .join('')}</datalist>
        </form>
      </section>

      <section class="card">
        <h2>預告離線</h2>
        <form id="offline" class="row"><input name="hours" type="number" min="1" max="168" value="16" required /><span>小時</span><button>送出</button></form>
      </section>

      <section class="card">
        <h2>結束行程</h2>
        <button id="end" class="danger">結束並通知群組</button>
      </section>`;
  };

  const bindTripSection = (t: TripJson): void => {
    const noteEl = root.querySelector<HTMLInputElement>('#note')!;
    const nextEl = root.querySelector<HTMLInputElement>('#nextHours')!;
    const payloadExtras = () => ({
      note: noteEl.value.trim(),
      nextHours: nextEl.value ? Number(nextEl.value) : null,
      clientAt: new Date().toISOString(),
    });

    root.querySelector<HTMLButtonElement>('#gps')!.addEventListener('click', () => {
      const btn = root.querySelector<HTMLButtonElement>('#gps')!;
      btn.disabled = true;
      btn.textContent = '定位中…';
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const r = await api.checkin({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              source: 'web-gps',
              ...payloadExtras(),
            });
            toast(`已打卡，下次期限 ${fmtBoth(new Date(r.nextDeadlineAt), r.tz)}`);
            await load();
          } catch (e) {
            toast(errText(e), 'err');
          } finally {
            btn.disabled = false;
            btn.textContent = '用瀏覽器定位打卡';
          }
        },
        (err) => {
          btn.disabled = false;
          btn.textContent = '用瀏覽器定位打卡';
          toast(`定位失敗（${err.message}），請改用地圖選點`, 'err');
          showPicker(t);
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
      );
    });

    root.querySelector('#pick-toggle')!.addEventListener('click', () => showPicker(t));

    root.querySelector<HTMLButtonElement>('#pick-submit')!.addEventListener('click', async () => {
      if (!picked) return;
      try {
        const r = await api.checkin({ lat: picked.lat, lng: picked.lng, accuracy: null, source: 'manual', ...payloadExtras() });
        toast(`已打卡（手動選點），下次期限 ${fmtBoth(new Date(r.nextDeadlineAt), r.tz)}`);
        await load();
      } catch (e) {
        toast(errText(e), 'err');
      }
    });

    // ---- 航段 ----
    let flights: FlightJson[] = t.flights ?? [];
    const toInput = (f: FlightJson): FlightInput => ({
      flightNo: f.flightNo,
      fromCity: f.fromCity,
      fromTz: f.fromTz,
      departLocal: toLocalInput(new Date(f.departAt), f.fromTz),
      toCity: f.toCity,
      toTz: f.toTz,
      arriveLocal: toLocalInput(new Date(f.arriveAt), f.toTz),
    });
    const flightListEl = root.querySelector<HTMLElement>('#flight-list')!;
    const renderFlightList = (): void => {
      flightListEl.innerHTML = flights.length
        ? flights
            .map(
              (f, i) => `<li class="flight"><span class="fno">${esc(f.flightNo)}</span>
                <span class="leg">${esc(f.fromCity)} ${esc(f.departLocal)} → ${esc(f.toCity)} ${esc(f.arriveLocal)}</span>
                <button type="button" class="danger" data-del-flight="${i}">刪除</button></li>`,
            )
            .join('')
        : '<li class="muted">尚無航段</li>';
      flightListEl.querySelectorAll<HTMLButtonElement>('[data-del-flight]').forEach((b) =>
        b.addEventListener('click', async () => {
          const idx = Number(b.dataset.delFlight);
          if (!confirm(`刪除航段 ${flights[idx].flightNo}？`)) return;
          try {
            const r = await api.setFlights(t.id, flights.filter((_, i) => i !== idx).map(toInput));
            flights = r.flights;
            renderFlightList();
            toast('已更新航段');
          } catch (err) {
            toast(errText(err), 'err');
          }
        }),
      );
    };
    renderFlightList();

    const flightForm = root.querySelector<HTMLFormElement>('#add-flight')!;
    // 選了時區就把空白的城市欄位帶入城市名
    for (const [tzName, cityName] of [
      ['fromTz', 'fromCity'],
      ['toTz', 'toCity'],
    ] as const) {
      const tzEl = flightForm.elements.namedItem(tzName) as HTMLInputElement;
      tzEl.addEventListener('change', () => {
        const tz = tzEl.value;
        const cityEl = flightForm.elements.namedItem(cityName) as HTMLInputElement;
        if (!cityEl.value && CITY_NAMES[tz]) cityEl.value = CITY_NAMES[tz];
      });
    }
    flightForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(flightForm);
      const input: FlightInput = {
        flightNo: String(fd.get('flightNo')).trim().toUpperCase(),
        fromCity: String(fd.get('fromCity')).trim(),
        fromTz: String(fd.get('fromTz')).trim(),
        departLocal: String(fd.get('departLocal')),
        toCity: String(fd.get('toCity')).trim(),
        toTz: String(fd.get('toTz')).trim(),
        arriveLocal: String(fd.get('arriveLocal')),
      };
      try {
        const r = await api.setFlights(t.id, [...flights.map(toInput), input]);
        flights = r.flights;
        renderFlightList();
        flightForm.reset();
        (flightForm.elements.namedItem('fromTz') as HTMLInputElement).value = input.toTz; // 下一段通常從上一段的目的地出發
        (flightForm.elements.namedItem('fromCity') as HTMLInputElement).value = input.toCity;
        toast('已新增航段');
      } catch (err) {
        toast(errText(err), 'err');
      }
    });

    root.querySelector<HTMLFormElement>('#offline')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hours = Number(new FormData(e.currentTarget as HTMLFormElement).get('hours'));
      try {
        const r = await api.offline(t.id, hours);
        toast(`已預告離線至 ${fmtBoth(new Date(r.offlineUntil), t.travelerTz)}`);
        await load();
      } catch (err) {
        toast(errText(err), 'err');
      }
    });

    root.querySelector('#end')!.addEventListener('click', async () => {
      if (!confirm('確定結束行程？會通知群組並停止逾時偵測。')) return;
      try {
        await api.end(t.id);
        toast('行程已結束');
        await load();
      } catch (e) {
        toast(errText(e), 'err');
      }
    });
  };

  const showPicker = (t: TripJson): void => {
    const wrap = root.querySelector<HTMLElement>('#pick-wrap')!;
    wrap.hidden = false;
    if (pickMap) return;
    pickMap = createMap(root.querySelector<HTMLElement>('#pick-map')!);
    const coordEl = root.querySelector<HTMLElement>('#pick-coord')!;
    const submit = root.querySelector<HTMLButtonElement>('#pick-submit')!;
    const center: [number, number] = t.lastCheckinGeo ? [t.lastCheckinGeo.lat, t.lastCheckinGeo.lng] : [25.04, 121.56];
    pickMap.setView(center, t.lastCheckinGeo ? 13 : 10);
    pickMap.on('click', (ev: L.LeafletMouseEvent) => {
      picked = { lat: ev.latlng.lat, lng: ev.latlng.lng };
      if (!pickMarker) pickMarker = L.circleMarker(ev.latlng, { radius: 8, color: '#b91c1c', fillColor: '#ef4444', fillOpacity: 0.9 }).addTo(pickMap!);
      else pickMarker.setLatLng(ev.latlng);
      coordEl.textContent = `${picked.lat.toFixed(5)}, ${picked.lng.toFixed(5)}`;
      submit.disabled = false;
    });
    window.setTimeout(() => pickMap?.invalidateSize(), 50);
  };

  const renderCreateSection = (): string => {
    const start = new Date();
    const end = new Date(start.getTime() + 7 * 86_400_000);
    return `
      <section class="card">
        <h2>建立行程</h2>
        <form id="create">
          <label>名稱<input name="title" maxlength="60" required placeholder="例：東京五日" /></label>
          <label>開始<input name="startAt" type="datetime-local" value="${toLocalInputValue(start)}" required /></label>
          <label>結束<input name="endAt" type="datetime-local" value="${toLocalInputValue(end)}" required /></label>
          <label>打卡間隔（小時）<input name="intervalHours" type="number" min="1" max="72" value="12" required /></label>
          <button type="submit">建立並通知群組</button>
          <p class="muted">時間以此裝置目前時區輸入，儲存為絕對時間。</p>
        </form>
      </section>`;
  };

  const bindCreateSection = (): void => {
    root.querySelector<HTMLFormElement>('#create')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget as HTMLFormElement);
      try {
        await api.createTrip({
          title: String(fd.get('title')),
          startAt: new Date(String(fd.get('startAt'))).toISOString(),
          endAt: new Date(String(fd.get('endAt'))).toISOString(),
          intervalHours: Number(fd.get('intervalHours')),
        });
        toast('行程已建立');
        await load();
      } catch (err) {
        toast(errText(err), 'err');
      }
    });
  };

  const renderWatchers = (t: TripJson): void => {
    const ul = root.querySelector<HTMLElement>('#watchers')!;
    ul.innerHTML = watchers
      .map(
        (w) => `<li class="row">
          <span><b>${esc(w.label)}</b>${w.token === t.groupReadToken ? ' <span class="muted">（群組訊息用）</span>' : ''}</span>
          <input readonly value="${esc(w.url)}" />
          <button class="secondary" data-copy="${esc(w.url)}">複製</button>
          ${w.token === t.groupReadToken ? '' : `<button class="danger" data-del="${esc(w.token)}">撤銷</button>`}
        </li>`,
      )
      .join('');
    ul.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy!);
          toast('已複製');
        } catch {
          toast('無法複製，請手動選取', 'err');
        }
      }),
    );
    ul.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('撤銷這條連結？對方將無法再查看。')) return;
        try {
          await api.removeWatcher(t.id, b.dataset.del!);
          watchers = await api.watchers(t.id);
          renderWatchers(t);
        } catch (e) {
          toast(errText(e), 'err');
        }
      }),
    );
  };

  if (getToken()) void load();
  else renderGate();

  return () => {
    familyCleanup?.();
    pickMap?.remove();
  };
}
