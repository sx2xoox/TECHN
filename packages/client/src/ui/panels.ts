import { ANOMALY_KO, CHANNELS, type ActionRecord, type HelloMessage, type InspectMessage, type Invariant, type WorldEntity, type WorldState } from '@isomorph/core';
import { spriteDataUrl } from '../pixel/textures.ts';
import { channelKo, clear, describeVisual, fmtTime, h, riskKo, valueText } from './dom.ts';

/* ───────────────────────────── 상단 막대 ───────────────────────────── */

export interface TopbarHandlers {
  onLab(): void;
  /** 색각 이상 미리보기를 다음 단계로(일반 → 적색맹 → 녹색맹 → 청색맹) */
  onVision(): void;
  /** 최근 몇 분의 세계를 HTML 한 파일(공유본)로 내려받기 — 운영자만 */
  onShare(): void;
  onLegend(): void;
  onFit(): void;
  onZoom(dir: number): void;
  onVerification(): void;
  onNextViolation(): void;
  /** 장애 기록 창 */
  onIncidents(): void;
}

export class Topbar {
  readonly el = h('header', { id: 'topbar' });
  private title = h('div', { class: 'title' });
  private conn = h('span', { class: 'conn' });
  private verify = h('button', { class: 'chip verify' });
  private viol = h('button', { class: 'chip viol hidden' });
  private write = h('span', { class: 'chip write' });
  private fps = h('span', { class: 'chip fps hidden' });
  private share = h('button', { class: 'btn hidden', title: '최근 10분의 세계를 HTML 한 파일로 내려받습니다(서버 없이 열리고, 민감 정보는 가명 처리)' }, '공유본');
  private vision = h('button', { class: 'btn', title: '색각 이상이 있는 사람에게 세계가 어떻게 보이는지 미리보기(근사)' }, '색각: 일반');
  private incidents = h('button', { class: 'btn incidents hidden', title: '같은 근본 원인에서 번진 위반 묶음 · 조치 · 회복 · 사후 보고서' }, '장애 기록');

  constructor(private hnd: TopbarHandlers) {
    this.verify.addEventListener('click', () => hnd.onVerification());
    this.viol.addEventListener('click', () => hnd.onNextViolation());
    this.vision.addEventListener('click', () => hnd.onVision());
    this.share.addEventListener('click', () => hnd.onShare());
    this.incidents.addEventListener('click', () => hnd.onIncidents());
    this.el.append(
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◆'), 'ISOMORPH'),
      this.title,
      this.conn,
      h('div', { class: 'spacer' }),
      this.verify,
      this.viol,
      this.write,
      this.fps,
      this.incidents,
      h('button', { class: 'btn lab', onclick: () => hnd.onLab(), title: '가설 실험실' }, '가설 실험실'),
      this.share,
      this.vision,
      h('button', { class: 'btn', onclick: () => hnd.onLegend(), title: '범례' }, '범례'),
      h('button', { class: 'btn', onclick: () => hnd.onFit(), title: '전체 보기' }, '전체'),
      h('button', { class: 'btn icon', onclick: () => hnd.onZoom(1), title: '확대' }, '+'),
      h('button', { class: 'btn icon', onclick: () => hnd.onZoom(-1), title: '축소' }, '−'),
    );
    this.setConnection('connecting');
  }

  /** 장애가 하나라도 있으면 보인다. 진행 중이면 빨갛게 */
  setIncidents(open: number, total: number) {
    this.incidents.classList.toggle('hidden', total === 0);
    this.incidents.classList.toggle('alert', open > 0);
    this.incidents.textContent = open ? `장애 진행 ${open}` : `장애 기록 ${total}`;
  }

  setVision(label: string, active: boolean) {
    this.vision.textContent = `색각: ${label}`;
    this.vision.classList.toggle('active', active);
  }

