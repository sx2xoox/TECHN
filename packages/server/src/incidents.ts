import { randomUUID } from 'node:crypto';
import type { ActionRecord, Incident, IncidentStep } from '@isomorph/core';
import type { IsomorphRuntime, ViolationEvent } from './runtime.ts';

/**
 * 장애 기록: 같은 근본 원인에서 번진 법칙 위반들을 하나의 '장애' 로 묶고,
 * 열린 때부터 닫힌 때까지 무엇이 깨졌고, 무엇이 근본 원인이었고(직전 변경 포함), 누가 무엇을 해서, 언제 회복했는지 남긴다.
 * 끝나면 사후 보고서(마크다운)를 만든다.
 *
 *  - 묶기: 새 위반의 근본 원인(사슬의 끝, 없으면 자기 자신)이 열린 장애의 근본 원인과 같으면 그 장애에 붙는다.
 *    사슬은 늦게 드러나기도 하므로(예: '오류가 시작된 곳' 이 몇 초 뒤에야 보임) 새 위반마다 열린 장애들의 근본 원인을 다시 보고 합친다.
 *  - 닫기: 그 장애의 위반이 모두 풀리면 닫힌다.
 *  - 조치: 장애가 열려 있는 동안 그 장애의 개체에 한 행동(실행·확인·실패·되돌림)을 남긴다.
 *  - 메모리에만 둔다(최근 100건). 민감 값은 담지 않는다: 제목·위치·진단(가려진 것)·명령만.
 */
const MAX = 100;

export class IncidentBook {
  private list: Incident[] = [];
  private actionStatus = new Map<string, string>();

  constructor(private rt: IsomorphRuntime) {
    rt.on('violation', (e: ViolationEvent) => this.onViolation(e));
    rt.on('actions', (actions: ActionRecord[]) => this.onActions(actions));
  }

  all(): Incident[] {
    return this.list;
  }

  get(id: string): Incident | undefined {
    return this.list.find((i) => i.id === id);
  }

  private open() {
    return this.list.filter((i) => i.closedAt === null);
  }

  private changed() {
    this.rt.emit('incidents', this.list);
  }

  /** 근본 원인(사슬의 끝, 없으면 자기 자신) */
  private rootOf(collection: string, pk: string, entityId: string | null, fallbackTitle: string): Incident['root'] & { key: string } {
    const ins = entityId ? this.rt.inspect(entityId) : null;
    const last = ins?.chain?.at(-1);
    if (last) return { key: `${last.collection}:${String(last.pk)}`, collection: last.collection, pk: String(last.pk), entityId: last.entityId, label: last.label, violation: last.violation, crossSystem: !!ins!.chain!.some((s) => s.crossSystem) };
    return { key: `${collection}:${pk}`, collection, pk, entityId, label: ins?.entity?.label ?? `${collection} #${pk}`, violation: ins?.violations[0]?.title ?? fallbackTitle, crossSystem: false };
  }

  private changeOf(entityId: string | null) {
    return entityId ? this.rt.inspect(entityId).revert?.changes ?? null : null;
  }

