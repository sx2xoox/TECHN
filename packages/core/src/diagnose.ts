import type { ChangeEvent } from './diff.ts';
import { evalExpr, type EvalContext } from './expr.ts';
import type { Invariant } from './grammar.ts';
import type { Pk, Row, SystemSchema } from './schema.ts';
import type { Violation } from './world.ts';

/**
 * 원인 추적: 법칙 위반 직전에 무슨 일이 있었는가.
 * 위반 행 자신의 변화 + 그 행을 참조하는 다른 행들의 변화를 시간순으로 엮는다.
 */
export interface CauseEvent {
  ts: number;
  /** 행 자신의 타임스탬프(created_at 등)가 있으면 그 시각(더 정밀) */
  at: number;
  collection: string;
  pk: Pk;
  kind: ChangeEvent['kind'];
  summary: string;
  relation: 'self' | 'referencing' | 'referenced';
  /** 이 사건으로 연결된 행이 자기 법칙을 어기기 시작했다면 그 법칙 */
  broke?: string;
  /** 다른 시스템의 행인가 */
  crossSystem?: boolean;
}

export interface Diagnosis {
  pattern: 'race' | 'sudden-change' | 'dangling-ref' | 'duplicate' | 'time-order' | 'mismatch' | 'linked' | 'unknown';
  title: string;
  detail: string;
  confidence: 'high' | 'medium' | 'low';
  suggestion?: string;
}

const TS_FIELD_RE = /^(created|inserted|updated|modified)(_at)?$/i;
const ISO_VALUE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
/** 사건 요약('a: 1 → 2, b: …')에서 정확히 그 필드가 바뀌었는가(replicas ≠ ready_replicas) */
const touches = (summary: string, field: string) => new RegExp(`(^|, )${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `).test(summary);