  setHello(m: HelloMessage) {
    this.share.classList.toggle('hidden', this.sharedAt !== null || m.role === 'viewer');
    clear(this.title);
    this.title.append(h('strong', null, m.grammar.title), h('small', null, ` ${m.source} · ${m.system} · ${m.grammar.generatedBy === 'llm' ? 'LLM 컴파일' : m.grammar.generatedBy === 'heuristic' ? '규칙 기반 컴파일' : '수동 문법'}`));
    const v = m.verification;
    clear(this.verify);
    this.verify.className = `chip verify ${v.ok ? 'ok' : 'bad'}`;
    this.verify.append(v.ok ? '렌즈 검증 ✓' : '렌즈 검증 ✕', h('small', null, ` 충실도 ${v.fidelity.score} · 법칙 ${v.checks.length}종 ${v.totalRuns.toLocaleString('ko-KR')}회`));
    const viewer = m.role === 'viewer';
    this.write.textContent = viewer ? '보기 전용 접속' : m.writeMode === 'read-only' ? '읽기 전용' : `쓰기 허용: ${riskKo(m.writeMode)}까지`;
    this.write.className = `chip write ${viewer || m.writeMode === 'read-only' ? '' : 'on'}`;
    this.push = !!m.push;
  }

  private push = false;

  /** 공유본(오프라인 HTML)으로 열렸으면 그 시각 */
  private sharedAt: number | null = null;
  setShared(at: number) {
    this.sharedAt = at;
    this.share.classList.add('hidden');
  }

  setConnection(s: 'connecting' | 'live' | 'history' | 'offline' | 'stress', at?: number) {
    const live = this.sharedAt ? `공유본 · ${new Date(this.sharedAt).toLocaleString('ko-KR')} 기준(보기 전용)` : this.push ? '실시간 · 즉시 반영' : '실시간';
    const text = { connecting: '연결 중…', live, history: `과거 ${at ? fmtTime(at) : ''}`, offline: '연결 끊김 — 재연결 중', stress: '부하 시험' }[s];
    this.conn.className = `conn ${s}`;
    this.conn.textContent = `● ${text}`;
  }

  setViolations(n: number, critical: number) {
    this.viol.classList.toggle('hidden', n === 0);
    this.viol.classList.toggle('critical', critical > 0);
    this.viol.textContent = `법칙 위반 ${n}`;
  }

  setFps(fps: number, n: number) {
    this.fps.classList.remove('hidden');
    this.fps.textContent = `${Math.round(fps)} fps · 개체 ${n.toLocaleString('ko-KR')}`;
  }
}

/* ───────────────────────────── 정직한 범례 ───────────────────────────── */

export class LegendPanel {
  readonly el = h('aside', { id: 'legend', class: 'panel left hidden' });

  toggle(force?: boolean) {
    this.el.classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  render(m: Pick<HelloMessage, 'legend' | 'grammar'>) {
    clear(this.el);
    this.el.append(
      h('div', { class: 'panel-head' }, h('h2', null, '정직한 범례'), h('button', { class: 'x', onclick: () => this.toggle(false) }, '✕')),
      h('p', { class: 'muted' }, '이 마을에 보이는 모든 것은 아래 대응 규칙으로만 그려집니다. 규칙은 렌즈 법칙 검증을 통과했습니다.'),
    );
    for (const l of m.legend) {
      this.el.append(
        h('section', { class: 'legend-kind' },
          h('div', { class: 'legend-head' }, h('img', { src: spriteDataUrl(l.sprite, l.archetype), class: 'pix', width: l.archetype === 'npc' ? 24 : 32 }), h('div', null, h('strong', null, l.title), h('div', { class: 'muted small' }, l.headline))),
          h('ul', null, l.lines.map((line) => h('li', null, line))),
          l.hidden.length ? h('div', { class: 'muted small' }, `그리지 않음(명시적 숨김): ${l.hidden.join(', ')}`) : null,
        ),
      );
    }
    this.el.append(
      h('section', { class: 'legend-kind' },
        h('strong', null, '이상 현상 = 법칙 위반'),
        h('ul', null, Object.entries(ANOMALY_KO).map(([k, v]) => h('li', null, h('code', null, k), ` ${v}`))),
        h('div', { class: 'muted small' }, '붉게 깜빡이는 테두리와 ! 말풍선은 법칙이 깨진 곳입니다. "추정 법칙"은 사람이 확정하기 전까지의 후보입니다.'),
      ),
      h('section', { class: 'legend-kind' },
        h('strong', null, '법칙 목록'),
        h('ul', null, m.grammar.invariants.filter((i) => i.status !== 'dismissed').map((i) => h('li', null, invariantBadge(i), ` ${i.title}`))),
      ),
      h('p', { class: 'muted small' }, '멀리서 보면(0.5배 이하) 개별 건물 대신 구역 요약으로 바뀝니다: 종류별 개수, 상태 색 분포 막대, 불 꺼짐·불길·법칙 위반 수. 요약을 누르면 그 구역으로 들어갑니다.'),
      h('p', { class: 'muted small' }, '장식: 나무·분수·길·바닥 무늬는 데이터와 무관합니다. 주민의 걷는 경로와 걸음은 연출이며, 의미는 색(상태)과 출발/도착 건물에만 있습니다.'),
    );
  }
}

function invariantBadge(i: Invariant) {
  const src = { schema: '스키마', heuristic: '이름 추정', dynamic: '관측 학습', llm: 'LLM 제안', user: '사용자' }[i.source];
  return h('span', { class: `badge ${i.status}` }, i.status === 'confirmed' ? `확정·${src}` : `추정·${src}`);
}

/* ───────────────────────────── 인스펙터 ───────────────────────────── */

export interface InspectorHandlers {
  onClose(): void;
  /** 연결된 곳을 눌러 그쪽을 살펴본다 */
  onSelect(entityId: string): void;
  /** 이 개체(과거 시점이면 그 시점)로 바로 오는 링크를 복사 */
  onCopyLink(entityId: string): void;
  onAffordance(entityId: string, affordanceId: string): void;
  onInvariant(id: string, status: 'confirmed' | 'dismissed'): void;
}

export class Inspector {
  readonly el = h('aside', { id: 'inspector', class: 'panel right hidden' });
  current: string | null = null;
  /** 같은 내용이면 다시 그리지 않는다(실시간 갱신 중에도 버튼이 바뀌지 않아 클릭이 사라지지 않게) */
  private lastSig: string | null = null;
  private stableNodes = new Map<string, { sig: string; el: HTMLElement }>();