  private onViolation(e: ViolationEvent) {
    const v = e.violation;
    const key = `${v.invariantId}:${String(v.pk)}`;
    if (e.phase === 'start') {
      if (v.proposed && v.severity !== 'critical') return; // 확정 안 된 '추정' 법칙은 장애로 치지 않는다
      const ins = e.entityId ? this.rt.inspect(e.entityId) : null;
      const root = this.rootOf(v.collection, String(v.pk), e.entityId, v.title);
      let inc = this.open().find((i) => i.rootKey === root.key || i.violations.some((x) => `${x.collection}:${x.pk}` === root.key));
      if (!inc) {
        inc = { id: randomUUID(), ...(e.initial ? { observedFromStart: true } : {}), openedAt: e.ts, closedAt: null, rootKey: root.key, root: { ...root }, change: this.changeOf(root.entityId), violations: [], actions: [], timeline: [] };
        delete (inc.root as { key?: string }).key;
        this.list.unshift(inc);
        if (this.list.length > MAX) this.list.pop();
      }
      if (!inc.change) inc.change = this.changeOf(inc.root.entityId);
      const label = ins?.entity?.label ?? `${v.collection} #${String(v.pk)}`;
      inc.violations.push({ key, title: v.title, severity: v.severity, collection: v.collection, pk: String(v.pk), entityId: e.entityId, label, start: e.ts, end: null, diagnosis: ins?.diagnosis && ins.diagnosis.pattern !== 'unknown' ? `${ins.diagnosis.title}: ${ins.diagnosis.detail}` : null });
      inc.timeline.push({ at: e.ts, kind: 'start', text: `법칙 위반 시작: ${label} — ${v.title}`, entityId: e.entityId });
      this.mergeLate();
      this.changed();
      return;
    }
    // 풀림
    const inc = this.open().find((i) => i.violations.some((x) => x.key === key && x.end === null));
    if (!inc) return;
    const x = inc.violations.find((y) => y.key === key && y.end === null)!;
    x.end = e.ts;
    inc.timeline.push({ at: e.ts, kind: 'end', text: `회복: ${x.label} — ${x.title}`, entityId: x.entityId });
    if (inc.violations.every((y) => y.end !== null)) {
      inc.closedAt = e.ts;
      this.rt.emit('incident-closed', inc);
    }
    this.changed();
  }

  /** 늦게 드러난 사슬: 스스로를 근본 원인으로 삼았던 장애가 실은 다른 열린 장애의 근본 원인에서 번진 것이면 합친다 */
  private mergeLate(): void {
    const open = this.open();
    for (const inc of open) {
      const r = inc.root;
      if (!r.entityId) continue;
      const now = this.rootOf(r.collection, r.pk, r.entityId, r.violation);
      if (now.key === inc.rootKey) continue;
      const target = open.find((o) => o !== inc && (o.rootKey === now.key || o.violations.some((x) => `${x.collection}:${x.pk}` === now.key)));
      if (!target) continue;
      target.violations.push(...inc.violations);
      target.actions.push(...inc.actions);
      target.timeline.push(...inc.timeline);
      target.timeline.sort((a, b) => a.at - b.at);
      target.openedAt = Math.min(target.openedAt, inc.openedAt);
      this.list = this.list.filter((x) => x !== inc);
      return this.mergeLate();
    }
  }

  private onActions(actions: ActionRecord[]) {
    let dirty = false;
    for (const a of actions) {
      if (this.actionStatus.get(a.id) === a.status) continue;
      this.actionStatus.set(a.id, a.status);
      const inc = this.list.find((i) => (i.closedAt === null || a.ts <= i.closedAt + 60_000) && a.ts >= i.openedAt && (i.violations.some((x) => x.entityId === a.entityId) || i.root.entityId === a.entityId));
      if (!inc) continue;
      const known = inc.actions.find((x) => x.id === a.id);
      if (known) known.status = a.status;
      else inc.actions.push({ id: a.id, at: a.ts, title: a.title, entityId: a.entityId, commandText: a.commandText, status: a.status });
      const kind: IncidentStep['kind'] = a.status === 'verified' ? 'verified' : a.status === 'failed' || a.status === 'mismatch' ? 'failed' : a.status === 'undone' ? 'undone' : 'action';
      const text = { action: `조치(승인 후 실행): ${a.title}`, verified: `관측으로 확인됨: ${a.title}`, failed: `조치 실패: ${a.title}${a.error ? ` — ${a.error}` : ''}`, undone: `조치를 되돌림: ${a.title}`, start: '', end: '' }[kind];
      inc.timeline.push({ at: kind === 'action' ? a.ts : Date.now(), kind, text, entityId: a.entityId });
      dirty = true;
    }
    if (dirty) this.changed();
  }
}

