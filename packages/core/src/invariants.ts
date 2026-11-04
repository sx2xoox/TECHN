import { buildContextFactory } from './context.ts';
import { describeExpr, evalExpr, fieldsOfExpr, type Expr } from './expr.ts';
import { isQuant, type AnomalyKind, type Invariant, type WorldGrammar } from './grammar.ts';
import { project } from './lens.ts';
import { findCollection, findField, pkOf, type Row, type Snapshot, type SystemSchema } from './schema.ts';
import type { Violation, WorldState } from './world.ts';

function pick(row: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

export function evaluateInvariants(snapshot: Snapshot, grammar: WorldGrammar, schema: SystemSchema): Violation[] {
  const ctxFor = buildContextFactory(snapshot, schema);
  const out: Violation[] = [];
  for (const inv of grammar.invariants) {
    if (inv.status === 'dismissed') continue;
    const col = findCollection(schema, inv.collection);
    if (!col) continue;
    const ctx = ctxFor(inv.collection);
    const fields = [...new Set(fieldsOfExpr(inv.expr))];
    for (const row of snapshot.collections[inv.collection] ?? []) {
      if (evalExpr(inv.expr, row, ctx)) continue;
      out.push({
        invariantId: inv.id,
        collection: inv.collection,
        pk: pkOf(row, col),
        title: inv.title,
        kind: inv.anomaly,
        severity: inv.severity,
        proposed: inv.status === 'proposed',
        values: pick(row, fields),
      });
    }
  }
  return out;
}

/** get + 불변식 = 사람에게 보이는 세계 */
export function observe(snapshot: Snapshot, grammar: WorldGrammar, schema: SystemSchema): WorldState {
  const entities = project(snapshot, grammar, schema);
  const violations = evaluateInvariants(snapshot, grammar, schema);
  const bySource = new Map<string, typeof entities>();
  for (const e of entities) {
    const k = `${e.source.collection}:${String(e.source.pk)}`;
    const list = bySource.get(k) ?? [];
    list.push(e);
    bySource.set(k, list);
  }
  for (const v of violations) {
    for (const e of bySource.get(`${v.collection}:${String(v.pk)}`) ?? []) {
      e.anomalies.push({ invariantId: v.invariantId, kind: v.kind, message: v.title, proposed: v.proposed, severity: v.severity });
    }
  }
  return { ts: snapshot.ts, system: grammar.system, regions: grammar.regions, entities, violations };
}

/* ─────────────────────────── 불변식 채굴(mining) ─────────────────────────── */

const NON_NEGATIVE_RE = /^(stock|quantity|qty|inventory|count|balance|price|amount|capacity|available|units|total|remaining|seats|beds|copies|credits?)(_|$)|(_count|_qty|_stock|_balance|_amount|_price)$/i;
const CRITICAL_RE = /(stock|inventory|balance|qty|quantity|available|seats|beds|copies)/i;
const CREATED_RE = /^(created|inserted|opened|started|issued)(_at|_on|_time)?$/i;
const UPDATED_RE = /^(updated|modified|closed|finished|ended|completed|resolved)(_at|_on|_time)?$/i;

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

/** 시스템이 선언했지만 강제하지 않는 규칙 + 참조/유일성 */
export function mineSchemaInvariants(schema: SystemSchema): Invariant[] {
  const out: Invariant[] = [];
  for (const c of schema.constraints) {
    if (c.enforced) continue; // DB가 이미 강제하는 규칙은 위반될 수 없다
    out.push({
      id: `schema_${slug(c.collection)}_${slug(describeExpr(c.expr))}`,
      collection: c.collection,
      title: c.description,
      expr: c.expr,
      anomaly: 'glitch',
      source: 'schema',
      status: 'confirmed',
      severity: 'warning',
    });
  }
  for (const col of schema.collections) {
    for (const f of col.fields) {
      if (f.ref && !f.refEnforced) {
        out.push({
          id: `ref_${slug(col.name)}_${slug(f.name)}`,
          collection: col.name,
          title: `${col.name}.${f.name} 가 가리키는 ${f.ref.collection} 가 존재해야 함`,
          expr: { op: 'refExists', field: f.name, collection: f.ref.collection, target: f.ref.field },
          anomaly: 'orphan',
          source: 'schema',
          status: 'proposed',
          severity: 'warning',
        });
      }
    }
    if (schema.source !== 'postgres') {
      out.push({
        id: `unique_${slug(col.name)}_${slug(col.primaryKey)}`,
        collection: col.name,
        title: `${col.name} 의 ${col.primaryKey} 는 유일해야 함`,
        expr: { op: 'unique', field: col.primaryKey },
        anomaly: 'doppelganger',
        source: 'schema',
        status: 'confirmed',
        severity: 'critical',
      });
    }
  }
  return out;
}

/** 이름 의미론으로 추정한 법칙(사용자 확인 전까지 '추정' 상태) */
export function mineHeuristicInvariants(schema: SystemSchema): Invariant[] {
  const out: Invariant[] = [];
  for (const col of schema.collections) {
    for (const f of col.fields) {
      if ((f.type === 'integer' || f.type === 'number') && !f.ref && f.name !== col.primaryKey && NON_NEGATIVE_RE.test(f.name)) {
        const enforced = schema.constraints.some(
          (c) => c.enforced && c.collection === col.name && fieldsOfExpr(c.expr).includes(f.name),
        );
        if (enforced) continue;
        out.push({
          id: `nonneg_${slug(col.name)}_${slug(f.name)}`,
          collection: col.name,
          title: `${f.name} 는 음수가 될 수 없다`,
          expr: { op: 'cmp', field: f.name, cmp: '>=', value: 0 },
          anomaly: 'glitch',
          source: 'heuristic',
          status: 'proposed',
          severity: CRITICAL_RE.test(f.name) ? 'critical' : 'warning',
        });
      }
    }
    const created = col.fields.find((f) => f.type === 'timestamp' && CREATED_RE.test(f.name));
    const updated = col.fields.find((f) => f.type === 'timestamp' && UPDATED_RE.test(f.name));
    if (created && updated) {
      out.push({
        id: `order_${slug(col.name)}_${slug(created.name)}_${slug(updated.name)}`,
        collection: col.name,
        title: `${updated.name} 는 ${created.name} 보다 이전일 수 없다`,
        expr: { op: 'cmpField', field: created.name, cmp: '<=', other: updated.name },
        anomaly: 'timewarp',
        source: 'heuristic',
        status: 'proposed',
        severity: 'warning',
      });
    }
  }
  return out;
}

/**
 * 동적 불변식 학습(Daikon류): 관측된 값의 규칙성을 법칙 후보로 제안한다.
 * 현재는 '한 번도 음수가 된 적 없는 수치 필드 ≥ 0' 을 학습한다.
 */
export class DynamicInvariantLearner {
  private stats = new Map<string, { min: number; n: number; distinct: Set<number> }>();
  private observations = 0;

  constructor(private schema: SystemSchema, private minObservations = 20, private minDistinct = 4) {}

  observe(snapshot: Snapshot): void {
    this.observations++;
    for (const col of this.schema.collections) {
      for (const f of col.fields) {
        if ((f.type !== 'integer' && f.type !== 'number') || f.ref || f.name === col.primaryKey) continue;
        const key = `${col.name}.${f.name}`;
        const s = this.stats.get(key) ?? { min: Infinity, n: 0, distinct: new Set<number>() };
        for (const r of snapshot.collections[col.name] ?? []) {
          const v = r[f.name];
          if (typeof v !== 'number') continue;
          s.min = Math.min(s.min, v);
          s.n++;
          if (s.distinct.size < 64) s.distinct.add(v);
        }
        this.stats.set(key, s);
      }
    }
  }

  propose(existing: Invariant[]): Invariant[] {
    if (this.observations < this.minObservations) return [];
    const out: Invariant[] = [];
    for (const [key, s] of this.stats) {
      if (s.min < 0 || s.n === 0 || s.distinct.size < this.minDistinct) continue;
      const [collection, field] = key.split('.');
      const covered =
        existing.some((i) => i.collection === collection && i.expr.op === 'cmp' && i.expr.field === field && (i.expr.cmp === '>=' || i.expr.cmp === '>')) ||
        // DB 가 이미 강제하는 규칙은 위반될 수 없으므로 제안하지 않는다
        this.schema.constraints.some((c) => c.enforced && c.collection === collection && fieldsOfExpr(c.expr).includes(field));
      if (covered) continue;
      out.push({
        id: `dyn_nonneg_${slug(collection)}_${slug(field)}`,
        collection,
        title: `${field} 는 관측 이래 음수가 된 적 없음(학습된 법칙)`,
        expr: { op: 'cmp', field, cmp: '>=', value: 0 },
        anomaly: 'glitch',
        source: 'dynamic',
        status: 'proposed',
        severity: 'info',
      });
    }
    return out;
  }
}

/** 불변식이 세계에서 어떤 이상 현상으로 보일지 결정한다. */
export function chooseAnomaly(inv: Invariant, grammar: WorldGrammar, schema: SystemSchema): AnomalyKind {
  const e: Expr = inv.expr;
  switch (e.op) {
    case 'refExists':
      return 'orphan';
    case 'unique':
      return 'doppelganger';
    case 'cmpField': {
      const f = findField(schema, inv.collection, e.field);
      return f?.type === 'timestamp' ? 'timewarp' : 'glitch';
    }
    case 'in':
      return 'levitate';
    case 'cmp': {
      const stacked = grammar.kinds.some(
        (k) => k.collection === inv.collection && k.channels.some((b) => isQuant(b) && b.channel === 'stack' && b.field === e.field),
      );
      return stacked ? 'ghost' : 'glitch';
    }
    default:
      return 'glitch';
  }
}
