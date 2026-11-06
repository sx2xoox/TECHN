import { diagnose, findCauses, findSharedUpstream, type Diagnosis } from './diagnose.ts';
import { findRevert } from './revert.ts';
import type { ChangeEvent } from './diff.ts';
import { kindById, parseEntityId, type WorldGrammar } from './grammar.ts';
import { observe } from './invariants.ts';
import { maskRow } from './legend.ts';
import { riskAllowed, type AffordanceOption, type ChainStep, type InspectField, type InspectMessage, type RelatedEntity, type WriteMode } from './protocol.ts';
import { findCollection, pkOf, type Snapshot, type SystemSchema } from './schema.ts';

/**
 * 개체 하나를 살펴보기: 원본 행(민감 필드 가림) ↔ 세계 표현, 법칙 위반, 위반 직전 사건, 원인 진단, 할 수 있는 행동.
 * 서버(실시간)와 브라우저(공유용 스냅숏)가 같은 함수를 쓴다.
 */
export function buildInspect(opts: {
  snapshot: Snapshot;
  grammar: WorldGrammar;
  schema: SystemSchema;
  events: ChangeEvent[];
  entityId: string;
  writeMode: WriteMode;
  history: boolean;
  /** 이 스냅숏으로 이미 계산한 세계가 있으면 다시 계산하지 않는다(실시간 살펴보기) */
  world?: ReturnType<typeof observe>;
}): InspectMessage {
  const { snapshot: snap, grammar, schema, entityId } = opts;
  const parsed = parseEntityId(entityId);
  const kind = parsed ? kindById(grammar, parsed.kind) : undefined;
  const empty: InspectMessage = { type: 'inspect', entityId, entity: null, collection: kind?.collection ?? '', pk: parsed?.pk ?? '', row: null, fields: [], violations: [], causes: [], diagnosis: null, affordances: [], related: [] };
  if (!kind || !parsed) return empty;
  const col = findCollection(schema, kind.collection);
  if (!col) return empty;
  const world = opts.world ?? observe(snap, grammar, schema);
  const entity = world.entities.find((e) => e.id === entityId) ?? null;
  const row = (snap.collections[kind.collection] ?? []).find((r) => String(pkOf(r, col)) === parsed.pk) ?? null;
  const masked = row ? maskRow(row, col) : null;
  const fields: InspectField[] = col.fields.map((f) => {
    const b = kind.channels.find((x) => x.field === f.name);
    const role: InspectField['role'] =
      f.name === col.primaryKey ? 'pk'
        : f.name === kind.labelField ? 'label'
          : kind.route?.from === f.name || kind.route?.to === f.name ? 'route'
            : kind.recency?.field === f.name ? 'recency'
              : kind.hidden.includes(f.name) ? 'hidden' : undefined;
    return {
      name: f.name,
      type: f.type,
      value: masked ? masked[f.name] ?? null : null,
      ...(b ? { channel: b.channel, visual: entity?.visual[b.channel] ?? null } : {}),
      ...(role ? { role } : {}),
      ...(f.sensitive ? { sensitive: true } : {}),
    };
  });
  const violations = world.violations.filter((v) => v.collection === kind.collection && String(v.pk) === parsed.pk);
  const sevRank = { critical: 0, warning: 1, info: 2 } as const;
  const top = [...violations].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])[0];
  const topInv = top ? grammar.invariants.find((i) => i.id === top.invariantId) : undefined;
  const causes = top ? findCauses(top, opts.events, schema, 20_000, row ?? undefined, topInv, grammar.invariants) : [];
  const up = top && row ? upstreamOf(snap, grammar, schema, world, opts.events, kind.collection, parsed.pk, row) : null;
  const diagnosis = !top ? null : up?.via === 'blame' ? blameDiagnosis(up) : up?.through ? sharedDiagnosis(up) : diagnose(top, topInv, causes);
  const chain = top && row ? chainFrom(snap, grammar, schema, world, opts.events, kind.collection, parsed.pk, row) : [];
  const revert = top && row ? findRevert(top, opts.events, schema, topInv, row) : null;
  // 위반 직전에 받은 변경이 있으면: '값을 쓰는 코드' 같은 일반론보다 그 변경을 원인 후보로 든다(더 강한 패턴은 그대로)
  if (diagnosis && revert && !['linked', 'race', 'dangling-ref', 'duplicate'].includes(diagnosis.pattern)) {
    const what = revert.changes.map((c) => `${c.field}: ${JSON.stringify(c.to)} → ${JSON.stringify(c.now)}`).join(', ');
    Object.assign(diagnosis, {
      pattern: 'after-change',
      title: '직전 변경 뒤에 깨짐',
      detail: `위반이 시작되기 직전에 이 개체가 바뀌었습니다(${what}). 그 뒤 '${top!.title}' 가 깨졌습니다.`,
      confidence: 'medium',
      suggestion: '그 변경을 되돌려 보세요(아래 \'이 변경 되돌리기\' — 드라이런 뒤 승인).',
    } satisfies Diagnosis);
  }
  const affordances: AffordanceOption[] = grammar.affordances
    .filter((a) => a.entityKind === kind.id)
    .map((a) => {
      const allowed = !opts.history && riskAllowed(opts.writeMode, a.risk);
      const reason = opts.history ? '과거 시점에서는 행동할 수 없습니다' : !riskAllowed(opts.writeMode, a.risk) ? `쓰기 권한(${opts.writeMode})이 위험도 ${a.risk} 행동을 허용하지 않습니다` : undefined;
      return { id: a.id, title: a.title, description: a.description, risk: a.risk, allowed, ...(reason ? { reason } : {}) };
    });
  const { related, more } = row ? relatedOf(snap, grammar, schema, world, kind.collection, parsed.pk, row) : { related: [], more: 0 };
  return { type: 'inspect', entityId, entity, collection: kind.collection, pk: parsed.pk, row: masked, fields, violations, causes, diagnosis, affordances, related, ...(more ? { relatedMore: more } : {}), ...(chain.length ? { chain } : {}), ...(revert ? { revert } : {}) };
}