const hm = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour12: false });
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
const md = (s: string) => s.replace(/[|\\`*_<>[\]]/g, (c) => `\\${c}`).replace(/\n/g, ' ');
/** 코드 조각 안에서는 백슬래시 이스케이프가 그대로 보이므로 백틱만 바꾼다 */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\n/g, ' ')}\``;

/** 사후 보고서(마크다운). 링크 주소(publicUrl)가 있으면 그 시점의 세계로 가는 링크를 단다 */
export function incidentReport(inc: Incident, opts: { system: string; publicUrl?: string | null }): string {
  const link = (entityId: string | null, at: number) => {
    if (!opts.publicUrl || !entityId) return '';
    const u = new URL(opts.publicUrl.endsWith('/') ? opts.publicUrl : `${opts.publicUrl}/`);
    u.searchParams.set('focus', entityId);
    u.searchParams.set('at', String(at));
    return ` ([그 시점의 세계](${u.toString()}))`;
  };
  const lines: string[] = [];
  const end = inc.closedAt;
  lines.push(`# 장애 기록: ${md(inc.root.label)} — ${new Date(inc.openedAt).toLocaleString('ko-KR', { hour12: false })}`);
  lines.push('');
  lines.push(`- 시스템: ${md(opts.system)}`);
  lines.push(`- 기간: ${hm(inc.openedAt)}${inc.observedFromStart ? '(관측을 시작했을 때 이미 진행 중 — 실제 시작은 더 이전)' : ''} ~ ${end ? `${hm(end)} (${duration(end - inc.openedAt)}${inc.observedFromStart ? ' 이상' : ''})` : '진행 중'}`);
  lines.push(`- 근본 원인: ${md(inc.root.label)} (${code(`${inc.root.collection} #${inc.root.pk}`)}) — ${md(inc.root.violation)}${inc.root.crossSystem ? ' · 다른 시스템' : ''}${link(inc.root.entityId, inc.openedAt)}`);
  if (inc.change?.length) lines.push(`- 위반 직전의 변경: ${inc.change.map((c) => `${code(c.field)} ${code(JSON.stringify(c.to))} → ${code(JSON.stringify(c.now))}`).join(', ')}`);
  const affected = new Map(inc.violations.map((v) => [`${v.collection}:${v.pk}`, v]));
  lines.push(`- 영향: ${affected.size}곳 — ${[...affected.values()].map((v) => `${md(v.label)}(${md(v.collection)})`).join(', ')}`);
  const fix = inc.actions.filter((a) => a.status !== 'failed');
  lines.push(`- 조치: ${fix.length ? fix.map((a) => `${md(a.title)} (${a.status === 'verified' ? '관측으로 확인됨' : a.status === 'undone' ? '되돌림' : a.status})`).join(', ') : '없음(저절로 회복했거나 시스템 밖에서 고침)'}`);
  const firstFix = inc.actions.find((a) => a.status === 'verified' || a.status === 'applied');
  if (firstFix) lines.push(`- 첫 조치까지: ${duration(firstFix.at - inc.openedAt)}${end ? ` · 조치 뒤 회복까지: ${duration(end - firstFix.at)}` : ''}`);
  lines.push('');
  lines.push('## 타임라인');
  lines.push('');
  lines.push('| 시각 | 일 |');
  lines.push('|---|---|');
  for (const s of [...inc.timeline].sort((a, b) => a.at - b.at)) lines.push(`| ${hm(s.at)} | ${md(s.text)}${link(s.entityId, s.at)} |`);
  lines.push('');
  lines.push('## 깨진 법칙');
  lines.push('');
  for (const v of inc.violations) {
    lines.push(`- **${md(v.label)}** (${code(`${v.collection} #${v.pk}`)}) — ${md(v.title)}: ${hm(v.start)} ~ ${v.end ? `${hm(v.end)} (${duration(v.end - v.start)})` : '아직 깨져 있음'}`);
    if (v.diagnosis) lines.push(`  - 진단: ${md(v.diagnosis)}`);
  }
  if (inc.actions.length) {
    lines.push('');
    lines.push('## 실행한 명령');
    lines.push('');
    for (const a of inc.actions) {
      lines.push(`- ${hm(a.at)} ${md(a.title)} — ${a.status}`);
      for (const c of a.commandText) lines.push(`  - ${code(c)}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('ISOMORPH 가 관측 기록으로 만든 보고서입니다. 원인은 관측된 순서와 트레이스로 추정한 것이며, 사람이 확인해야 합니다.');
  return lines.join('\n');
}
