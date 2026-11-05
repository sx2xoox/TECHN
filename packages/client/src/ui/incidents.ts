import type { Incident } from '@isomorph/core';
import { clear, h } from './dom.ts';

/**
 * 장애 기록 창: 같은 근본 원인에서 번진 위반 묶음. 근본 원인, 직전 변경, 조치, 회복까지 걸린 시간, 타임라인,
 * 그리고 사후 보고서(마크다운) 내려받기.
 */
export interface IncidentsHandlers {
  onClose(): void;
  /** 그 장애가 시작된 시점으로 되감고 근본 원인을 연다 */
  onJump(at: number, entityId: string | null): void;
}

const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour12: false });
const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};

export class IncidentsPanel {
  readonly el = h('aside', { id: 'incidents', class: 'panel left hidden' });
  private list: Incident[] = [];
  private open = new Set<string>();
  private sig = '';

  constructor(private hnd: IncidentsHandlers, private canDownload: boolean) {}

  toggle(on?: boolean) {
    const show = on ?? this.el.classList.contains('hidden');
    this.el.classList.toggle('hidden', !show);
    if (show) this.render();
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  set(list: Incident[]) {
    this.list = list;
    if (this.visible) this.render();
  }

  private render() {
    const sig = JSON.stringify([this.list, [...this.open]]);
    if (sig === this.sig) return;
    this.sig = sig;
    const top = this.el.scrollTop;
    clear(this.el);
    this.el.append(
      h('div', { class: 'panel-head' }, h('h2', { class: 'grow' }, '장애 기록'), h('button', { class: 'x', onclick: () => this.hnd.onClose() }, '✕')),
      h('p', { class: 'muted small' }, '같은 근본 원인에서 번진 법칙 위반을 하나로 묶었습니다. 위반이 모두 풀리면 닫힙니다.'),
    );
    if (!this.list.length) this.el.append(h('p', { class: 'muted' }, '아직 장애가 없습니다.'));
    for (const inc of this.list) {
      const live = inc.closedAt === null;
      const places = new Set(inc.violations.map((v) => `${v.collection}:${v.pk}`)).size;
      const fixes = inc.actions.filter((a) => a.status !== 'failed');
      const expanded = this.open.has(inc.id);
      this.el.append(
        h('div', { class: `incident ${live ? 'live' : 'closed'}` },
          h('div', { class: 'row' },
            h('span', { class: `dot ${live ? 'bad' : 'ok'}` }, live ? '●' : '●'),
            h('strong', { class: 'grow' }, inc.root.label),
            h('span', { class: 'muted small' }, (live ? `진행 중 · ${hm(inc.openedAt)}부터` : `${took(inc.closedAt! - inc.openedAt)} · ${hm(inc.openedAt)}`) + (inc.observedFromStart ? ' · 관측 시작 전부터' : '')),
          ),
          h('div', { class: 'small' }, '근본 원인: ', h('span', { class: 'bad' }, inc.root.violation), inc.root.crossSystem ? h('span', { class: 'badge cross' }, '다른 시스템') : null),
          inc.change?.length ? h('div', { class: 'small mono' }, '직전 변경: ', inc.change.map((c) => `${c.field} ${JSON.stringify(c.to)} → ${JSON.stringify(c.now)}`).join(', ')) : null,
          h('div', { class: 'small' }, `영향 ${places}곳 · 조치 `, fixes.length ? fixes.map((a) => `${a.title}${a.status === 'verified' ? ' ✓' : ''}`).join(', ') : '없음'),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', onclick: () => this.hnd.onJump(inc.openedAt, inc.root.entityId) }, '그 시점으로'),
            this.canDownload ? h('a', { class: 'btn small ghost report', href: `/api/incidents/${inc.id}.md`, download: '' }, '사후 보고서') : null,
            h('button', { class: 'btn small ghost', onclick: () => (expanded ? this.open.delete(inc.id) : this.open.add(inc.id), this.render()) }, expanded ? '접기' : `타임라인 ${inc.timeline.length}`),
          ),
          expanded
            ? h('ol', { class: 'timeline-steps' }, [...inc.timeline].sort((a, b) => a.at - b.at).map((s) => h('li', { class: s.kind }, h('span', { class: 'mono muted' }, hm(s.at)), ' ', s.text)))
            : null,
        ),
      );
    }
    this.el.scrollTop = top;
  }
}