type World = ReturnType<typeof observe>;
type Up = ChainStep & { row: Record<string, unknown>; field: string };

const sevRankOf = { critical: 0, warning: 1, info: 2 } as const;
const topViolation = (world: World, collection: string, pk: string) =>
  world.violations.filter((v) => v.collection === collection && String(v.pk) === pk).sort((a, b) => sevRankOf[a.severity] - sevRankOf[b.severity])[0];

function stepFor(snap: Snapshot, grammar: WorldGrammar, schema: SystemSchema, world: World, collection: string, pk: string, via: ChainStep['via'], crossSystem: boolean, field: string): Up | null {
  const col = findCollection(schema, collection);
  if (!col) return null;
  const row = (snap.collections[collection] ?? []).find((r) => String(pkOf(r, col)) === pk);
  const v = topViolation(world, collection, pk);
  if (!row || !v) return null; // 법칙을 어기고 있지 않은 곳은 원인으로 치지 않는다
  const k = grammar.kinds.find((x) => x.collection === collection && x.archetype !== 'npc') ?? grammar.kinds.find((x) => x.collection === collection);
  const id = k ? `${k.id}:${pk}` : null;
  const shown = id ? world.entities.find((e) => e.id === id) : undefined;
  return { collection, pk, entityId: shown ? id : null, label: shown?.label ?? `${collection} #${pk}`, title: k?.title ?? collection, violation: v.title, via, crossSystem, row, field };
}

/**
 * 한 걸음 거슬러 오르기.
 *  1) '문제가 비롯된 곳' 참조(blame)가 가리키는 곳이 법칙을 어기고 있으면 그곳(시스템이 계산한 인과라 먼저 믿는다)
 *  2) 아니면 시간 순서: 연결된 곳이 이 위반 직전에 먼저 자기 법칙을 어겼으면 그곳
 */
