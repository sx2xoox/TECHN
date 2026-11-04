import type { TimelineMessage } from '@isomorph/core';
import { fmtTime, h } from './dom.ts';

/** 하단 타임 스크러버: 기록 구간, 법칙 위반이 시작된 순간(붉은 표식), 현재 위치 */
export class Timeline {
  readonly el = h('footer', { id: 'timeline' });
  private canvas = h('canvas', { class: 'track' });
  private range = h('span', { class: 'mono small muted' });
  private live = h('button', { class: 'btn live on' }, '● LIVE');
  private banner = h('div', { id: 'history-banner', class: 'hidden' });
  private data: TimelineMessage | null = null;
  private position: number | null = null;
  private dragging = false;
  private lastSeek = 0;

  constructor(private onSeek: (ts: number) => void, private onLive: () => void) {
    this.el.append(h('span', { class: 'label' }, '시간'), h('div', { class: 'track-wrap' }, this.canvas), this.range, this.live);
    this.live.addEventListener('click', () => this.onLive());
    const toTs = (ev: PointerEvent) => {
      if (!this.data) return null;
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      return Math.round(this.data.start + x * (this.data.end - this.data.start));
    };
    this.canvas.addEventListener('pointerdown', (ev) => {
      this.dragging = true;
      this.canvas.setPointerCapture(ev.pointerId);
      const ts = toTs(ev);
      if (ts) this.seek(ts, true);
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      const ts = toTs(ev);
      if (ts) this.seek(ts, false);
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      this.dragging = false;
      const ts = toTs(ev);
      if (ts) this.seek(ts, true);
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  get bannerEl() {
    return this.banner;
  }

  private seek(ts: number, force: boolean) {
    this.position = ts;
    this.draw();
    const now = performance.now();
    if (force || now - this.lastSeek > 120) {
      this.lastSeek = now;
      this.onSeek(ts);
    }
  }

  setData(t: TimelineMessage) {
    this.data = t;
    this.range.textContent = `${fmtTime(t.start)} ~ ${fmtTime(t.end)}`;
    this.draw();
  }

  setMode(mode: 'live' | 'history', ts?: number) {
    this.live.classList.toggle('on', mode === 'live');
    this.live.textContent = mode === 'live' ? '● LIVE' : '▶ LIVE로';
    if (mode === 'live') this.position = null;
    else if (ts) this.position = ts;
    this.banner.classList.toggle('hidden', mode === 'live');
    this.banner.textContent = mode === 'history' && ts ? `⏪ 과거 ${fmtTime(ts, true)} 의 세계를 보는 중 — 이 시점에서는 행동할 수 없습니다` : '';
    this.draw();
  }

  /** 다음/이전 위반 표식으로 이동 */
  markerNear(ts: number, dir: 1 | -1): number | null {
    const ms = (this.data?.markers ?? []).map((m) => m.ts).sort((a, b) => a - b);
    const found = dir > 0 ? ms.find((m) => m > ts + 1) : [...ms].reverse().find((m) => m < ts - 1);
    return found ?? null;
  }

  private draw() {
    const c = this.canvas;
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = '#2b2533';
    ctx.fillRect(0, hgt / 2 - 3, w, 6);
    const d = this.data;
    if (!d || d.end <= d.start) return;
    const x = (ts: number) => ((ts - d.start) / (d.end - d.start)) * w;
    // 분 눈금
    ctx.fillStyle = '#4a4356';
    const first = Math.ceil(d.start / 60_000) * 60_000;
    for (let t = first; t < d.end; t += 60_000) ctx.fillRect(Math.round(x(t)), hgt / 2 - 6, 1, 12);
    ctx.fillStyle = '#5bbf4a';
    ctx.fillRect(0, hgt / 2 - 3, x(this.position ?? d.end), 6);
    for (const m of d.markers) {
      ctx.fillStyle = '#e5533d';
      ctx.fillRect(Math.round(x(m.ts)) - 1, 2, 3, hgt - 4);
    }
    const px = Math.round(x(this.position ?? d.end));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 2, 1, 4, hgt - 2);
  }
}
