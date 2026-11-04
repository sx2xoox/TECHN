import type { Hypothesis, SimulationResult, SystemModel } from '@isomorph/core';
import { clear, h } from './dom.ts';

/** 가설 실험실 패널: 학습한 규칙 · 가설 · 결과 */
export interface LabHandlers {
  onClose(): void;
  onSimulate(h: Hypothesis): void;
  onPlay(result: SimulationResult): void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`;

export class LabPanel {
  readonly el = h('aside', { id: 'lab', class: 'panel left hidden' });
  private model: SystemModel | null = null;
  private hypotheses: Hypothesis[] = [];
  private results: SimulationResult[] = [];
  private running: { id: string; done: number; total: number } | null = null;
  private factor = 2;
  private horizon = 60_000;

  constructor(private hnd: LabHandlers) {}

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  toggle(force?: boolean) {
    this.el.classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  setLab(model: SystemModel, hypotheses: Hypothesis[]) {
    this.model = model;
    this.hypotheses = hypotheses;
    this.render();
  }

  setProgress(id: string, done: number, total: number) {
    this.running = { id, done, total };
    this.render();
  }

  addResult(r: SimulationResult) {
    this.running = null;
    this.results = [r, ...this.results.filter((x) => x.hypothesis.id !== r.hypothesis.id)].slice(0, 6);
    this.render();
  }

  private run(hyp: Hypothesis) {
    if (this.running) return;
    this.running = { id: hyp.id, done: 0, total: 1 };
    this.render();
    this.hnd.onSimulate(hyp);
  }

  private resultCard(r: SimulationResult) {
    const laws = r.laws.filter((l) => l.probability > 0 || l.preExisting > 0).sort((a, b) => b.probability - a.probability);
    const arrivals = Object.entries(r.arrivals).map(([k, v]) => `${k} ${Math.round(v)}건`).join(', ');
    return h('div', { class: 'sim-result' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.hypothesis.title), h('span', { class: 'muted small' }, `${r.runs}회 · ${sec(r.horizonMs)}`)),
      laws.length
        ? h('div', null, laws.map((l) =>
            h('div', { class: 'law-bar' },
              h('div', { class: 'small' }, l.title),
              h('div', { class: 'bar' }, h('div', { class: `fill ${l.probability >= 0.5 ? 'bad' : l.probability > 0 ? 'warn' : 'ok'}`, style: `width:${Math.max(2, l.probability * 100)}%` })),
              h('div', { class: 'small muted' },
                `새로 깨질 확률 ${pct(l.probability)}`,
                l.medianFirstMs !== null ? ` · 보통 ${sec(l.medianFirstMs)} 뒤` : '',
                l.preExisting ? ` · 시작 전부터 깨짐 ${l.preExisting}건(제외)` : ''),
            )))
        : h('p', { class: 'ok small' }, '이 가설에서는 어떤 법칙도 새로 깨지지 않았습니다.'),
      arrivals ? h('div', { class: 'small muted' }, `새로 생긴 행(평균): ${arrivals}`) : null,
      h('button', { class: 'btn primary small', onclick: () => this.hnd.onPlay(r) }, '▶ 가상 세계로 재생'),
    );
  }

  render() {
    clear(this.el);
    this.el.append(
      h('div', { class: 'panel-head' }, h('h2', null, '가설 실험실'), h('button', { class: 'x', onclick: () => this.hnd.onClose() }, '✕')),
      h('p', { class: 'note' }, '시스템이 실제로 움직인 기록에서 규칙을 배우고, "만약 ~라면?" 을 수십 번 굴려 봅니다. 결과는 예측이며 실제 시스템은 바꾸지 않습니다.'),
    );
    const m = this.model;
    if (!m) {
      this.el.append(h('p', { class: 'muted' }, '규칙을 배우는 중…'));
      return;
    }
    this.el.append(
      h('h3', null, '기록에서 배운 규칙 ', h('span', { class: 'muted small' }, `(이벤트 ${m.learnedFrom.events.toLocaleString('ko-KR')}개 · ${sec(m.learnedFrom.spanMs)})`)),
      h('ul', { class: 'rules' }, m.rules.map((r) => h('li', null, r))),
    );
    if (this.running) {
      const p = this.running.total ? this.running.done / this.running.total : 0;
      this.el.append(h('div', { class: 'sim-progress' }, h('div', { class: 'small' }, `시뮬레이션 중… ${this.running.done}/${this.running.total}`), h('div', { class: 'bar' }, h('div', { class: 'fill warn', style: `width:${Math.max(3, p * 100)}%` }))));
    }
    if (this.results.length) {
      this.el.append(h('h3', null, '결과'), ...this.results.map((r) => this.resultCard(r)));
    }
    this.el.append(h('h3', null, '가설'));
    for (const hyp of this.hypotheses) {
      this.el.append(
        h('div', { class: 'hyp' },
          h('div', { class: 'grow' }, h('strong', null, hyp.title), h('div', { class: 'small muted' }, hyp.description)),
          h('button', { class: 'btn small', disabled: !!this.running, onclick: () => this.run(hyp) }, '시뮬레이션'),
        ),
      );
    }
    // 직접 만들기: 발생률 배수 + 시간 지평
    const rate = m.rates[0];
    if (rate) {
      const factorLabel = h('span', { class: 'mono' }, `×${this.factor}`);
      const slider = h('input', { type: 'range', min: '0.5', max: '10', step: '0.5', value: String(this.factor) }) as HTMLInputElement;
      slider.addEventListener('input', () => {
        this.factor = Number(slider.value);
        factorLabel.textContent = `×${this.factor}`;
      });
      const horizon = h('select', null, [20_000, 60_000, 120_000].map((v) => h('option', { value: String(v), ...(v === this.horizon ? { selected: true } : {}) }, sec(v)))) as HTMLSelectElement;
      horizon.addEventListener('change', () => (this.horizon = Number(horizon.value)));
      this.el.append(
        h('div', { class: 'hyp custom' },
          h('div', { class: 'grow' },
            h('strong', null, '직접 만들기'),
            h('div', { class: 'small muted' }, `${rate.collection} 발생률을 바꿔 봅니다(지금 분당 ${rate.perMinute.toFixed(0)}건)`),
            h('div', { class: 'row' }, slider, factorLabel, horizon),
          ),
          h('button', {
            class: 'btn small',
            disabled: !!this.running,
            onclick: () => this.run({ id: `custom_rate_${this.factor}_${this.horizon}`, title: `${rate.collection} ×${this.factor} (${sec(this.horizon)})`, description: '사용자 가설', horizonMs: this.horizon, changes: [{ kind: 'rate', collection: rate.collection, factor: this.factor }] }),
          }, '시뮬레이션'),
        ),
      );
    }
  }
}

/** 가상 세계 재생 조작부 */
export interface PlayerHandlers {
  onFrame(index: number): void;
  onExit(): void;
}

export class SimPlayer {
  readonly el = h('div', { id: 'sim-player', class: 'hidden' });
  private result: SimulationResult | null = null;
  private index = 0;
  private playing = false;
  private speed = 1;
  private timer: number | null = null;
  private slider = h('input', { type: 'range', min: '0', max: '0', value: '0' }) as HTMLInputElement;
  private clock = h('span', { class: 'mono small' });
  private playBtn = h('button', { class: 'btn small' }, '⏸');
  private speedBtn = h('button', { class: 'btn small' }, '×1');

  constructor(private hnd: PlayerHandlers) {
    this.slider.addEventListener('input', () => this.go(Number(this.slider.value)));
    this.playBtn.addEventListener('click', () => this.setPlaying(!this.playing));
    this.speedBtn.addEventListener('click', () => {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      this.speedBtn.textContent = `×${this.speed}`;
      if (this.playing) this.setPlaying(true);
    });
  }

  get active() {
    return !!this.result;
  }

  start(r: SimulationResult) {
    this.result = r;
    this.slider.max = String(r.frames.length - 1);
    this.go(0);
    this.setPlaying(true);
    this.render();
    this.el.classList.remove('hidden');
  }

  stop() {
    this.setPlaying(false);
    this.result = null;
    this.el.classList.add('hidden');
  }

  private setPlaying(on: boolean) {
    this.playing = on;
    this.playBtn.textContent = on ? '⏸' : '▶';
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    if (!on || !this.result) return;
    const frameMs = this.result.frames.length > 1 ? this.result.frames[1].t - this.result.frames[0].t : 500;
    this.timer = window.setInterval(() => {
      if (!this.result) return;
      if (this.index >= this.result.frames.length - 1) return this.setPlaying(false);
      this.go(this.index + 1);
    }, Math.max(60, frameMs / this.speed));
  }

  private go(i: number) {
    if (!this.result) return;
    this.index = Math.max(0, Math.min(this.result.frames.length - 1, i));
    this.slider.value = String(this.index);
    const f = this.result.frames[this.index];
    this.clock.textContent = `t = ${(f.t / 1000).toFixed(1)}초 / ${(this.result.horizonMs / 1000).toFixed(0)}초 · 위반 ${f.world.violations.length}`;
    this.hnd.onFrame(this.index);
  }

  frame() {
    return this.result?.frames[this.index] ?? null;
  }

  private render() {
    clear(this.el);
    const r = this.result!;
    this.el.append(
      h('div', { class: 'sim-title' }, h('span', { class: 'tag' }, '가상'), ` 가설: ${r.hypothesis.title} `, h('span', { class: 'muted small' }, `— 대표 실행(${r.runs}회 중 위반량이 중간인 실행) · 예측이며 실제 시스템이 아닙니다`)),
      h('div', { class: 'row' }, this.playBtn, this.speedBtn, this.slider, this.clock, h('button', { class: 'btn small primary', onclick: () => this.hnd.onExit() }, '실제로 돌아가기')),
    );
  }
}