function upstreamOf(snap: Snapshot, grammar: WorldGrammar, schema: SystemSchema, world: World, events: ChangeEvent[], collection: string, pk: string, row: Record<string, unknown>): Up | null {
  const col = findCollection(schema, collection);
  if (!col) return null;
  for (const f of col.fields) {
    if (!f.ref?.blame || row[f.name] === null || row[f.name] === undefined) continue;
    const target = findCollection(schema, f.ref.collection);
    const tr = target && (snap.collections[target.name] ?? []).find((r) => String(r[f.ref!.field]) === String(row[f.name]));
    if (!target || !tr) continue;
    const step = stepFor(snap, grammar, schema, world, target.name, String(pkOf(tr, target)), 'blame', !!f.ref.crossSystem, f.name);
    if (step) return step;
  }
  const v = topViolation(world, collection, pk);
  if (!v) return null;
  const inv = grammar.invariants.find((i) => i.id === v.invariantId);
  const causes = findCauses(v, events, schema, 20_000, row, inv, grammar.invariants);
  const d = diagnose(v, inv, causes);
  if (d.pattern === 'linked') {
    const c = causes.filter((x) => x.relation !== 'self' && x.broke).at(-1);
    const step = c ? stepFor(snap, grammar, schema, world, c.collection, String(c.pk), 'linked', !!c.crossSystem, '') : null;
    if (step) return step;
  }
  // 3) 사이의 행으로만 이어진 곳: 이 행을 가리키는 행들(파드)이 함께 기대는 곳(노드)이 먼저 법칙을 어겼으면 그곳
  const transient = (c: string) => grammar.kinds.some((k) => k.collection === c && k.archetype === 'npc');
  const shared = findSharedUpstream(v, events, schema, inv, grammar.invariants.filter((i) => i.status !== 'dismissed'), transient);
  if (!shared) return null;
  const step = stepFor(snap, grammar, schema, world, shared.collection, String(shared.pk), 'linked', shared.crossSystem, '');
  if (!step) return null;
  const through = grammar.kinds.find((k) => k.collection === shared.through.collection && k.archetype !== 'npc')?.title ?? shared.through.collection;
  return { ...step, through: { collection: shared.through.collection, title: through, count: shared.through.count } };
}

function sharedDiagnosis(up: Up): Diagnosis {
  const t = up.through!;
  return {
    pattern: 'linked',
    title: '함께 기댄 곳이 먼저 법칙을 어김',
    detail: `이 개체와 이어진 ${t.title} ${t.count}개가 위반 직전에 함께 바뀌었고, 그것들이 기대는 ${up.collection} #${up.pk} 가 그보다 먼저 '${up.violation}' 를 어겼습니다. 이 위반은 그 결과일 수 있습니다.`,
    confidence: 'medium',
    suggestion: `먼저 ${up.collection} #${up.pk} 를 살펴보세요.`,
  };
}

function blameDiagnosis(up: Up): Diagnosis {
  return {
    pattern: 'linked',
    title: up.crossSystem ? '오류가 다른 시스템에서 시작됨' : '오류가 다른 곳에서 시작됨',
    detail: `실패한 요청을 따라 내려가 보면 오류는 ${up.collection} #${up.pk} 에서 시작됐습니다('${up.violation}'). 이 위반은 그 오류가 이어져 온 결과입니다.`,
    confidence: 'high',
    suggestion: `먼저 ${up.collection} #${up.pk} 를 살펴보세요.`,
  };
}

/** 근본 원인 사슬: 거슬러 오를 곳이 없을 때까지(고리·깊이 제한) */
function chainFrom(snap: Snapshot, grammar: WorldGrammar, schema: SystemSchema, world: World, events: ChangeEvent[], collection: string, pk: string, row: Record<string, unknown>): ChainStep[] {
  const seen = new Set([`${collection}:${pk}`]);
  const out: ChainStep[] = [];
  let cur = { collection, pk, row };
  for (let i = 0; i < 6; i++) {
    const up = upstreamOf(snap, grammar, schema, world, events, cur.collection, cur.pk, cur.row);
    if (!up || seen.has(`${up.collection}:${up.pk}`)) break;
    seen.add(`${up.collection}:${up.pk}`);
    const { row: next, field: _f, ...step } = up;
    out.push(step);
    cur = { collection: up.collection, pk: String(up.pk), row: next };
  }
  return out;
}

