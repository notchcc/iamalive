/**
 * 地圖 + 時間軸共用元件（家人頁與 /me 皆用）。以 circleMarker 繪製，避免 Leaflet 預設圖示的打包路徑問題。
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TAIPEI, fmtAgo, fmtDateTime, fmtTime, sameAsTaipei, tzLabel } from './time';
import type { RecentItem } from './types';

const SOURCE_LABEL: Record<RecentItem['src'], string> = {
  shortcut: '捷徑',
  line: 'LINE 位置',
  'web-gps': '瀏覽器定位',
  manual: '手動選點',
  photo: '照片',
};

export type PhotoUrlFn = (photoId: string) => string;

/** 拍攝時間與上傳時間相差超過 5 分鐘時，顯示拍攝時間。 */
function takenLine(it: RecentItem): string {
  if (!it.takenAt) return '';
  const taken = it.takenAt.toDate();
  const at = it.at.toDate();
  if (Math.abs(at.getTime() - taken.getTime()) < 5 * 60_000) return '';
  return `拍攝於 ${esc(fmtDateTime(taken, TAIPEI))} 台北${sameAsTaipei(taken, it.tz) ? '' : `（${esc(tzLabel(it.tz))} ${esc(fmtTime(taken, it.tz))}）`}`;
}

export function tileLayer(): L.TileLayer {
  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  if (key) {
    return L.tileLayer(`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${key}`, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
  }
  // 開發用退路；正式環境請設定 VITE_MAPTILER_KEY。
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
}

export function createMap(el: HTMLElement): L.Map {
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  tileLayer().addTo(map);
  map.setView([25.04, 121.56], 4);
  return map;
}

export class TrackLayer {
  private group = L.layerGroup();
  constructor(private map: L.Map) {
    this.group.addTo(map);
  }

  render(items: RecentItem[], opts: { fit?: boolean; photoUrl?: PhotoUrlFn } = {}): void {
    this.group.clearLayers();
    if (!items.length) return;
    const pts: L.LatLngExpression[] = [];
    // items 為新到舊；畫線用舊到新。
    const ordered = [...items].reverse();
    ordered.forEach((it, i) => {
      const isLast = i === ordered.length - 1;
      const ll: L.LatLngExpression = [it.lat, it.lng];
      pts.push(ll);
      if (it.acc && it.acc > 0) {
        L.circle(ll, { radius: it.acc, color: '#0f766e', weight: 1, fillOpacity: 0.08 }).addTo(this.group);
      }
      const marker = L.circleMarker(ll, {
        radius: isLast ? 9 : 5,
        color: isLast ? '#b91c1c' : '#0f766e',
        weight: 2,
        fillColor: isLast ? '#ef4444' : '#14b8a6',
        fillOpacity: 0.9,
        dashArray: it.src === 'manual' ? '3 3' : undefined,
      });
      marker.bindPopup(popupHtml(it, opts.photoUrl), { maxWidth: 260 });
      marker.addTo(this.group);
    });
    if (pts.length > 1) {
      L.polyline(pts, { color: '#0f766e', weight: 2, opacity: 0.6, dashArray: '4 6' }).addTo(this.group);
    }
    if (opts.fit !== false) {
      const b = L.latLngBounds(pts);
      if (pts.length === 1) this.map.setView(pts[0], 14);
      else this.map.fitBounds(b.pad(0.2), { maxZoom: 15 });
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function accuracyText(it: RecentItem): string {
  if (it.acc == null) return '精度未知';
  if (it.acc > 500) return `位置概略（±${Math.round(it.acc)} m）`;
  return `±${Math.round(it.acc)} m`;
}

export function placeText(it: RecentItem): string {
  return it.place || tzLabel(it.tz);
}

export function coordText(it: RecentItem): string {
  return `${it.lat.toFixed(5)}, ${it.lng.toFixed(5)}`;
}

export function mapsUrl(it: RecentItem): string {
  return `https://www.google.com/maps?q=${it.lat.toFixed(6)},${it.lng.toFixed(6)}`;
}

function popupHtml(it: RecentItem, photoUrl?: PhotoUrlFn): string {
  const at = it.at.toDate();
  const photo = it.photoId && photoUrl ? `<a href="${photoUrl(it.photoId)}" target="_blank" rel="noopener"><img class="popup-photo" src="${photoUrl(it.photoId)}" alt="" loading="lazy" /></a><br>` : '';
  const taken = takenLine(it);
  return `${photo}<b>${esc(fmtDateTime(at, TAIPEI))} 台北</b>${taken ? `<br><small>${taken}</small>` : ''}${
    sameAsTaipei(at, it.tz) ? '' : `<br>${esc(tzLabel(it.tz))} ${esc(fmtTime(at, it.tz))}`
  }<br>📍 ${esc(placeText(it))}<br><a href="${mapsUrl(it)}" target="_blank" rel="noopener">${esc(coordText(it))}</a>${
    it.note ? `<br>${esc(it.note)}` : ''
  }<br><small>${SOURCE_LABEL[it.src]} · ${accuracyText(it)}</small>`;
}

export function renderTimeline(el: HTMLElement, items: RecentItem[], now = new Date(), photoUrl?: PhotoUrlFn): void {
  if (!items.length) {
    el.innerHTML = '<p class="muted">尚無回報</p>';
    return;
  }
  el.innerHTML = items
    .map((it) => {
      const at = it.at.toDate();
      const local = sameAsTaipei(at, it.tz) ? '' : `<span class="local">${esc(tzLabel(it.tz))} ${esc(fmtTime(at, it.tz))}</span>`;
      const photo = it.photoId && photoUrl
        ? `<a class="tl-photo" href="${photoUrl(it.photoId)}" target="_blank" rel="noopener"><img src="${photoUrl(it.photoId)}" alt="" loading="lazy" /></a>`
        : '';
      const taken = takenLine(it);
      return `<li class="tl-item src-${it.src}${photo ? ' has-photo' : ''}">
        ${photo}
        <div class="tl-time"><b>${esc(fmtDateTime(at, TAIPEI))}</b> ${local}<span class="ago">${esc(fmtAgo(at, now))}</span></div>
        ${taken ? `<div class="tl-taken">${taken}</div>` : ''}
        <div class="tl-place">📍 <b>${esc(placeText(it))}</b>
          <a class="coord" href="${mapsUrl(it)}" target="_blank" rel="noopener">${esc(coordText(it))}</a></div>
        <div class="tl-body">${it.note ? esc(it.note) : '<span class="muted">已報平安</span>'}</div>
        <div class="tl-meta">${SOURCE_LABEL[it.src]} · ${esc(accuracyText(it))}</div>
      </li>`;
    })
    .join('');
}
