/**
 * 依頁面切換「加入主畫面」會用到的身分：manifest、apple-touch-icon、標題、主題色。
 * iOS Safari 在按「加入主畫面」當下讀取 DOM 裡的這些標籤，所以動態替換有效。
 */
export type PwaKind = 'default' | 'checkin' | 'family';

const IDENTITY: Record<PwaKind, { manifest: string; icon: string; title: string; theme: string }> = {
  default: { manifest: '/manifest.webmanifest', icon: 'icon', title: '報平安', theme: '#0f766e' },
  checkin: { manifest: '/manifest-checkin.webmanifest', icon: 'checkin', title: '打卡', theme: '#0f766e' },
  family: { manifest: '/manifest-family.webmanifest', icon: 'family', title: '家人頁', theme: '#d97706' },
};

function setLink(rel: string, href: string, sizes?: string): void {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
  if (sizes) el.sizes.value = sizes;
}
function setMeta(name: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/** @param subtitle 例如行程名稱，會接在分頁標題後（主畫面名稱仍用短標題） */
export function applyPwaIdentity(kind: PwaKind, subtitle?: string): void {
  const id = IDENTITY[kind];
  setLink('manifest', id.manifest);
  setLink('apple-touch-icon', `/icons/${id.icon}-180.png`);
  setLink('icon', `/icons/${id.icon}-192.png`);
  setMeta('apple-mobile-web-app-title', id.title);
  setMeta('theme-color', id.theme);
  document.title = subtitle ? `${id.title} · ${subtitle}` : `iamalive ${id.title}`;
}