const RELATED_MAX = 12;

/** 참조로 바로 이어진 곳들: 법칙을 어기는 곳·다른 시스템을 먼저 */
function relatedOf(snap: Snapshot, grammar: WorldGrammar, schema: SystemSchema, world: ReturnType<typeof observe>, collection: string, pk: string, row: Record<string, unknown>): { related: RelatedEntity[]; more: number } {
  const out: RelatedEntity[] = [];
  const describe = (c: string, rowPk: string, r: Record<string, unknown> | undefined, direction: 'to' | 'from', field: string, crossSystem: boolean) => {
    const k = grammar.kinds.find((x) => x.collection === c && x.archetype !== 'npc') ?? grammar.kinds.find((x) => x.collection === c);
    const id = k ? `${k.id}:${rowPk}` : null;
    const shown = id ? world.entities.find((e) => e.id === id) : undefined;
    const label = shown?.label ?? (k?.labelField && r?.[k.labelField] != null ? String(r[k.labelField]) : `${c} #${rowPk}`);
    const violations = world.violations.filter((v) => v.collection === c && String(v.pk) === rowPk).map((v) => ({ title: v.title, severity: v.severity }));
    out.push({ entityId: shown ? id : null, collection: c, pk: rowPk, label, title: k?.title ?? c, direction, field, crossSystem, violations });
  };
  const col = findCollection(schema, collection)!;
  // 이 행이 가리키는 곳
  for (const f of col.fields) {
    if (!f.ref || row[f.name] === null || row[f.name] === undefined) continue;
    const target = findCollection(schema, f.ref.collection);
    if (!target) continue;
    const r = (snap.collections[target.name] ?? []).find((x) => String(x[f.ref!.field]) === String(row[f.name]));
    // 대상 행이 관측 창 밖이면 참조 값 그대로를 보여 주게 되는데, 그 값이 민감하면(이메일로 잇는 참조 등) 내보내지 않는다
    if (!r && (f.sensitive || target.fields.find((x) => x.name === f.ref!.field)?.sensitive)) continue;
    describe(target.name, String(r ? pkOf(r, target) : row[f.name]), r, 'to', f.name, !!f.ref.crossSystem);
  }
  // 이 행을 가리키는 곳. 오가는 개체(스팬·이벤트처럼 걸어 다니는 것)는 끊임없이 바뀌므로 하나하나 늘어놓지 않고,
  // 법칙을 어기는 것만 보이고 나머지는 수로만 센다(목록이 계속 바뀌면 누르려던 줄이 사라진다)
  let skipped = 0;
  for (const c of schema.collections) {
    const transient = grammar.kinds.some((k) => k.collection === c.name && k.archetype === 'npc');
    for (const f of c.fields) {
      if (f.ref?.collection !== collection) continue;
      const mine = row[f.ref.field];
      for (const r of snap.collections[c.name] ?? []) {
        if (String(r[f.name]) !== String(mine)) continue;
        const rowPk = String(pkOf(r, c));
        if (transient && !world.violations.some((v) => v.collection === c.name && String(v.pk) === rowPk)) {
          skipped++;
          continue;
        }
        describe(c.name, rowPk, r, 'from', f.name, !!f.ref.crossSystem);
      }
    }
  }
  const rank = (x: RelatedEntity) => (x.violations.length ? 0 : 2) + (x.crossSystem ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || String(a.pk).localeCompare(String(b.pk)));
  return { related: out.slice(0, RELATED_MAX), more: Math.max(0, out.length - RELATED_MAX) + skipped };
}