  constructor(private hnd: InspectorHandlers) {}

  private reset() {
    this.lastSig = null;
    this.stableNodes.clear();
  }

  /** 내용(sig)이 그대로면 이전 DOM 노드를 그대로 다시 쓴다: 누르려던 버튼이 갱신 도중 교체되지 않는다 */
  private stable(key: string, sig: string, build: () => HTMLElement) {
    const old = this.stableNodes.get(key);
    if (old && old.sig === sig) return old.el;
    const el = build();
    this.stableNodes.set(key, { sig, el });
    return el;
  }

  hide() {
    this.current = null;
    this.reset();
    this.el.classList.add('hidden');
  }

  loading(entity: WorldEntity, kindTitle: string) {
    this.reset();
    this.current = entity.id;
    this.el.classList.remove('hidden');
    clear(this.el);
    this.el.append(this.header(entity, kindTitle), h('p', { class: 'muted' }, '불러오는 중…'));
  }

  private header(e: WorldEntity, kindTitle: string) {
    return h('div', { class: 'panel-head' },
      h('img', { src: spriteDataUrl(e.sprite, e.archetype), class: 'pix', width: e.archetype === 'npc' ? 24 : 32 }),
      h('div', { class: 'grow' }, h('h2', null, e.label), h('div', { class: 'muted small' }, `${kindTitle} · ${e.source.collection} #${e.source.pk}`)),
      h('button', { class: 'btn small ghost copy-link', title: '이 개체로 바로 오는 링크(과거 시점이면 그 시점) 복사', onclick: () => this.hnd.onCopyLink(e.id) }, '링크'),
      h('button', { class: 'x', onclick: () => this.hnd.onClose() }, '✕'),
    );
  }

  /** 가상 세계(시뮬레이션)의 개체: 서버에 묻지 않고 장면에 담긴 것만 보여준다 */
  virtual(e: WorldEntity, kindTitle: string, t: number) {
    this.reset();
    this.current = e.id;
    this.el.classList.remove('hidden');
    clear(this.el);
    this.el.append(
      this.header(e, kindTitle),
      h('div', { class: 'note virtual' }, `가상 세계의 개체입니다(t = ${(t / 1000).toFixed(1)}초). 학습한 규칙으로 예측한 모습이며 실제 데이터가 아닙니다.`),
      h('h3', null, '이 순간의 모습'),
      h('ul', null, Object.entries(e.visual).filter(([, v]) => v !== null && v !== '').map(([c, v]) => h('li', null, h('span', { class: 'muted' }, `${channelKo(c as keyof typeof CHANNELS)}: `), describeVisual(c as keyof typeof CHANNELS, v, e.outOfRange.includes(c as keyof typeof CHANNELS))))),
    );
    if (e.anomalies.length) this.el.append(h('h3', { class: 'bad' }, '예측된 법칙 위반'), h('ul', null, e.anomalies.map((a) => h('li', null, a.message, ' ', h('span', { class: 'badge anomaly' }, ANOMALY_KO[a.kind])))));
  }

