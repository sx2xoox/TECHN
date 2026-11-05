import { diagnose, findCauses } from './diagnose.ts';
import type { ChangeEvent } from './diff.ts';
import { kindById, parseEntityId, type WorldGrammar } from './grammar.ts';
import { observe } from './invariants.ts';
import { maskRow } from './legend.ts';
import { riskAllowed, type AffordanceOption, type InspectField, type InspectMessage, type RelatedEntity, type WriteMode } from './protocol.ts';
import { findCollection, pkOf, type Snapshot, type SystemSchema } from './schema.ts';

/**
 * 개체 하나를 살펴보기: 원본 행(민감 필드 가림) ↔ 세계 표현, 법칙 위반, 위반 직전 사건, 원인 진단, 할 수 있는 행동.
 * 서버(실시간)와 브라우저(공유용 스냅숏)가 같은 함수를 쓴다.
 */
export function buildInspect(opts: { snapshot: Snapshot; grammar: WorldGrammar; schema: SystemSchema; events: ChangeEvent[]; entityId: string; writeMode: WriteMode; history: boolean }): InspectMessage {
  const { snapshot: snap, grammar, schema, entityId } = opts;
  const parsed = parseEntityId(entityId);
  const kind = parsed ? kindById(grammar, parsed.kind) : undefined;
  const empty: InspectMessage = { type: 'inspect', entityId, entity: null, collection: kind?.collection ?? '', pk: parsed?.pk ?? '', row: null, fields: [], violations: [], causes: [], diagnosis: null, affordances: [], related: [] };
  if (!kind || !parsed) return empty;
  const col = findCollection(schema, kind.collection);
  if (!col) return empty;
  const world = observe(snap, grammar, schema);
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
  const diagnosis = top ? diagnose(top, topInv, causes) : null;
  const affordances: AffordanceOption[] = grammar.affordances
    .filter((a) => a.entityKind === kind.id)
    .map((a) => {
      const allowed = !opts.history && riskAllowed(opts.writeMode, a.risk);
      const reason = opts.history ? '과거 시점에서는 행동할 수 없습니다' : !riskAllowed(opts.writeMode, a.risk) ? `쓰기 권한(${opts.writeMode})이 위험도 ${a.risk} 행동을 허용하지 않습니다` : undefined;
      return { id: a.id, title: a.title, description: a.description, risk: a.risk, allowed, ...(reason ? { reason } : {}) };
    });
  const { related, more } = row ? relatedOf(snap, grammar, schema, world, kind.collection, parsed.pk, row) : { related: [], more: 0 };
  return { type: 'inspect', entityId, entity, collection: kind.collection, pk: parsed.pk, row: masked, fields, violations, causes, diagnosis, affordances, related, ...(more ? { relatedMore: more } : {}) };
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
