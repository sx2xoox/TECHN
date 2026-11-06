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
  /** 이 위반과 같은 관측에서 깨졌다(순서는 시각으로 모름 — 연결의 방향상 그쪽이 기반이라 원인 후보로 둔다) */
  sameTick?: boolean;
  /** 어댑터가 밝힌 연결의 방향: 그 행이 이 행의 기반(upstream)인가, 이 행에 기대는 쪽(downstream)인가 */
  direction?: 'upstream' | 'downstream';
}

export interface Diagnosis {
  pattern: 'race' | 'sudden-change' | 'dangling-ref' | 'duplicate' | 'time-order' | 'mismatch' | 'linked' | 'after-change' | 'unknown';
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
interface EventIndex {
  byRow: Map<string, ChangeEvent[]>;
  byCollection: Map<string, ChangeEvent[]>;
  maxTs: number;
}
/** 같은 사건 배열로 여러 번 원인을 찾을 때(장애 때 위반 수백 개) 매번 전부를 훑지 않도록 한 번 색인한다. 배열은 바뀌지 않는다고 본다 */
const INDEXES = new WeakMap<ChangeEvent[], EventIndex>();
const rowKey = (collection: string, pk: unknown) => `${collection}\u0000${String(pk)}`;
function indexEvents(events: ChangeEvent[]): EventIndex {
  let ix = INDEXES.get(events);
  if (ix) return ix;
  ix = { byRow: new Map(), byCollection: new Map(), maxTs: 0 };
  for (const e of events) {
    const k = rowKey(e.collection, e.pk);
    const a = ix.byRow.get(k);
    if (a) a.push(e);
    else ix.byRow.set(k, [e]);
    const b = ix.byCollection.get(e.collection);
    if (b) b.push(e);
    else ix.byCollection.set(e.collection, [e]);
    if (e.ts > ix.maxTs) ix.maxTs = e.ts;
  }
  INDEXES.set(events, ix);
  return ix;
}

/** 위반이 시작된 시각(행 하나로 판단하는 법칙만): 지키던 값이 깨진 마지막 변경. 모르면 undefined */
export function violationOnset(v: Violation, events: ChangeEvent[], inv?: Invariant): number | undefined {
  if (!inv || !ROW_LOCAL.has(inv.expr.op)) return undefined;
  const ix = indexEvents(events);
  let onset: number | undefined;
  for (const e of [...(ix.byRow.get(rowKey(v.collection, String(v.pk))) ?? [])].sort((a, b) => a.ts - b.ts)) {
    const afterOk = e.after ? evalExpr(inv.expr, e.after, NO_CTX) : true;
    const beforeOk = e.before ? evalExpr(inv.expr, e.before, NO_CTX) : true;
    if (!afterOk && beforeOk) onset = e.ts;
  }
  return onset;
}

/** 이 사건으로 그 행이 자기 법칙을 어기기 시작했나(지키던 → 어김). 어긴 법칙의 제목 */
function lawBrokenBy(e: ChangeEvent, laws: Invariant[]): string | undefined {
  if (!e.after) return undefined;
  for (const l of laws) {
    if (l.collection !== e.collection || l.status === 'dismissed' || !ROW_LOCAL.has(l.expr.op)) continue;
    if (!evalExpr(l.expr, e.after, NO_CTX) && (e.before ? evalExpr(l.expr, e.before, NO_CTX) : true)) return l.title;
  }
  return undefined;
}

/** 함께 기댄 곳: 이 행과 그곳 사이를 잇는 행들(예: 디플로이먼트 ← 파드 → 노드) */
export interface SharedUpstream {
  collection: string;
  pk: Pk;
  /** 그곳이 먼저 어긴 법칙 */
  broke: string;
  at: number;
  /** 잇는 행들: 컬렉션과, 위반 직전에 바뀐 그 행의 수 */
  through: { collection: string; count: number };
  crossSystem: boolean;
}

/**
 * 직접 이어지지 않은 원인 찾기: 이 행을 가리키는 행들(파드)이 위반 직전(같은 순간 포함)에 바뀌었고,
 * 그 행들이 함께 가리키는 다른 곳(노드)이 그보다 '먼저' 자기 법칙을 어겼다면 그곳.
 * 디플로이먼트와 노드처럼 서로를 직접 가리키지 않고 사이의 행으로만 이어지는 경우를 위한 것이다.
 * 늘 새로 생기는 오가는 행(스팬 등)은 skip 으로 빼야 한다(어느 위반과도 '직전에 바뀐 연결' 이 되어 근거가 못 된다).
 */
export function findSharedUpstream(v: Violation, events: ChangeEvent[], schema: SystemSchema, inv: Invariant | undefined, laws: Invariant[], skip: (collection: string) => boolean, windowMs = 20_000): SharedUpstream | null {
  const end = violationOnset(v, events, inv);
  if (end === undefined) return null;
  const start = end - windowMs;
  const ix = indexEvents(events);
  const vKey = String(v.pk);
  const broke = new Map<string, { title: string; at: number } | null>();
  const brokeBefore = (collection: string, pk: unknown) => {
    const k = rowKey(collection, pk);
    if (!broke.has(k)) {
      let hit: { title: string; at: number } | null = null;
      for (const e of ix.byRow.get(k) ?? []) {
        if (e.ts < start || e.ts >= end) continue; // 같은 순간은 어느 쪽이 먼저인지 모른다
        const t = lawBrokenBy(e, laws);
        if (t && (!hit || e.ts < hit.at)) hit = { title: t, at: e.ts };
      }
      broke.set(k, hit);
    }
    return broke.get(k)!;
  };
  const found = new Map<string, SharedUpstream & { rows: Set<string> }>();
  for (const c of schema.collections) {
    if (skip(c.name)) continue;
    const back = c.fields.filter((f) => f.ref?.collection === v.collection);
    const out = c.fields.filter((f) => f.ref && !back.includes(f) && f.ref.field === schema.collections.find((x) => x.name === f.ref!.collection)?.primaryKey);
    if (!back.length || !out.length) continue;
    for (const e of ix.byCollection.get(c.name) ?? []) {
      if (e.ts < start || e.ts > end) continue;
      const row = e.after ?? e.before;
      if (!row || !back.some((f) => String(row[f.name]) === vKey)) continue;
      for (const f of out) {
        const val = row[f.name];
        if (val === null || val === undefined || (f.ref!.collection === v.collection && String(val) === vKey)) continue;
        const b = brokeBefore(f.ref!.collection, val);
        // 사이의 행은 그곳이 깨진 '뒤에' 바뀐 것만 근거로 센다(그 전의 변화는 이 일과 상관없다)
        if (!b || e.ts < b.at) continue;
        const k = rowKey(f.ref!.collection, val);
        let s = found.get(k);
        if (!s) found.set(k, (s = { collection: f.ref!.collection, pk: val as Pk, broke: b.title, at: b.at, through: { collection: c.name, count: 0 }, crossSystem: !!f.ref!.crossSystem || back.some((x) => x.ref!.crossSystem), rows: new Set() }));
        s.rows.add(String(row[c.primaryKey]));
      }
    }
  }
  const best = [...found.values()].sort((a, b) => b.rows.size - a.rows.size || a.at - b.at)[0];
  if (!best) return null;
  const { rows, ...rest } = best;
  return { ...rest, through: { collection: rest.through.collection, count: rows.size } };
}

export function findCauses(v: Violation, events: ChangeEvent[], schema: SystemSchema, windowMs = 20_000, rowNow?: Row, inv?: Invariant, laws?: Invariant[]): CauseEvent[] {
  const ix = indexEvents(events);
  const sensCache = new Map<string, Set<string>>();
  const sens = (collection: string) => {
    let s = sensCache.get(collection);
    if (!s) sensCache.set(collection, (s = new Set(schema.collections.find((c) => c.name === collection)?.fields.filter((f) => f.sensitive).map((f) => f.name) ?? [])));
    return s;
  };
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
  const selfEvents = [...(ix.byRow.get(rowKey(v.collection, vKey)) ?? [])].sort((a, b) => a.ts - b.ts);
  const onset = violationOnset(v, events, inv);
  const end = onset ?? (selfEvents.length ? selfEvents.at(-1)!.ts : ix.maxTs);
  const start = end - windowMs;
  const out: CauseEvent[] = [];
  const withBroke = (e: ChangeEvent, crossSystem: boolean, upstreamSide: boolean) => {
    // 같은 순간의 변화는 원인으로 돌리지 않는다(어느 쪽이 먼저인지 모름).
    // 단, 그쪽이 이 행의 기반이라고 어댑터가 밝힌 연결(파드 → 디플로이먼트 → 서비스)이면 낮은 확신의 후보로 둔다
    const tie = e.ts === end && upstreamSide;
    const broke = e.ts < end || tie ? brokeBy(e) : undefined;
    return { ...(broke ? { broke } : {}), ...(broke && tie ? { sameTick: true } : {}), ...(crossSystem ? { crossSystem: true } : {}) };
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
    c.fields.filter((f) => f.ref?.collection === v.collection).map((f) => ({ collection: c.name, field: f.name, crossSystem: !!f.ref?.crossSystem, upstreamSide: f.ref?.upstream === 'source', direction: f.ref?.upstream === 'source' ? ('upstream' as const) : f.ref?.upstream === 'target' ? ('downstream' as const) : undefined })),
  );
  for (const rf of refFields) {
    for (const e of ix.byCollection.get(rf.collection) ?? []) {
      if (e.ts < start || e.ts > end) continue;
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
        ...withBroke(e, rf.crossSystem, rf.upstreamSide),
        ...(rf.direction ? { direction: rf.direction } : {}),
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
        for (const e of ix.byRow.get(rowKey(f.ref.collection, row[f.name])) ?? []) {
          if (e.kind === 'delete') {
            out.push({ ts: e.ts, at: e.ts, collection: e.collection, pk: e.pk, kind: 'delete', summary: `참조 대상 삭제됨 (${brief(e.before, sens(e.collection))})`, relation: 'referenced', ...(f.ref.crossSystem ? { crossSystem: true } : {}) });
            continue;
          }
          // 가리키는 대상(다른 시스템일 수도)이 위반 직전에 자기 법칙을 어기기 시작했다면 원인 후보(같은 관측이면 대상이 기반일 때만)
          const tie = e.ts === end && f.ref.upstream === 'target';
          if (e.ts < start || e.ts > end || (e.ts === end && !tie)) continue;
          const broke = brokeBy(e);
          if (!broke) continue;
          out.push({ ts: e.ts, at: e.ts, collection: e.collection, pk: e.pk, kind: e.kind, summary: e.kind === 'update' ? changed(e.before, e.after, sens(e.collection)) : `생성 (${brief(e.after, sens(e.collection))})`, relation: 'referenced', broke, ...(tie ? { sameTick: true } : {}), ...(f.ref.upstream ? { direction: f.ref.upstream === 'target' ? ('upstream' as const) : ('downstream' as const) } : {}), ...(f.ref.crossSystem ? { crossSystem: true } : {}) });
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
  const linked = causes.filter((c) => c.relation !== 'self' && c.broke);
  const upstream = linked.filter((c) => !c.sameTick).at(-1);
  const tied = linked.find((c) => c.sameTick);
  if (!upstream && tied) {
    return {
      pattern: 'linked',
      title: '연결된 기반이 같은 관측에서 함께 깨짐',
      detail: `${tied.collection} #${tied.pk} 가 이 위반과 같은 관측에서 '${tied.broke}' 를 어겼습니다(${tied.summary}). 시각으로는 어느 쪽이 먼저인지 모르지만, 연결의 방향상 그쪽이 이곳의 기반이라 원인일 가능성이 높습니다.`,
      confidence: 'low',
      suggestion: `먼저 ${tied.collection} #${tied.pk} 를 살펴보세요.`,
    };
  }
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
