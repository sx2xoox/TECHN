import { diagnose, findCauses } from './diagnose.ts';
import type { ChangeEvent } from './diff.ts';
import { kindById, parseEntityId, type WorldGrammar } from './grammar.ts';
import { observe } from './invariants.ts';
import { maskRow } from './legend.ts';
import { riskAllowed, type AffordanceOption, type InspectField, type InspectMessage, type WriteMode } from './protocol.ts';
import { findCollection, pkOf, type Snapshot, type SystemSchema } from './schema.ts';

/**
 * 개체 하나를 살펴보기: 원본 행(민감 필드 가림) ↔ 세계 표현, 법칙 위반, 위반 직전 사건, 원인 진단, 할 수 있는 행동.
 * 서버(실시간)와 브라우저(공유용 스냅숏)가 같은 함수를 쓴다.
 */
export function buildInspect(opts: { snapshot: Snapshot; grammar: WorldGrammar; schema: SystemSchema; events: ChangeEvent[]; entityId: string; writeMode: WriteMode; history: boolean }): InspectMessage {
  const { snapshot: snap, grammar, schema, entityId } = opts;
  const parsed = parseEntityId(entityId);
  const kind = parsed ? kindById(grammar, parsed.kind) : undefined;
  const empty: InspectMessage = { type: 'inspect', entityId, entity: null, collection: kind?.collection ?? '', pk: parsed?.pk ?? '', row: null, fields: [], violations: [], causes: [], diagnosis: null, affordances: [] };
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
  const causes = top ? findCauses(top, opts.events, schema, 20_000, row ?? undefined, topInv) : [];
  const diagnosis = top ? diagnose(top, topInv, causes) : null;
  const affordances: AffordanceOption[] = grammar.affordances
    .filter((a) => a.entityKind === kind.id)
    .map((a) => {
      const allowed = !opts.history && riskAllowed(opts.writeMode, a.risk);
      const reason = opts.history ? '과거 시점에서는 행동할 수 없습니다' : !riskAllowed(opts.writeMode, a.risk) ? `쓰기 권한(${opts.writeMode})이 위험도 ${a.risk} 행동을 허용하지 않습니다` : undefined;
      return { id: a.id, title: a.title, description: a.description, risk: a.risk, allowed, ...(reason ? { reason } : {}) };
    });
  return { type: 'inspect', entityId, entity, collection: kind.collection, pk: parsed.pk, row: masked, fields, violations, causes, diagnosis, affordances };
}
