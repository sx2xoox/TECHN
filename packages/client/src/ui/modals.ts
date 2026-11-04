import { CHANNELS, type ChannelName, type DryRunMessage, type HelloMessage, type VerificationReport } from '@isomorph/core';
import { clear, describeVisual, h, riskKo } from './dom.ts';

export class ModalRoot {
  readonly el = h('div', { id: 'modal-root', class: 'hidden' });
  private onClose: (() => void) | null = null;

  constructor() {
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.classList.contains('hidden')) this.close();
    });
  }

  open(content: HTMLElement, onClose?: () => void, dock = false) {
    clear(this.el);
    this.el.append(content);
    this.el.classList.remove('hidden');
    this.el.classList.toggle('dock', dock);
    this.onClose = onClose ?? null;
  }

  close() {
    this.el.classList.add('hidden');
    clear(this.el);
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }
}

/** 드라이런: 승인 전에는 아무것도 바뀌지 않는다는 것을 분명히 보여준다 */
export function dryRunModal(m: DryRunMessage, writeMode: string, onApprove: () => void, onCancel: () => void): HTMLElement {
  const changes: HTMLElement[] = [];
  if (m.current && m.preview) {
    for (const ch of Object.keys(CHANNELS) as ChannelName[]) {
      const a = m.current.visual[ch];
      const b = m.preview.visual[ch];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      changes.push(h('li', null, h('span', { class: 'muted' }, `${CHANNELS[ch].ko}: `), describeVisual(ch, a ?? null, m.current.outOfRange.includes(ch)), ' → ', h('strong', null, describeVisual(ch, b ?? null, m.preview.outOfRange.includes(ch)))));
    }
    const before = m.current.anomalies.length;
    const after = m.preview.anomalies.length;
    if (before !== after) changes.push(h('li', null, h('span', { class: 'muted' }, '법칙 위반: '), `${before}개 → `, h('strong', { class: after ? 'bad' : 'ok' }, `${after}개`)));
  }
  let left = 60;
  const timer = h('span', { class: 'muted small' }, `미리보기는 ${left}초 동안 유효`);
  const iv = setInterval(() => {
    left--;
    timer.textContent = left > 0 ? `미리보기는 ${left}초 동안 유효` : '만료됨 — 다시 미리보기 하세요';
    if (left <= 0) {
      clearInterval(iv);
      approve.disabled = true;
    }
  }, 1000);
  const approve = h('button', { class: `btn primary risk-${m.risk}`, disabled: !m.allowed, onclick: () => { clearInterval(iv); onApprove(); } }, '승인하고 실행');
  return h('div', { class: 'modal' },
    h('h2', null, `드라이런 — ${m.title}`),
    h('p', { class: 'note' }, '아직 아무것도 바뀌지 않았습니다. 아래는 승인하면 일어날 일입니다. 마을에 겹쳐 깜빡이는 장면이 "미래 장면"입니다.'),
    m.error ? h('p', { class: 'bad' }, m.error) : null,
    changes.length ? h('div', null, h('h3', null, '세계에서'), h('ul', null, changes)) : null,
    m.commandText.length ? h('div', null, h('h3', null, '실제 시스템에서'), h('pre', { class: 'mono code' }, m.commandText.join('\n'))) : null,
    h('p', { class: 'small' }, `위험도 ${riskKo(m.risk)} · 현재 쓰기 권한: ${writeMode}`, m.reason ? h('span', { class: 'bad' }, ` — ${m.reason}`) : null),
    h('p', { class: 'muted small' }, '실행 직전 시스템이 미리보기 때와 같은 상태인지 다시 확인합니다(낙관적 동시성). 실행 후 다음 관측에서 실제로 반영됐는지 검증하고, 되돌리기를 지원합니다.'),
    h('div', { class: 'row end' }, timer, h('button', { class: 'btn ghost', onclick: () => { clearInterval(iv); onCancel(); } }, '취소'), approve),
  );
}

