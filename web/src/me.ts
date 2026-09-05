/**
 * /me 管理頁，分兩個頁籤：行程管理（建立/結束、頻率、航段、預告離線）、參數設定（打卡頁與家人頁連結、群組綁定、捷徑金鑰、帳號）。
 * 打卡本身不在管理頁：用 /c/{token} 打卡頁、LINE 位置訊息或捷徑。
 */
import { ApiError, api } from './api';
import { getLiff } from './liff';
import { CITY_NAMES, TAIPEI, fmtBoth, fmtDateTime, toLocalInput } from './time';
import type { FlightInput, FlightJson, FlightLegJson, KeyJson, StatusJson, TripJson } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const TZ_GROUPS: Array<[string, string]> = [
  ['亞洲', 'Asia/'],
  ['歐洲', 'Europe/'],
  ['美洲', 'America/'],
  ['大洋洲', 'Australia/'],
  ['太平洋', 'Pacific/'],
];

function tzSelect(name: string, selected: string): string {
  const groups = TZ_GROUPS.map(([label, prefix]) => {
    const opts = Object.entries(CITY_NAMES)
      .filter(([tz]) => tz.startsWith(prefix))
      .map(([tz, city]) => `<option value="${tz}"${tz === selected ? ' selected' : ''}>${esc(city)} · ${tz}</option>`)
      .join('');
    return `<optgroup label="${label}">${opts}</optgroup>`;
  }).join('');
  return `<select name="${name}" required>
    <option value=""${selected ? '' : ' selected'} disabled>選擇時區</option>${groups}
    <option value="__custom">其他（手動輸入 IANA 名稱）</option>
  </select>`;
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderMePage(root: HTMLElement): () => void {
  let status: StatusJson | null = null;
  let keys: KeyJson[] = [];

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
        UNAUTHORIZED: '尚未登入或登入已過期',
        CSRF: '請重新整理頁面後再試',
        TOO_MANY_KEYS: '金鑰最多 10 把',
        KEY_NOT_FOUND: '找不到這把金鑰',
        NO_ACTIVE_TRIP: '目前沒有進行中的行程',
        ACTIVE_TRIP_EXISTS: '已有進行中的行程',
        TRIP_NOT_ACTIVE: '行程不是進行中',
        VALIDATION: '欄位格式錯誤',
        PHOTO_REQUIRED: '沒有收到照片',
        UNSUPPORTED_IMAGE_TYPE: '不支援的圖片格式',
        FILE_TOO_LARGE: '照片超過 8 MB',
        CHECKIN_NOT_FOUND: '找不到這筆打卡',
        FLIGHT_LOOKUP_UNAVAILABLE: '航班查詢未設定金鑰',
        FLIGHT_LOOKUP_QUOTA: '航班查詢額度已用完，請改用手動輸入',
        FLIGHT_LOOKUP_FAILED: '航班查詢失敗，請稍後再試或手動輸入',
      };
      return map[e.code] ?? e.message;
    }
    return String((e as Error)?.message ?? e);
  };

  const renderGate = async (): Promise<void> => {
    const q = new URLSearchParams(location.search);
    const hint = q.get('login') === 'denied' ? '你取消了 LINE 授權。' : q.get('login') === 'invalid' ? '登入連結已失效，請再試一次。' : '';
    const liff = await getLiff();
    root.innerHTML = `
      <div class="page me">
        <h1>iamalive 管理</h1>
        <div class="card login">
          <p>用 LINE 帳號登入後即可建立行程、綁定家人群組、產生捷徑金鑰。</p>
          ${hint ? `<p class="bad-text">${esc(hint)}</p>` : ''}
          ${liff ? `<button id="liff-login" class="btn-line" type="button">用 LINE 登入</button>
            <p class="muted small or">或 <a href="/api/auth/line/start">改用瀏覽器授權頁登入</a></p>` : `<a class="btn-line" href="/api/auth/line/start">用 LINE 登入</a>`}
          <p class="muted small">登入狀態保留 30 天。從 LINE 內開啟管理頁會自動登入。</p>
        </div>
      </div>`;
    root.querySelector('#liff-login')?.addEventListener('click', () => {
      liff?.login({ redirectUri: `${location.origin}/me` });
    });
  };

  /** LIFF 已登入（LINE 內開啟或 liff.login 回來）→ 用 ID token 換 session cookie。 */
  const tryLiffLogin = async (): Promise<boolean> => {
    const liff = await getLiff();
    if (!liff || !liff.isLoggedIn()) return false;
    const idToken = liff.getIDToken();
    if (!idToken) return false;
    try {
      await api.liffLogin(idToken);
      return true;
    } catch (e) {
      // ID token 過期或無效：清掉 LIFF 登入狀態，讓使用者重新登入拿新 token
      console.warn('liff login exchange failed', e);
      try {
        liff.logout();
      } catch {
        /* ignore */
      }
      return false;
    }
  };
  let liffTried = false;

  const load = async (): Promise<void> => {
    try {
      status = await api.status();
      keys = await api.keys();
      renderMain();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (!liffTried) {
          liffTried = true;
          if (await tryLiffLogin()) return load();
        }
        await renderGate();
      } else {
        toast(errText(e), 'err');
      }
    }
  };

  type Tab = 'trip' | 'settings';
  const TABS: Array<[Tab, string]> = [
    ['trip', '行程管理'],
    ['settings', '參數設定'],
  ];
  const tabFromHash = (): Tab | null => {
    const h = location.hash.replace(/^#/, '');
    return TABS.some(([k]) => k === h) ? (h as Tab) : null;
  };

  const renderMain = (): void => {
    if (!status) return;

    const t = status.activeTrip;
    const u = status.user;
    root.innerHTML = `
      <div class="page me">
        <h1>iamalive 管理
          <span class="who">${u.pictureUrl ? `<img class="avatar" src="${esc(u.pictureUrl)}" alt="" />` : ''}${esc(u.displayName ?? u.uid)}</span></h1>

        <nav class="tabs" role="tablist">
          ${TABS.map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="false">${label}</button>`).join('')}
        </nav>

        <section class="pane" data-pane="trip" hidden>${t ? renderTripPane(t) : renderCreateSection()}</section>
        <section class="pane" data-pane="settings" hidden>${renderSettingsPane()}</section>
      </div>`;

    // ---- 頁籤 ----
    const panes = [...root.querySelectorAll<HTMLElement>('.pane')];
    const tabBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
    const showTab = (k: Tab): void => {
      panes.forEach((p) => (p.hidden = p.dataset.pane !== k));
      tabBtns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
      history.replaceState(null, '', `#${k}`);
    };
    tabBtns.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab as Tab)));
    root.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto as Tab)));

    bindSettingsPane();
    if (t) bindTripSection(t);
    else bindCreateSection();

    showTab(tabFromHash() ?? 'trip');
  };

  // ---- 連結卡片（打卡頁、家人頁）：放在參數設定頁籤 ----
  const renderLinkCards = (t: TripJson): string => `
      <section class="card">
        <h2>打卡頁 <span class="muted">免登入，加到主畫面當捷徑</span></h2>
        <div class="row"><input id="checkin-url" readonly value="${esc(t.checkinUrl ?? '')}" /><button id="copy-checkin-url" class="secondary" type="button">複製</button><a class="btn-link" href="${esc(t.checkinUrl ?? '#')}" target="_blank" rel="noopener">開啟</a></div>
        <p class="muted small">iPhone：用 Safari 開啟連結 → 分享 → 加入主畫面，之後點圖示就能定位或拍照打卡。持有連結的人都能替這趟行程打卡，外洩就按輪替。</p>
        <button id="rotate-checkin" class="danger" type="button">輪替連結（舊連結失效）</button>
      </section>

      <section class="card">
        <h2>家人頁連結 <span class="muted">群組訊息內附的同一條</span></h2>
        <div class="row"><input id="family-url" readonly value="${esc(t.familyUrl)}" /><button id="copy-family-url" class="secondary" type="button">複製</button><a class="btn-link" href="${esc(t.familyUrl)}" target="_blank" rel="noopener">開啟</a></div>
        <p class="muted small">持有連結者可看地圖與時間軸。要收回請結束行程，下一趟會有新連結。</p>
      </section>`;

  // ---- 參數設定頁籤：連結、群組綁定、金鑰、帳號 ----
  const renderSettingsPane = (): string => {
    if (!status) return '';
    const u = status.user;
    const t = status.activeTrip;
    return `
      ${t ? renderLinkCards(t) : ''}
      <section class="card">
        <h2>家人 LINE 群組</h2>
        ${
          status.groupBound
            ? `<div><b class="ok-text">已綁定</b> <button id="unbind" class="link danger">解除綁定</button></div>`
            : `<div><b class="bad-text">尚未綁定</b></div>
               <ol class="steps">
                 <li>把官方帳號 <b>@574stmif</b>（iamalive）邀請進家人群組</li>
                 <li>按下方按鈕取得 6 位數綁定碼</li>
                 <li>由你本人在群組輸入「綁定 123456」</li>
               </ol>
               <div class="row"><button id="bind-code">產生綁定碼</button><span id="bind-code-out" class="bind-code"></span></div>`
        }
        <div class="muted small">回報期限前 1 小時，官方帳號會私訊提醒你本人（需先加 <b>@574stmif</b> 為好友）。</div>
        <div class="muted small">本月推播 ${status.pushCount} / ${status.monthlyQuota}（${esc(status.monthKey)}，所有使用者共用，含提醒私訊）</div>
      </section>

      <section class="card">
        <h2>捷徑金鑰 <span class="muted">給 iOS 捷徑用的 X-Api-Key</span></h2>
        <ul id="keys" class="key-list"></ul>
        <form id="add-key" class="row"><input name="label" placeholder="標籤（如 iPhone 15）" maxlength="30" required /><button>產生金鑰</button></form>
        <div id="new-key" hidden></div>
      </section>

      <section class="card">
        <h2>帳號</h2>
        <div class="row">
          <span>${u.pictureUrl ? `<img class="avatar" src="${esc(u.pictureUrl)}" alt="" /> ` : ''}${esc(u.displayName ?? u.uid)} <span class="muted small">（LINE 登入，保留 30 天）</span></span>
          <button id="logout" class="secondary">登出</button>
        </div>
      </section>`;
  };

  const bindSettingsPane = (): void => {
    root.querySelector('#logout')!.addEventListener('click', async () => {
      await api.logout().catch(() => undefined);
      const liff = await getLiff();
      if (liff?.isLoggedIn()) {
        try {
          liff.logout();
        } catch {
          /* ignore */
        }
      }
      liffTried = true; // 登出後不要又自動用 LIFF 登回去
      await renderGate();
    });
    root.querySelector('#unbind')?.addEventListener('click', async () => {
      if (!confirm('確定解除 LINE 群組綁定？之後重新產生綁定碼即可重綁。')) return;
      await api.unbindLine();
      await load();
    });
    root.querySelector<HTMLButtonElement>('#bind-code')?.addEventListener('click', async () => {
      const out = root.querySelector<HTMLElement>('#bind-code-out')!;
      try {
        const r = await api.bindCode();
        out.textContent = `綁定 ${r.code}`;
        out.title = `10 分鐘內有效`;
        toast('在群組輸入這串文字即可綁定（10 分鐘內）');
      } catch (e) {
        toast(errText(e), 'err');
      }
    });

    const renderKeys = (): void => {
      const ul = root.querySelector<HTMLElement>('#keys')!;
      ul.innerHTML = keys.length
        ? keys
            .map(
              (k) => `<li class="row"><span><b>${esc(k.label)}</b> <code>${esc(k.prefix)}…</code></span>
                <span class="muted small">建立 ${esc(fmtDateTime(new Date(k.createdAt), TAIPEI))}${k.lastUsedAt ? ` · 最後使用 ${esc(fmtDateTime(new Date(k.lastUsedAt), TAIPEI))}` : ' · 尚未使用'}</span>
                <button class="danger" data-revoke="${esc(k.id)}">撤銷</button></li>`,
            )
            .join('')
        : '<li class="muted">尚無金鑰。產生一把後填進捷徑的 X-Api-Key。</li>';
      ul.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('撤銷這把金鑰？使用它的捷徑會立刻失效。')) return;
          try {
            await api.revokeKey(b.dataset.revoke!);
            keys = await api.keys();
            renderKeys();
          } catch (e) {
            toast(errText(e), 'err');
          }
        }),
      );
    };
    renderKeys();
    root.querySelector<HTMLFormElement>('#add-key')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const label = String(new FormData(form).get('label') ?? '').trim();
      try {
        const r = await api.createKey(label);
        keys = await api.keys();
        renderKeys();
        form.reset();
        const box = root.querySelector<HTMLElement>('#new-key')!;
        box.hidden = false;
        box.innerHTML = `<div class="new-key"><div>「${esc(r.label)}」的金鑰只會顯示這一次，請立刻複製到捷徑：</div>
          <div class="row"><input readonly value="${esc(r.key)}" /><button class="secondary" id="copy-key">複製</button></div></div>`;
        box.querySelector('#copy-key')!.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(r.key);
            toast('已複製');
          } catch {
            toast('無法複製，請手動選取', 'err');
          }
        });
      } catch (err) {
        toast(errText(err), 'err');
      }
    });
  };

  // ---- 共用：行程摘要卡 ----
  const renderTripSummary = (t: TripJson): string => {
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
      </section>`;
  };

  // ---- 行程管理頁籤：摘要、頻率、航段、預告離線、結束行程 ----
  const renderTripPane = (t: TripJson): string => `
      ${renderTripSummary(t)}

      <section class="card">
        <h2>航段 <span class="muted">飛行中不警報，落地後 3 小時內回報</span></h2>
        <ul id="flight-list" class="flight-list"></ul>
        <form id="lookup-flight" class="lookup">
          <div class="row">
            <input name="flightNo" placeholder="航班號碼，如 BR61" maxlength="8" required style="max-width:160px" />
            <input name="date" type="date" required style="max-width:170px" />
            <button type="submit">查詢航班</button>
          </div>
          <div id="lookup-result"></div>
        </form>
        <details class="manual"><summary class="muted">手動輸入航段</summary>
        <form id="add-flight">
          <div class="grid2">
            <label>航班號碼<input name="flightNo" maxlength="10" required placeholder="BR61" /></label>
            <label>起飛城市<input name="fromCity" maxlength="30" required placeholder="台北" /></label>
            <label>起飛時區${tzSelect('fromTz', 'Asia/Taipei')}<input class="tz-custom" name="fromTzCustom" placeholder="IANA 時區，如 Europe/Oslo" hidden /></label>
            <label>起飛時間（當地）<input name="departLocal" type="datetime-local" required /></label>
            <label>降落城市<input name="toCity" maxlength="30" required placeholder="蘇黎世" /></label>
            <label>降落時區${tzSelect('toTz', '')}<input class="tz-custom" name="toTzCustom" placeholder="IANA 時區，如 Europe/Oslo" hidden /></label>
            <label>降落時間（當地）<input name="arriveLocal" type="datetime-local" required /></label>
          </div>
          <button type="submit">新增航段</button>
        </form>
        </details>
      </section>

      <section class="card">
        <h2>打卡頻率 <span class="muted">目前每 ${t.intervalHours} 小時</span></h2>
        <form id="interval" class="row"><input name="hours" type="number" min="1" max="72" value="${t.intervalHours}" required /><span>小時</span><button>更改並重算期限</button></form>
        <p class="muted small">期限會立即改為「最後打卡 + 新間隔」；若已經過了，則為現在 + 新間隔。不會通知群組。</p>
      </section>

      <section class="card">
        <h2>預告離線</h2>
        <form id="offline" class="row"><input name="hours" type="number" min="1" max="168" value="16" required /><span>小時</span><button>送出</button></form>
      </section>


      <section class="card">
        <h2>結束行程</h2>
        <button id="end" class="danger">結束並通知群組</button>
      </section>`;

  const bindTripSection = (t: TripJson): void => {
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
                <span class="leg">${esc(f.fromCity)} <small>${esc(f.fromTz)}</small> ${esc(f.departLocal)} → ${esc(f.toCity)} <small>${esc(f.toTz)}</small> ${esc(f.arriveLocal)}</span>
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

    // ---- 航班查詢 → 勾選加入 ----
    const lookupForm = root.querySelector<HTMLFormElement>('#lookup-flight')!;
    const lookupOut = root.querySelector<HTMLElement>('#lookup-result')!;
    (lookupForm.elements.namedItem('date') as HTMLInputElement).value = new Date(t.startAt).toISOString().slice(0, 10);
    lookupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(lookupForm);
      const flightNo = String(fd.get('flightNo') ?? '').trim().toUpperCase();
      const date = String(fd.get('date') ?? '');
      lookupOut.innerHTML = '<p class="muted">查詢中…</p>';
      let legs: FlightLegJson[] = [];
      try {
        legs = (await api.lookupFlight(flightNo, date)).legs;
      } catch (err) {
        lookupOut.innerHTML = `<p class="bad-text">${esc(errText(err))}</p>`;
        return;
      }
      if (!legs.length) {
        lookupOut.innerHTML = '<p class="muted">查不到這個航班。確認班號與出發日期，或改用下方手動輸入。</p>';
        return;
      }
      const otherDay = legs.some((l) => !l.departLocal.startsWith(date));
      lookupOut.innerHTML = `${otherDay ? '<p class="muted small">灰色未勾選的是其他日期出發的班次，需要再自行勾選。</p>' : ''}<ul class="legs">${legs
        .map(
          (l, i) => `<li><label class="leg-pick"><input type="checkbox" data-leg="${i}"${l.departLocal.startsWith(date) ? ' checked' : ''} />
            <span><b>${esc(l.flightNo)}</b> ${esc(l.airline ?? '')}<br>
            ${esc(l.fromCity)}（${esc(l.fromIata)}）${esc(l.departLocal.replace('T', ' '))} → ${esc(l.toCity)}（${esc(l.toIata)}）${esc(l.arriveLocal.replace('T', ' '))}
            <small class="muted">各地當地時間 · ${esc(l.fromTz)} → ${esc(l.toTz)}</small></span></label></li>`,
        )
        .join('')}</ul>
        <div class="row"><button type="button" id="add-legs">加入勾選的航段</button></div>`;
      lookupOut.querySelector<HTMLButtonElement>('#add-legs')!.addEventListener('click', async () => {
        const picked = [...lookupOut.querySelectorAll<HTMLInputElement>('[data-leg]:checked')].map((c) => legs[Number(c.dataset.leg)]);
        if (!picked.length) return;
        const inputs: FlightInput[] = picked.map((l) => ({
          flightNo: l.flightNo,
          fromCity: l.fromCity,
          fromTz: l.fromTz,
          departLocal: l.departLocal,
          toCity: l.toCity,
          toTz: l.toTz,
          arriveLocal: l.arriveLocal,
        }));
        try {
          const r = await api.setFlights(t.id, [...flights.map(toInput), ...inputs]);
          flights = r.flights;
          renderFlightList();
          lookupOut.innerHTML = '';
          lookupForm.reset();
          toast(`已加入 ${inputs.length} 段`);
        } catch (err) {
          toast(errText(err), 'err');
        }
      });
    });

    const flightForm = root.querySelector<HTMLFormElement>('#add-flight')!;
    // 選了時區就把空白的城市欄位帶入城市名
    const tzValue = (name: 'fromTz' | 'toTz'): string => {
      const sel = (flightForm.elements.namedItem(name) as HTMLSelectElement).value;
      if (sel !== '__custom') return sel;
      return (flightForm.elements.namedItem(`${name}Custom`) as HTMLInputElement).value.trim();
    };
    for (const [tzName, cityName] of [
      ['fromTz', 'fromCity'],
      ['toTz', 'toCity'],
    ] as const) {
      const sel = flightForm.elements.namedItem(tzName) as HTMLSelectElement;
      const custom = flightForm.elements.namedItem(`${tzName}Custom`) as HTMLInputElement;
      sel.addEventListener('change', () => {
        custom.hidden = sel.value !== '__custom';
        custom.required = sel.value === '__custom';
        const cityEl = flightForm.elements.namedItem(cityName) as HTMLInputElement;
        // 選了時區就帶入城市名（若城市欄為空或仍是上一個時區的城市名）
        const prev = cityEl.dataset.auto;
        if (CITY_NAMES[sel.value] && (!cityEl.value || cityEl.value === prev)) {
          cityEl.value = CITY_NAMES[sel.value];
          cityEl.dataset.auto = cityEl.value;
        }
      });
    }
    flightForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(flightForm);
      const input: FlightInput = {
        flightNo: String(fd.get('flightNo')).trim().toUpperCase(),
        fromCity: String(fd.get('fromCity')).trim(),
        fromTz: tzValue('fromTz'),
        departLocal: String(fd.get('departLocal')),
        toCity: String(fd.get('toCity')).trim(),
        toTz: tzValue('toTz'),
        arriveLocal: String(fd.get('arriveLocal')),
      };
      try {
        const r = await api.setFlights(t.id, [...flights.map(toInput), input]);
        flights = r.flights;
        renderFlightList();
        flightForm.reset();
        // 下一段通常從上一段的目的地出發
        const fromSel = flightForm.elements.namedItem('fromTz') as HTMLSelectElement;
        if ([...fromSel.options].some((o) => o.value === input.toTz)) fromSel.value = input.toTz;
        (flightForm.elements.namedItem('fromCity') as HTMLInputElement).value = input.toCity;
        toast('已新增航段');
      } catch (err) {
        toast(errText(err), 'err');
      }
    });

    root.querySelector('#copy-family-url')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(t.familyUrl);
        toast('已複製');
      } catch {
        toast('無法複製，請手動選取', 'err');
      }
    });
    root.querySelector('#copy-checkin-url')!.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(t.checkinUrl ?? '');
        toast('已複製');
      } catch {
        toast('無法複製，請手動選取', 'err');
      }
    });
    root.querySelector('#rotate-checkin')!.addEventListener('click', async () => {
      if (!confirm('輪替打卡頁連結？已加到主畫面的舊捷徑會失效，要重新加入。')) return;
      try {
        await api.rotateCheckinToken(t.id);
        toast('已產生新連結');
        await load();
      } catch (err) {
        toast(errText(err), 'err');
      }
    });

    root.querySelector<HTMLFormElement>('#interval')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hours = Number(new FormData(e.currentTarget as HTMLFormElement).get('hours'));
      if (hours === t.intervalHours) return;
      try {
        const r = await api.setInterval(t.id, hours);
        toast(`已改為每 ${r.intervalHours} 小時，下次期限 ${fmtBoth(new Date(r.nextDeadlineAt), t.travelerTz)}`);
        await load();
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

  void load();

  return () => {
    /* 無需清理 */
  };
}