  render(m: InspectMessage, kindTitle: string, invariants: Invariant[], history: boolean) {
    if (m.entityId !== this.current) return;
    const sig = JSON.stringify([m, kindTitle, history, invariants.map((i) => [i.id, i.status])]);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    const scrollTop = this.el.scrollTop;
    clear(this.el);
    this.draw(m, kindTitle, invariants, history);
    this.el.scrollTop = scrollTop;
  }

  private draw(m: InspectMessage, kindTitle: string, invariants: Invariant[], history: boolean) {
    const e = m.entity;
    if (!e) {
      this.el.append(h('div', { class: 'panel-head' }, h('h2', null, m.entityId), h('button', { class: 'x', onclick: () => this.hnd.onClose() }, '✕')), h('p', { class: 'muted' }, '이 시점의 세계에는 이 개체가 없습니다.'));
      return;
    }
    this.el.append(this.header(e, kindTitle));
    if (history) this.el.append(h('div', { class: 'note' }, '과거 시점을 보고 있습니다. 행동은 실시간에서만 가능합니다.'));

    // 법칙 위반
    if (m.violations.length) {
      const sigV = JSON.stringify([m.entityId, history, m.violations, m.violations.map((v) => invariants.find((i) => i.id === v.invariantId)?.status)]);
      this.el.append(this.stable('violations', sigV, () => {
        const box = h('div', null, h('h3', { class: 'bad' }, `법칙 위반 ${m.violations.length}`));
        for (const v of m.violations) {
          const inv = invariants.find((i) => i.id === v.invariantId);
          box.append(
            h('div', { class: 'violation' },
              h('div', null, h('strong', null, v.title), ' ', inv ? invariantBadge(inv) : null, ' ', h('span', { class: 'badge anomaly' }, ANOMALY_KO[v.kind])),
              h('div', { class: 'mono small' }, Object.entries(v.values).map(([k, x]) => `${k} = ${valueText(x)}`).join(', ')),
              inv?.status === 'proposed' && !history
                ? h('div', { class: 'row' },
                    h('button', { class: 'btn small', onclick: () => this.hnd.onInvariant(inv.id, 'confirmed') }, '법칙으로 확정'),
                    h('button', { class: 'btn small ghost', onclick: () => this.hnd.onInvariant(inv.id, 'dismissed') }, '이 법칙 무시'))
                : null,
            ),
          );
        }
        return box;
      }));
    }

    // 원인 진단
    if (m.diagnosis) {
      const d = m.diagnosis;
      this.el.append(
        h('h3', null, '원인 진단 ', h('span', { class: `badge conf-${d.confidence}` }, { high: '확신 높음', medium: '확신 중간', low: '확신 낮음' }[d.confidence])),
        h('div', { class: 'diagnosis' }, h('strong', null, d.title), h('p', null, d.detail), d.suggestion ? h('p', { class: 'suggest' }, '고치는 법: ', d.suggestion) : null),
      );
    }
    // 근본 원인 사슬: 여기서 거슬러 올라간 곳들(마지막이 근본 원인)
    if (m.chain?.length) {
      const steps = m.chain;
      this.el.append(this.stable('chain', JSON.stringify([m.entityId, steps]), () =>
        h('div', { class: 'chain' },
          h('h3', null, '근본 원인 사슬 ', h('span', { class: 'muted small' }, '(지도에 빨간 길)')),
          h('ol', null,
            h('li', { class: 'here' }, h('span', { class: 'muted small' }, '여기'), ' ', e.label),
            ...steps.map((s, i) =>
              h('li', { class: i === steps.length - 1 ? 'root' : '' },
                h('span', { class: 'via' }, s.via === 'blame' ? '↑ 오류가 시작된 곳' : '↑ 먼저 법칙을 어김'),
                ' ',
                s.entityId ? h('button', { class: 'link', onclick: () => this.hnd.onSelect(s.entityId!) }, s.label) : h('span', null, s.label),
                ' ', h('span', { class: 'muted small' }, s.title),
                s.crossSystem ? h('span', { class: 'badge cross' }, '다른 시스템') : null,
                i === steps.length - 1 ? h('span', { class: 'badge root' }, '근본 원인') : null,
                h('div', { class: 'small bad' }, `⚠ ${s.violation}`),
              )),
          ),
        )));
    }
    // 직전 변경 되돌리기: 위반 직전에 이 개체가 받은 변경(시스템이 쓰기를 받는 값만)
    if (m.revert && !history) {
      const r = m.revert;
      this.el.append(this.stable('revert', JSON.stringify([m.entityId, r]), () =>
        h('div', { class: 'revert' },
          h('h3', null, '위반 직전의 변경 ', h('span', { class: 'muted small' }, `(${new Date(r.at).toLocaleTimeString('ko-KR')})`)),
          h('ul', null, r.changes.map((c) => h('li', { class: 'mono small' }, `${c.field}: `, h('span', { class: 'bad' }, valueText(c.now)), ' ← 원래 ', h('strong', null, valueText(c.to))))),
          h('button', { class: 'btn act risk-high', onclick: () => this.hnd.onAffordance(m.entityId, '__revert') }, '이 변경 되돌리기(미리보기)'),
          h('p', { class: 'muted small' }, '드라이런으로 실제 명령을 먼저 보여 주고, 승인해야만 실행합니다. 실행 뒤에는 관측으로 확인하고, 다시 되돌릴 수 있습니다.'),
        )));
    }
    if (m.causes.length) {
      const t0 = m.causes[0].at;
      this.el.append(
        h('h3', null, '사건 기록 ', h('span', { class: 'muted small' }, '(위반 직전, 시스템 시각 기준)')),
        h('ol', { class: 'causes' }, m.causes.map((c) =>
          h('li', { class: c.relation },
            h('span', { class: 'mono t' }, `+${c.at - t0}ms`),
            h('span', { class: 'rel' }, { self: '자신', referencing: '참조', referenced: '대상' }[c.relation]),
            h('span', null,
              h('strong', null, `${c.collection} #${c.pk}`), ` ${c.summary}`,
              c.crossSystem ? h('span', { class: 'badge cross' }, '다른 시스템') : null,
              c.broke ? h('span', { class: 'badge anomaly' }, `법칙 어김: ${c.broke}`) : null,
            ),
          ))),
      );
    }

    // 연결된 곳(다른 시스템 포함): 저쪽이 아프면 먼저 보인다
    if (m.related?.length) {
      this.el.append(this.stable('related', JSON.stringify([m.entityId, m.related]), () =>
        h('div', null,
          h('h3', null, '연결된 곳 ', h('span', { class: 'muted small' }, '(참조로 바로 이어진 곳 · 지도에 점선)')),
          h('ul', { class: 'related' }, (m.related ?? []).map((r) =>
            h('li', { class: [r.violations.length ? 'sick' : '', r.crossSystem ? 'cross' : ''].join(' ') },
              h('span', { class: 'dir', title: r.direction === 'to' ? '이것이 가리키는 곳' : '이것을 가리키는 곳' }, r.direction === 'to' ? '→' : '←'),
              h('span', null,
                r.entityId ? h('button', { class: 'link', onclick: () => this.hnd.onSelect(r.entityId!) }, r.label) : h('span', null, r.label),
                ' ', h('span', { class: 'muted small' }, `${r.title} · ${r.field}`),
                r.crossSystem ? h('span', { class: 'badge cross' }, '다른 시스템') : null,
                ...r.violations.map((v) => h('div', { class: 'small bad' }, `⚠ ${v.title}`)),
              ),
            ))),
        )));
      // 수는 자주 바뀌므로 목록(누를 수 있는 줄)과 따로 그린다
      if (m.relatedMore) this.el.append(h('p', { class: 'muted small' }, `그 밖에 ${m.relatedMore}곳(오가는 개체 포함)`));
    }

    // 원본 데이터 ↔ 세계 표현
    this.el.append(
      h('h3', null, '원본 데이터 ↔ 세계 표현'),
      h('table', { class: 'fields' },
        h('thead', null, h('tr', null, h('th', null, '필드'), h('th', null, '값'), h('th', null, '세계에서'))),
        h('tbody', null, m.fields.map((f) =>
          h('tr', { class: f.sensitive ? 'sensitive' : '' },
            h('td', { class: 'mono' }, f.name),
            h('td', { class: 'mono' }, valueText(f.value)),
            h('td', null,
              f.channel ? h('span', null, h('span', { class: 'muted' }, `${channelKo(f.channel)}: `), describeVisual(f.channel, f.visual ?? null, e.outOfRange.includes(f.channel))) : null,
              f.role ? h('span', { class: 'badge role' }, { pk: '기본키', label: '이름표', route: '경로', recency: '최근성', filter: '필터', hidden: '숨김' }[f.role]) : null,
              f.sensitive ? h('span', { class: 'badge role' }, '민감·가림') : null,
            ),
          ))),
      ),
    );

    // 행동
    if (m.affordances.length) {
      this.el.append(this.stable('affordances', JSON.stringify([m.entityId, m.affordances]), () =>
        h('div', null,
          h('h3', null, '세계를 만져 시스템 바꾸기'),
          m.affordances.map((a) =>
            h('div', { class: 'affordance' },
              h('button', { class: `btn act risk-${a.risk}`, disabled: !a.allowed, onclick: () => this.hnd.onAffordance(m.entityId, a.id) }, a.title),
              h('div', { class: 'small muted' }, `${a.description} · 위험도 ${riskKo(a.risk)}`, a.reason ? h('div', { class: 'small bad' }, a.reason) : null),
            )),
          h('p', { class: 'muted small' }, '누르면 먼저 드라이런(미래 장면)을 보여주고, 승인해야만 실행됩니다.'),
        )));
    }
  }
}

/* ───────────────────────────── 행동 기록 ───────────────────────────── */

export class ActionLog {
  readonly el = h('div', { id: 'actions', class: 'floating hidden' });
  constructor(private onUndo: (id: string) => void) {}