function rowTime(row: Row | null, fallback: number, prefer: 'created' | 'updated'): number {
  if (!row) return fallback;
  const keys = Object.keys(row).filter((k) => TS_FIELD_RE.test(k));
  keys.sort((a, b) => (a.startsWith(prefer) ? -1 : b.startsWith(prefer) ? 1 : 0));
  for (const k of keys) {
    const v = row[k];
    const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

/** 민감 필드(비밀번호·이메일·토큰 등)는 사건 기록에서도 값을 가린다(바뀌었다는 사실만 남긴다) */
function changed(before: Row | null, after: Row | null, sensitive: Set<string> = new Set()): string {
  if (!before || !after) return '';
  const parts: string[] = [];
  for (const k of Object.keys(after)) {
    if (TS_FIELD_RE.test(k)) continue;
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    parts.push(sensitive.has(k) ? `${k}: (가림) 바뀜` : `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
  }
  return parts.join(', ');
}

function brief(row: Row | null, sensitive: Set<string> = new Set()): string {
  if (!row) return '';
  return Object.entries(row)
    .filter(([k]) => !TS_FIELD_RE.test(k))
    .slice(0, 5)
    .map(([k, v]) => `${k}=${sensitive.has(k) ? '(가림)' : JSON.stringify(v)}`)
    .join(' ');
}

const ROW_LOCAL = new Set(['cmp', 'cmpField', 'in', 'notNull', 'and', 'or', 'not', 'implies']);
const NO_CTX: EvalContext = { valuesOf: () => new Set(), countOf: () => 0 };

/**
 * 위반이 '시작된' 순간(법칙을 지키던 값이 깨진 변경)을 기준으로 앞뒤 사건을 모은다.
 * 위반 이후의 조치(예: 운영자가 문을 잠근 것)를 원인으로 오인하지 않기 위함.
 */
export function findCauses(v: Violation, events: ChangeEvent[], schema: SystemSchema, windowMs = 20_000, rowNow?: Row, inv?: Invariant, laws?: Invariant[]): CauseEvent[] {
  const sens = (collection: string) => new Set(schema.collections.find((c) => c.name === collection)?.fields.filter((f) => f.sensitive).map((f) => f.name) ?? []);
  /** 이 사건으로 그 행이 자기 법칙을 어기기 시작했나(지키던 → 어김) */
  const brokeBy = (e: ChangeEvent): string | undefined => {
    if (!laws || !e.after) return undefined;
    for (const l of laws) {
      if (l.collection !== e.collection || l.status === 'dismissed' || !ROW_LOCAL.has(l.expr.op)) continue;
      const afterOk = evalExpr(l.expr, e.after, NO_CTX);
      const beforeOk = e.before ? evalExpr(l.expr, e.before, NO_CTX) : true;
      if (!afterOk && beforeOk) return l.title;
    }
    return undefined;
  };
  const vKey = String(v.pk);
  const selfEvents = events.filter((e) => e.collection === v.collection && String(e.pk) === vKey).sort((a, b) => a.ts - b.ts);
  let onset: number | undefined;
  if (inv && ROW_LOCAL.has(inv.expr.op)) {
    for (const e of selfEvents) {
      const afterOk = e.after ? evalExpr(inv.expr, e.after, NO_CTX) : true;
      const beforeOk = e.before ? evalExpr(inv.expr, e.before, NO_CTX) : true;
      if (!afterOk && beforeOk) onset = e.ts;
    }
  }
  const end = onset ?? (selfEvents.length ? selfEvents.at(-1)!.ts : Math.max(0, ...events.map((e) => e.ts)));
  const start = end - windowMs;
  const out: CauseEvent[] = [];
  const withBroke = (e: ChangeEvent, crossSystem: boolean) => {
    // 같은 순간의 변화는 원인으로 돌리지 않는다(어느 쪽이 먼저인지 모름)
    const broke = e.ts < end ? brokeBy(e) : undefined;
    return { ...(broke ? { broke } : {}), ...(crossSystem ? { crossSystem: true } : {}) };
  };

  for (const e of selfEvents) {
    if (e.ts < start || e.ts > end) continue;
    out.push({
      ts: e.ts,
      at: rowTime(e.after ?? e.before, e.ts, 'updated'),
      collection: e.collection,
      pk: e.pk,
      kind: e.kind,
      summary: e.kind === 'update' ? changed(e.before, e.after, sens(e.collection)) : e.kind === 'insert' ? `생성 (${brief(e.after, sens(e.collection))})` : '삭제',
      relation: 'self',
    });
  }

  const refFields = schema.collections.flatMap((c) =>
    c.fields.filter((f) => f.ref?.collection === v.collection).map((f) => ({ collection: c.name, field: f.name, crossSystem: !!f.ref?.crossSystem })),
  );
  for (const e of events) {
    if (e.ts < start || e.ts > end) continue;
    for (const rf of refFields) {
      if (e.collection !== rf.collection) continue;
      const row = e.after ?? e.before;
      if (!row || String(row[rf.field]) !== vKey) continue;
      out.push({
        ts: e.ts,
        at: rowTime(row, e.ts, e.kind === 'insert' ? 'created' : 'updated'),
        collection: e.collection,
        pk: e.pk,
        kind: e.kind,
        summary: e.kind === 'insert' ? `생성 (${brief(e.after, sens(e.collection))})` : e.kind === 'update' ? changed(e.before, e.after, sens(e.collection)) : '삭제',
        relation: 'referencing',
        ...withBroke(e, rf.crossSystem),
      });
    }
  }

  // 참조 대상이 사라진 경우(refExists 위반)
  const row = rowNow ?? selfEvents.at(-1)?.after ?? null;
  if (row) {
    for (const col of schema.collections) {
      if (col.name !== v.collection) continue;
      for (const f of col.fields) {
        if (!f.ref || row[f.name] === null || row[f.name] === undefined) continue;
        for (const e of events) {
          if (e.collection !== f.ref.collection || String(e.pk) !== String(row[f.name])) continue;
          if (e.kind === 'delete') {
            out.push({ ts: e.ts, at: e.ts, collection: e.collection, pk: e.pk, kind: 'delete', summary: `참조 대상 삭제됨 (${brief(e.before, sens(e.collection))})`, relation: 'referenced', ...(f.ref.crossSystem ? { crossSystem: true } : {}) });
            continue;
          }
          // 가리키는 대상(다른 시스템일 수도)이 위반 직전에 자기 법칙을 어기기 시작했다면 원인 후보
          if (e.ts < start || e.ts >= end) continue;
          const broke = brokeBy(e);
          if (!broke) continue;
          out.push({ ts: e.ts, at: e.ts, collection: e.collection, pk: e.pk, kind: e.kind, summary: e.kind === 'update' ? changed(e.before, e.after, sens(e.collection)) : `생성 (${brief(e.after, sens(e.collection))})`, relation: 'referenced', broke, ...(f.ref.crossSystem ? { crossSystem: true } : {}) });
        }
      }
    }
  }
  out.sort((a, b) => a.at - b.at || a.ts - b.ts);
  // 연결된 곳이 법칙을 어긴 사건은 잦은 사건(스팬 수십 개 등)에 밀려나지 않게 늘 남긴다
  const key = out.filter((c) => c.broke).slice(-10);
  const rest = out.filter((c) => !c.broke).slice(-(40 - key.length));
  return [...key, ...rest].sort((a, b) => a.at - b.at || a.ts - b.ts);
}

export function diagnose(v: Violation, inv: Invariant | undefined, causes: CauseEvent[]): Diagnosis {
  const expr = inv?.expr;
  if (expr?.op === 'refExists') {
    const del = causes.find((c) => c.relation === 'referenced' && c.kind === 'delete');
    return del
      ? { pattern: 'dangling-ref', title: '참조 대상이 먼저 삭제됨', detail: `${del.collection} #${del.pk} 가 삭제됐지만 이 행은 여전히 그것을 가리킵니다.`, confidence: 'high', suggestion: '삭제 시 연쇄 처리(ON DELETE) 또는 외래키 제약을 추가하세요.' }
      : { pattern: 'dangling-ref', title: '존재하지 않는 대상을 참조', detail: `${expr.field} 가 가리키는 ${expr.collection} 행이 없습니다.`, confidence: 'medium', suggestion: '참조 무결성(외래키)을 강제하세요.' };
  }
  if (expr?.op === 'unique') {
    return { pattern: 'duplicate', title: '같은 값이 두 번 존재', detail: `${expr.field}=${JSON.stringify(v.values[expr.field])} 인 행이 둘 이상입니다.`, confidence: 'high', suggestion: 'UNIQUE 제약 또는 멱등 키를 추가하세요.' };
  }
  // 연결된 행(같은 시스템의 참조든, 다른 시스템이든)이 '먼저' 자기 법칙을 어겼다면: 이 위반은 그 결과일 수 있다
  const upstream = causes.filter((c) => c.relation !== 'self' && c.broke).at(-1);
  if (upstream) {
    return {
      pattern: 'linked',
      title: upstream.crossSystem ? '다른 시스템의 연결된 곳이 먼저 법칙을 어김' : '연결된 곳이 먼저 법칙을 어김',
      detail: `${upstream.collection} #${upstream.pk} 가 '${upstream.broke}' 를 먼저 어겼고(${upstream.summary}), 그 뒤에 이 법칙이 깨졌습니다. 이 위반은 그 결과일 수 있습니다.`,
      confidence: 'medium',
      suggestion: `먼저 ${upstream.collection} #${upstream.pk} 를 살펴보세요.`,
    };
  }
  if (expr?.op === 'cmpField') {
    const a = v.values[expr.field];
    const b = v.values[expr.other];
    // 두 시각의 순서(created_at ≤ closed_at 등)
    if ([a, b].some((x) => typeof x === 'string' && ISO_VALUE_RE.test(x))) {
      return { pattern: 'time-order', title: '시간 순서가 뒤바뀜', detail: `${expr.field} 와 ${expr.other} 의 순서가 법칙과 반대입니다. 서버 간 시계 불일치나 잘못된 갱신일 수 있습니다.`, confidence: 'medium' };
    }
    // 두 값의 관계(준비된 수 ≥ 원하는 수, 지불액 ≤ 총액 등): 어느 쪽이 먼저 움직였나
    const rel = `${expr.field}=${JSON.stringify(a)}, ${expr.other}=${JSON.stringify(b)} (법칙: ${expr.field} ${expr.cmp} ${expr.other})`;
    const moved = (f: string) => causes.filter((c) => c.relation === 'self' && c.kind === 'update' && touches(c.summary, f)).at(-1);
    const mine = moved(expr.field);
    const theirs = moved(expr.other);
    if (theirs && (!mine || theirs.at >= mine.at)) {
      return { pattern: 'mismatch', title: '기준 값이 방금 바뀜', detail: `${theirs.summary} — ${expr.other} 가 바뀐 뒤 ${expr.field} 가 아직 따라오지 못했습니다. ${rel}. 따라잡는 중일 수 있습니다.`, confidence: 'medium', suggestion: `잠시 뒤에도 그대로면 ${expr.field} 가 따라오지 못하는 이유(자원 부족·오류)를 확인하세요.` };
    }
    if (mine) {
      return { pattern: 'sudden-change', title: '한 번의 갱신이 법칙을 깨뜨림', detail: `${mine.summary} — 이 갱신 직후 ${rel} 가 되었습니다.`, confidence: 'medium', suggestion: '이 값을 쓰는 코드 경로를 확인하세요.' };
    }
    return { pattern: 'mismatch', title: '두 값이 어긋난 채로 머묾', detail: `관측 구간 내내 ${rel} 였습니다. 한쪽이 다른 쪽을 따라잡지 못하고 있습니다.`, confidence: 'low', suggestion: `${expr.field} 가 ${expr.other} 를 따라가지 못하게 막는 것(자원 부족·오류·멈춘 작업)을 확인하세요.` };
  }
  if (expr?.op === 'cmp' && typeof expr.value === 'number') {
    const field = expr.field;
    const referencing = causes.filter((c) => c.relation === 'referencing' && c.kind === 'insert');
    const selfDrops = causes.filter((c) => c.relation === 'self' && c.kind === 'update' && touches(c.summary, field));
    // 경쟁 조건 이야기는 '바닥(하한)을 뚫은' 수량에만 맞는다(재고 ≥ 0). 상한(재시작 ≤ 3)에는 쓰지 않는다.
    const lowerBound = expr.cmp === '>=' || expr.cmp === '>';
    const now = v.values[field];
    // 짧은 시간 안에 몰린 요청 묶음 찾기
    let best: CauseEvent[] = [];
    for (let i = 0; i < referencing.length; i++) {
      const group = referencing.filter((c) => c.at >= referencing[i].at && c.at - referencing[i].at <= 1500);
      if (group.length > best.length) best = group;
    }
    if (lowerBound && best.length >= 2) {
      const span = best.at(-1)!.at - best[0].at;
      const coll = best[0].collection;
      return {
        pattern: 'race',
        title: '동시성 경쟁 조건(race condition) 의심',
        detail: `${coll} 요청 ${best.length}건(#${best.map((c) => c.pk).join(', #')})이 ${span}ms 안에 거의 동시에 들어왔고, ${field} 가 ${JSON.stringify(now)} 이 되었습니다. 각 요청이 '남은 수량 확인'과 '차감' 사이에 서로를 보지 못해(check-then-act) 같은 수량을 중복으로 가져간 것으로 보입니다.`,
        confidence: selfDrops.length >= 1 ? 'high' : 'medium',
        suggestion: `확인과 차감을 하나의 원자적 조건부 갱신(예: UPDATE … SET ${field} = ${field} - n WHERE ${field} >= n)이나 행 잠금(SELECT … FOR UPDATE)으로 묶으세요.`,
      };
    }
    if (selfDrops.length) {
      const last = selfDrops.at(-1)!;
      return { pattern: 'sudden-change', title: '한 번의 갱신이 법칙을 깨뜨림', detail: `${last.summary} — 이 갱신 직후 법칙(${inv?.title ?? field})이 깨졌습니다.`, confidence: 'medium', suggestion: '이 값을 쓰는 코드 경로에 범위 검사를 추가하세요.' };
    }
  }
  return { pattern: 'unknown', title: '원인 미확정', detail: '관측 구간 안에서 뚜렷한 원인 패턴을 찾지 못했습니다. 아래 사건 기록을 확인하세요.', confidence: 'low' };
}