export function verificationModal(v: VerificationReport, extra: { compileMode?: string; fallbackReason?: string; rounds?: { round: number; source: string; ok: boolean; errors: number; score: number; repairs?: { action: string }[] }[] } | null): HTMLElement {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return h('div', { class: 'modal wide' },
    h('h2', null, v.ok ? '렌즈 검증 통과 ✓' : '렌즈 검증 실패 ✕'),
    h('p', { class: 'muted' }, `무작위로 만든 시스템 상태 ${v.totalRuns.toLocaleString('ko-KR')}개로 대응 규칙의 법칙을 검사했습니다 (seed ${v.seed}, ${v.durationMs}ms).`),
    h('div', { class: 'grid4' },
      stat('충실도', `${v.fidelity.score}/100`),
      stat('법칙 통과율', pct(v.fidelity.lawPassRate)),
      stat('단사성', pct(v.fidelity.injectivity)),
      stat('설명된 필드', pct(v.fidelity.accounted)),
    ),
    h('h3', null, '검사한 법칙'),
    h('ul', { class: 'checks' }, v.checks.map((c) => h('li', { class: c.passed ? 'ok' : 'bad' }, c.passed ? '✓ ' : '✕ ', c.title, h('span', { class: 'muted small' }, ` (${c.runs}회)`)))),
    v.issues.length ? h('div', null, h('h3', null, '문제'), h('ul', { class: 'issues' }, v.issues.map((i) => h('li', { class: i.level }, h('code', null, i.code), ` ${i.message}`, i.counterexample ? h('pre', { class: 'mono tiny' }, `반례: ${i.counterexample}`) : null)))) : null,
    extra?.rounds?.length
      ? h('div', null,
          h('h3', null, `컴파일 과정 (${extra.compileMode === 'llm' ? 'LLM' : '규칙 기반'})`),
          extra.fallbackReason ? h('p', { class: 'muted small' }, extra.fallbackReason) : null,
          h('ol', null, extra.rounds.map((r) => h('li', null, `${r.source === 'llm' ? 'LLM 초안' : r.source === 'repair' ? '자동 수리' : '규칙 기반 초안'} — ${r.ok ? '통과' : `오류 ${r.errors}건`} · 충실도 ${r.score}`, r.repairs?.length ? h('ul', { class: 'small muted' }, r.repairs.map((x) => h('li', null, x.action))) : null))))
      : null,
    h('p', { class: 'muted small' }, 'GetPut: 세계를 그대로 두면 시스템도 바뀌지 않는다 · PutGet: 세계에서 한 편집은 시스템에 반영된 뒤 그대로 보인다 · 국소성: 한 개체의 편집이 다른 개체를 바꾸지 않는다 · 단사성: 서로 다른 값은 서로 다르게 보인다.'),
  );
}

function stat(label: string, value: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'muted small' }, label), h('strong', null, value));
}

/** 전체 화면 상태(연결 중 / 검증 실패로 세계를 열지 않음 / 오류) */
export class Screen {
  readonly el = h('div', { id: 'screen' });

  connecting() {
    clear(this.el);
    this.el.classList.remove('hidden');
    this.el.append(h('div', { class: 'screen-box' }, h('div', { class: 'logo big' }, '◆'), h('h1', null, 'ISOMORPH'), h('p', null, '시스템에 연결해 세계를 컴파일하는 중…')));
  }

  refused(m: HelloMessage) {
    clear(this.el);
    this.el.classList.remove('hidden');
    this.el.append(
      h('div', { class: 'screen-box wide' },
        h('h1', { class: 'bad' }, '세계를 열지 않았습니다'),
        h('p', null, `"${m.grammar.title}"의 대응 규칙이 렌즈 법칙을 통과하지 못했습니다. 틀린 그림을 보여주느니 아무것도 보여주지 않습니다.`),
        h('ul', { class: 'issues' }, m.verification.issues.filter((i) => i.level === 'error').map((i) => h('li', { class: 'error' }, h('code', null, i.code), ` ${i.message}`, i.counterexample ? h('pre', { class: 'mono tiny' }, `반례: ${i.counterexample}`) : null))),
      ),
    );
  }

  error(message: string) {
    clear(this.el);
    this.el.classList.remove('hidden');
    this.el.append(h('div', { class: 'screen-box' }, h('h1', { class: 'bad' }, '시스템에 연결할 수 없습니다'), h('pre', { class: 'mono small' }, message)));
  }

  hide() {
    this.el.classList.add('hidden');
  }
}
