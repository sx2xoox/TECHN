import { CHANNELS, PALETTE, type ChannelName, type ColorName, type VisualValue } from '@isomorph/core';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** 아주 작은 DOM 헬퍼 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtTime(ts: number, ms = false): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? `.${p(d.getMilliseconds(), 3)}` : ''}`;
}

export function colorKo(c: string): string {
  return c in PALETTE ? PALETTE[c as ColorName].ko : c;
}

export function swatch(c: string): HTMLElement {
  return h('span', { class: 'swatch', style: `background:${c in PALETTE ? PALETTE[c as ColorName].hex : c}` });
}

/** 세계 채널 값을 사람 말로 */
export function describeVisual(channel: ChannelName, v: VisualValue, outOfRange = false): Node {
  if (v === null || v === undefined) return document.createTextNode('—');
  switch (channel) {
    case 'stack': {
      const n = Number(v);
      if (n < 0 || (outOfRange && n <= 0)) return h('span', { class: 'bad' }, `유령 상자 ${Math.max(1, Math.abs(n))}개`);
      return document.createTextNode(`상자 ${n}개${outOfRange ? ' (범위 초과)' : ''}`);
    }
    case 'lit':
      return document.createTextNode(v ? '불 켜짐' : '불 꺼짐');
    case 'fog':
      return document.createTextNode(v ? '안개 낌' : '맑음');
    case 'tint':
      return h('span', null, swatch(String(v)), ` ${colorKo(String(v))}`);
    case 'crowd':
      return document.createTextNode(`구경꾼 ${v}명`);
    case 'fire':
      return document.createTextNode(Number(v) > 0 ? `불꽃 ${v}개` : '불 없음');
    case 'speed':
    case 'size':
      return document.createTextNode(`×${Number(v).toFixed(2)}`);
    default:
      return document.createTextNode(String(v));
  }
}

export function channelKo(c: ChannelName): string {
  return CHANNELS[c].ko;
}

export function riskKo(r: 'low' | 'medium' | 'high'): string {
  return { low: '낮음', medium: '중간', high: '높음' }[r];
}

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtTime(Date.parse(v), true) : v;
  return JSON.stringify(v);
}
