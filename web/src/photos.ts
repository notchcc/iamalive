/**
 * 照片回顧頁 /p/{photoToken}：這趟旅程所有有照片的打卡。
 * - 網格檢視（預設）：像手機圖庫，依裝置寬度自動決定每列張數，按打卡當地日期分組，捲到底再載入更多
 * - 地圖檢視：像 iPhone 圖庫的地圖，照片縮圖聚合成群，點群放大、放到底或單張就開全螢幕
 * - 兩種模式點照片都進全螢幕檢視（X / 下載 / 左右滑動）
 */
import L from 'leaflet';
import { createLightbox, type ViewerItem } from './lightbox';
import { tileLayer } from './mapview';
import { applyPwaIdentity } from './pwa';
import { renderShareBar } from './share';
import { fmtDateTime } from './time';

interface PhotoJson {
  id: string;
  lat: number;
  lng: number;
  tz: string;
  place: string | null;
  placeEn?: string | null;
  note: string;
  photoId: string;
  takenAt: string | null;
  at: string;
}

type Mode = 'grid' | 'map';
const PAGE = 50;
const MAX_PHOTOS = 1000;
const CLUSTER_PX = 64;
const MAX_ZOOM = 17;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function dayKey(p: PhotoJson): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: p.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.at));
}
function dayLabel(p: PhotoJson): string {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: p.tz, month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(p.at));
}
function city(p: PhotoJson): string {
  return (p.place ?? '').split(',')[0].trim();
}
function fileName(p: PhotoJson): string {
  const en = (p.placeEn ?? '').split(',')[0].trim() || city(p) || 'photo';
  return `${en.replace(/\s+/g, '_')}_${(p.takenAt ?? p.at).slice(0, 10)}.jpg`;
}

