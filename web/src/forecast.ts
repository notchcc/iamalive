/**
 * 接下來 24 小時警報預報的時間軸（內嵌 SVG）。上緣台北時刻、下緣旅人當地時刻；
 * 區段：飛行窗 / 睡眠 / 離線 / 台北安靜時段（斜紋）；事件：期限、提醒、警報。
 */
import { TAIPEI, fmtTime, sameAsTaipei, tzLabel } from './time';
import type { ForecastJson } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const SEG_COLOR: Record<string, string> = { flight: '#93c5fd', sleep: '#ddd6fe', offline: '#fdba74' };
const SEG_LABEL: Record<string, string> = { flight: '飛行窗（不警報）', sleep: '睡眠時段（期限順延）', offline: '預告離線（不警報）', quiet: '台北 23–07（警報 08:00 補發）' };

export function renderForecast(el: HTMLElement, f: ForecastJson): void {
  const W = 380; // 以手機寬度 1:1 為基準
  const PAD_L = 36; // 左側放「台北」「當地」軸名
  const PAD_R = 10;
  const TRACK_Y = 30;
  const TRACK_H = 22;
  const H = 74;
  const start = new Date(f.now).getTime();
  const span = f.hours * 3_600_000;
  const x = (iso: string | Date): number => PAD_L + ((typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime()) - start) / span * (W - PAD_L - PAD_R);
  const showLocal = !sameAsTaipei(new Date(f.now), f.travelerTz);

  // 刻度：每 6 小時，對齊整點
  const ticks: string[] = [];
  const firstTick = new Date(start);
  firstTick.setUTCMinutes(0, 0, 0);
  for (let t = firstTick.getTime(); t <= start + span; t += 3_600_000) {
    const d = new Date(t);
    if (t < start) continue;
    const hTpe = Number(fmtTime(d, TAIPEI).slice(0, 2));
    if (hTpe % 6 === 0) {
      const xx = x(d);
      if (xx - PAD_L < 16) continue; // 太靠近「現在」線，略過刻度文字
      ticks.push(`<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${TRACK_Y - 4}" y2="${TRACK_Y + TRACK_H + 4}" stroke="#e5e7eb" />
        <text x="${xx.toFixed(1)}" y="${TRACK_Y - 7}" text-anchor="middle" font-size="10" fill="#6b7280">${fmtTime(d, TAIPEI)}</text>
        ${showLocal ? `<text x="${xx.toFixed(1)}" y="${TRACK_Y + TRACK_H + 13}" text-anchor="middle" font-size="10" fill="#6b7280">${fmtTime(d, f.travelerTz)}</text>` : ''}`);
    }
  }

  const segs = f.segments
    .filter((s) => s.kind !== 'quiet')
    .map((s) => `<rect x="${x(s.from).toFixed(1)}" y="${TRACK_Y}" width="${Math.max(1, x(s.to) - x(s.from)).toFixed(1)}" height="${TRACK_H}" fill="${SEG_COLOR[s.kind]}" rx="3"><title>${esc(s.label)}</title></rect>`)
    .join('');
  const quiet = f.segments
    .filter((s) => s.kind === 'quiet')
    .map((s) => `<rect x="${x(s.from).toFixed(1)}" y="${TRACK_Y}" width="${Math.max(1, x(s.to) - x(s.from)).toFixed(1)}" height="${TRACK_H}" fill="url(#hatch)"><title>${esc(s.label)}</title></rect>`)
    .join('');

  const marks = f.events
    .map((e) => {
      const xx = x(e.at);
      const cy = TRACK_Y + TRACK_H / 2;
      const title = `<title>${esc(e.label)} · 台北 ${fmtTime(new Date(e.at), TAIPEI)}${showLocal ? ` / 當地 ${fmtTime(new Date(e.at), f.travelerTz)}` : ''}</title>`;
      switch (e.kind) {
        case 'deadline':
          return `<g>${title}<path d="M${xx - 5} ${TRACK_Y - 2} L${xx + 5} ${TRACK_Y - 2} L${xx} ${TRACK_Y + 7} Z" fill="none" stroke="#6b7280" stroke-width="1.5"/></g>`;
        case 'effectiveDeadline':
          return `<g>${title}<path d="M${xx - 6} ${TRACK_Y - 3} L${xx + 6} ${TRACK_Y - 3} L${xx} ${TRACK_Y + 8} Z" fill="#111827"/></g>`;
        case 'reminder':
          return `<g>${title}<circle cx="${xx}" cy="${cy}" r="5.5" fill="#fff" stroke="#0f766e" stroke-width="1.6"/><text x="${xx}" y="${cy + 3}" text-anchor="middle" font-size="8" fill="#0f766e">🔔</text></g>`;
        case 'alert':
          return `<g>${title}<circle cx="${xx}" cy="${cy}" r="6" fill="${e.delayed ? '#fff' : '#b91c1c'}" stroke="#b91c1c" stroke-width="1.6"/><text x="${xx}" y="${cy + 3}" text-anchor="middle" font-size="8" font-weight="700" fill="${e.delayed ? '#b91c1c' : '#fff'}">!</text></g>`;
        case 'tripEnd':
        case 'autoComplete':
          return `<g>${title}<line x1="${xx}" x2="${xx}" y1="${TRACK_Y - 6}" y2="${TRACK_Y + TRACK_H + 6}" stroke="#111827" stroke-dasharray="3 2"/></g>`;
        default:
          return '';
      }
    })
    .join('');

  const legendKinds = ['flight', 'sleep', 'offline', 'quiet'].filter((k) => f.segments.some((s) => s.kind === k));
  const legend = legendKinds
    .map((k) => `<span class="lg"><i style="background:${k === 'quiet' ? 'repeating-linear-gradient(135deg,#9ca3af 0 2px,transparent 2px 6px)' : SEG_COLOR[k]}"></i>${SEG_LABEL[k]}</span>`)
    .join('');
  const evLegend = `<span class="lg"><i class="tri"></i>期限</span><span class="lg"><i class="dot bell"></i>提醒</span><span class="lg"><i class="dot alert"></i>警報</span><span class="lg"><i class="dot alert hollow"></i>深夜警報（08:00 補發）</span>`;

  const localName = tzLabel(f.travelerTz);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="接下來 ${f.hours} 小時警報預報">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" fill="#6b7280" opacity="0.5"/></pattern></defs>
      <text x="${PAD_L - 6}" y="${TRACK_Y - 7}" text-anchor="end" font-size="10" font-weight="700" fill="#374151">台北</text>
      ${showLocal ? `<text x="${PAD_L - 6}" y="${TRACK_Y + TRACK_H + 13}" text-anchor="end" font-size="10" font-weight="700" fill="#374151">${esc(localName.length > 3 ? localName.slice(0, 3) : localName)}</text>` : ''}
      <rect x="${PAD_L}" y="${TRACK_Y}" width="${W - PAD_L - PAD_R}" height="${TRACK_H}" fill="#f3f4f6" rx="4"/>
      ${segs}${quiet}${ticks.join('')}
      <line x1="${PAD_L}" x2="${PAD_L}" y1="${TRACK_Y - 8}" y2="${TRACK_Y + TRACK_H + 8}" stroke="#0f766e" stroke-width="2"/>
      <text x="${PAD_L}" y="10" text-anchor="middle" font-size="9" font-weight="700" fill="#0f766e">現在</text>
      ${marks}
    </svg>
    <div class="fc-legend">${legend}${evLegend}</div>
    <ul class="fc-summary">${f.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;
}