  render(actions: ActionRecord[]) {
    clear(this.el);
    this.el.classList.toggle('hidden', actions.length === 0);
    this.el.append(h('div', { class: 'floating-head' }, '행동 기록'));
    for (const a of actions.slice(0, 6)) {
      const status = { applied: ['적용됨', ''], verified: ['실제 반영 확인 ✓', 'ok'], mismatch: ['관측 불일치', 'warn'], failed: ['실패', 'bad'], undone: ['되돌림', 'muted'] }[a.status];
      this.el.append(
        h('div', { class: 'action' },
          h('div', { class: 'row' }, h('span', { class: 'mono small' }, fmtTime(a.ts)), h('strong', { class: 'grow' }, a.title), h('span', { class: `badge ${status[1]}` }, status[0])),
          h('div', { class: 'mono tiny' }, a.commandText.join(' ; ')),
          a.error ? h('div', { class: 'small muted' }, a.error) : null,
          (a.status === 'applied' || a.status === 'verified') && !a.undoOf ? h('button', { class: 'btn small ghost', onclick: () => this.onUndo(a.id) }, '되돌리기') : null,
        ),
      );
    }
  }
}

/* ───────────────────────────── 알림·툴팁 ───────────────────────────── */

export class Toasts {
  readonly el = h('div', { id: 'toasts' });
  show(level: 'info' | 'success' | 'warning' | 'error', message: string, action?: { label: string; run: () => void }) {
    const t = h('div', { class: `toast ${level}` }, message, action ? h('button', { class: 'btn small', onclick: () => { action.run(); t.remove(); } }, action.label) : null);
    this.el.prepend(t);
    while (this.el.children.length > 5) this.el.lastElementChild?.remove();
    setTimeout(() => t.classList.add('fade'), 5500);
    setTimeout(() => t.remove(), 6200);
  }
}

export class Tooltip {
  readonly el = h('div', { id: 'tooltip', class: 'hidden' });
  show(e: WorldEntity, kindTitle: string, x: number, y: number) {
    clear(this.el);
    this.el.append(h('strong', null, e.label), h('span', { class: 'muted small' }, ` ${kindTitle}`));
    const parts = Object.entries(e.visual).filter(([, v]) => v !== null && v !== '');
    if (parts.length) this.el.append(h('div', { class: 'small' }, parts.map(([c, v], i) => h('span', null, i ? ' · ' : '', describeVisual(c as keyof typeof CHANNELS, v, e.outOfRange.includes(c as keyof typeof CHANNELS))))));
    if (e.anomalies.length) this.el.append(h('div', { class: 'small bad' }, `⚠ ${e.anomalies.map((a) => a.message).join(', ')}`));
    this.el.classList.remove('hidden');
    this.el.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 12)}px)`;
  }
  hide() {
    this.el.classList.add('hidden');
  }
}

export function countViolations(w: WorldState) {
  return { n: w.violations.length, critical: w.violations.filter((v) => v.severity === 'critical').length };
}