export function renderPhotosPage(root: HTMLElement, token: string): () => void {
  applyPwaIdentity('photos');
  root.innerHTML = `
    <div class="page photos">
      <div id="share"></div>
      <header class="ph-head">
        <h1 id="ph-title" class="ph-title">照片回顧</h1>
        <div class="seg" role="tablist" aria-label="檢視模式">
          <button type="button" class="on" data-mode="grid" role="tab" aria-selected="true">網格</button>
          <button type="button" data-mode="map" role="tab" aria-selected="false">地圖</button>
        </div>
      </header>
      <section id="ph-grid" class="ph-grid-wrap"><p class="muted ph-empty">載入中…</p></section>
      <div id="ph-more" class="tl-more" hidden></div>
      <section id="ph-map-wrap" class="ph-map-wrap" hidden><div id="ph-map" class="ph-map"></div></section>
      <footer class="foot"><small>此頁僅供持有連結者查看。照片為旅行者打卡時上傳。</small></footer>
    </div>`;
  renderShareBar(root.querySelector<HTMLElement>('#share')!, `${location.origin}/p/${token}`, '把這條連結傳給想看照片的人；在 LINE 內按「開啟」會用瀏覽器開啟。', { collapsed: true });
  const titleEl = root.querySelector<HTMLElement>('#ph-title')!;
  const gridEl = root.querySelector<HTMLElement>('#ph-grid')!;
  const moreEl = root.querySelector<HTMLElement>('#ph-more')!;
  const mapWrap = root.querySelector<HTMLElement>('#ph-map-wrap')!;
  const segBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.seg button'));

  const photoUrl = (id: string, thumb = false): string => `/api/g/${encodeURIComponent(token)}/p/${encodeURIComponent(id)}${thumb ? '?s=t' : ''}`;
  const viewerItems = (list: PhotoJson[]): ViewerItem[] =>
    list.map((p) => ({ src: photoUrl(p.photoId), download: fileName(p), caption: [p.place ?? '', fmtDateTime(new Date(p.at), p.tz)].filter(Boolean).join(' · ') }));
  const lightbox = createLightbox();

  // ---- 資料：新到舊，分頁續抓 ----
  const photos: PhotoJson[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let exhausted = false;
  let loading = false;
  let mode: Mode = 'grid';

  const loadMore = async (): Promise<number> => {
    if (loading || exhausted || photos.length >= MAX_PHOTOS) return 0;
    loading = true;
    moreEl.hidden = false;
    moreEl.textContent = '載入中…';
    try {
      const res = await fetch(`/api/g/${encodeURIComponent(token)}/photos?limit=${PAGE}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      if (res.status === 404) throw new Error('連結無效或已輪替');
      if (!res.ok) throw new Error(`載入失敗（${res.status}）`);
      const data = (await res.json()) as { items: PhotoJson[]; cursor: string | null; exhausted: boolean };
      const fresh = data.items.filter((p) => p.photoId && !seen.has(p.photoId));
      fresh.forEach((p) => seen.add(p.photoId));
      photos.push(...fresh);
      cursor = data.cursor;
      exhausted = data.exhausted || !data.cursor;
      return fresh.length;
    } catch (e) {
      exhausted = true;
      gridEl.innerHTML = `<p class="muted ph-empty">${esc(String((e as Error).message ?? e))}</p>`;
      return 0;
    } finally {
      loading = false;
      moreEl.textContent = exhausted ? (photos.length > PAGE ? '已顯示全部' : '') : '';
      moreEl.hidden = exhausted && photos.length <= PAGE;
    }
  };
  const loadAll = async (): Promise<void> => {
    while (!exhausted && photos.length < MAX_PHOTOS) {
      if ((await loadMore()) === 0 && exhausted) break;
    }
  };

  // ---- 網格 ----
  let renderedCount = 0;
  const renderGrid = (): void => {
    if (!photos.length) {
      gridEl.innerHTML = exhausted ? '<p class="muted ph-empty">這趟旅程還沒有照片。<br><small>用照片打卡後，這裡會出現。</small></p>' : '<p class="muted ph-empty">載入中…</p>';
      renderedCount = 0;
      return;
    }
    if (renderedCount === 0) gridEl.innerHTML = '';
    // 只補新加入的（新到舊），沿用最後一個日期區塊
    for (let i = renderedCount; i < photos.length; i++) {
      const p = photos[i];
      const key = dayKey(p);
      let sec = gridEl.lastElementChild as HTMLElement | null;
      if (!sec || sec.dataset.day !== key) {
        gridEl.insertAdjacentHTML(
          'beforeend',
          `<section class="ph-day" data-day="${key}"><h2 class="ph-day-h"><span>${esc(dayLabel(p))}</span>${city(p) ? `<span class="muted">${esc(city(p))}</span>` : ''}</h2><div class="ph-grid"></div></section>`,
        );
        sec = gridEl.lastElementChild as HTMLElement;
      }
      sec.querySelector('.ph-grid')!.insertAdjacentHTML(
        'beforeend',
        `<button type="button" class="ph-cell" data-i="${i}" aria-label="${esc(city(p) || '照片')}"><img src="${photoUrl(p.photoId, true)}" alt="" loading="lazy" decoding="async" /></button>`,
      );
    }
    renderedCount = photos.length;
  };
  gridEl.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.ph-cell');
    if (!cell) return;
    lightbox.open(viewerItems(photos), Number(cell.dataset.i));
  });
  const io = new IntersectionObserver(
    (entries) => {
      if (mode !== 'grid' || !entries.some((x) => x.isIntersecting)) return;
      void loadMore().then((n) => {
        if (n) renderGrid();
      });
    },
    { rootMargin: '600px 0px' },
  );
  io.observe(moreEl);

  // ---- 地圖：縮圖聚合 ----
  let map: L.Map | null = null;
  let markers: L.LayerGroup | null = null;
  let mapFitted = false;
  const ensureMap = (): L.Map => {
    if (map) return map;
    map = L.map(root.querySelector<HTMLElement>('#ph-map')!, { zoomControl: true, attributionControl: true, maxZoom: MAX_ZOOM });
    tileLayer().addTo(map);
    map.setView([25.04, 121.56], 3);
    markers = L.layerGroup().addTo(map);
    map.on('moveend zoomend', renderClusters);
    return map;
  };
  const renderClusters = (): void => {
    if (!map || !markers) return;
    markers.clearLayers();
    if (!photos.length) return;
    const zoom = map.getZoom();
    type Cluster = { x: number; y: number; items: PhotoJson[] };
    const clusters: Cluster[] = [];
    for (const p of photos) {
      const pt = map.project([p.lat, p.lng], zoom);
      const hit = clusters.find((c) => Math.abs(c.x - pt.x) < CLUSTER_PX && Math.abs(c.y - pt.y) < CLUSTER_PX);
      if (hit) hit.items.push(p);
      else clusters.push({ x: pt.x, y: pt.y, items: [p] });
    }
    for (const c of clusters) {
      // 群的位置用成員平均，縮圖用最新一張
      const lat = c.items.reduce((s, p) => s + p.lat, 0) / c.items.length;
      const lng = c.items.reduce((s, p) => s + p.lng, 0) / c.items.length;
      const first = c.items[0];
      const icon = L.divIcon({
        className: 'ph-pin-wrap',
        html: `<div class="ph-pin"><img src="${photoUrl(first.photoId, true)}" alt="" />${c.items.length > 1 ? `<span class="n">${c.items.length}</span>` : ''}</div>`,
        iconSize: [56, 56],
        iconAnchor: [28, 56],
      });
      const m = L.marker([lat, lng], { icon, title: city(first) });
      m.on('click', () => {
        if (c.items.length > 1 && zoom < MAX_ZOOM) {
          map!.flyToBounds(L.latLngBounds(c.items.map((p) => [p.lat, p.lng] as L.LatLngTuple)).pad(0.3), { maxZoom: MAX_ZOOM, duration: 0.8 });
        } else {
          lightbox.open(viewerItems(c.items), 0);
        }
      });
      m.addTo(markers);
    }
  };
  const fitAll = (): void => {
    if (!map || !photos.length) return;
    const b = L.latLngBounds(photos.map((p) => [p.lat, p.lng] as L.LatLngTuple));
    if (photos.length === 1) map.setView(b.getCenter(), 13);
    else map.fitBounds(b.pad(0.15), { maxZoom: 14 });
    mapFitted = true;
  };

  // ---- 模式切換 ----
  const setMode = async (m: Mode): Promise<void> => {
    mode = m;
    segBtns.forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    gridEl.hidden = m !== 'grid';
    moreEl.hidden = m !== 'grid' || (exhausted && photos.length <= PAGE);
    mapWrap.hidden = m !== 'map';
    if (m === 'map') {
      const mp = ensureMap();
      window.setTimeout(() => mp.invalidateSize(), 50);
      // 地圖要看到整趟，先把剩下的都載完
      await loadAll();
      renderGrid();
      if (!mapFitted) fitAll();
      renderClusters();
    }
    location.hash = m === 'map' ? '#map' : '';
  };
  segBtns.forEach((b) => b.addEventListener('click', () => void setMode(b.dataset.mode as Mode)));

  // ---- 啟動 ----
  const boot = async (): Promise<void> => {
    try {
      const res = await fetch(`/api/g/${encodeURIComponent(token)}`);
      if (res.status === 404) throw new Error('連結無效或已輪替');
      if (!res.ok) throw new Error(`載入失敗（${res.status}）`);
      const t = (await res.json()) as { title: string };
      titleEl.textContent = t.title;
      applyPwaIdentity('photos', t.title);
    } catch (e) {
      gridEl.innerHTML = `<p class="muted ph-empty">${esc(String((e as Error).message ?? e))}</p>`;
      exhausted = true;
      return;
    }
    await loadMore();
    renderGrid();
    if (location.hash === '#map') await setMode('map');
  };
  void boot();

  return () => {
    io.disconnect();
    lightbox.destroy();
    map?.remove();
  };
}
