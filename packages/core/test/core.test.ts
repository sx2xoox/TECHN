import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  applyEvents,
  buildLegend,
  diagnose,
  diffSnapshots,
  DynamicInvariantLearner,
  findCauses,
  invertCommands,
  maskRow,
  mineHeuristicInvariants,
  mineSchemaInvariants,
  observe,
  planAffordance,
  project,
  put,
  snapshotArbitrary,
  verifyGrammar,
  type ChangeEvent,
  type WorldGrammar,
} from '../src/index.ts';
import { NOW, shopGrammar, shopSchema, shopSnapshot } from './fixtures.ts';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('lens.get (project)', () => {
  it('maps rows to entities with channels', () => {
    const ents = project(shopSnapshot(), shopGrammar, shopSchema);
    const apple = ents.find((e) => e.id === 'warehouse:1')!;
    expect(apple.label).toBe('사과');
    expect(apple.visual.stack).toBe(1); // 7 / 5 = 1.4 → 1
    expect(apple.visual.lit).toBe(true);
    expect(apple.visual.sign).toBe('₩1,200');
    const merchants = ents.filter((e) => e.kind === 'merchant');
    // 주문 11 은 60초보다 오래돼서 최근성 필터로 사라진다
    expect(merchants.map((m) => m.id).sort()).toEqual(['merchant:10', 'merchant:12']);
    const m10 = merchants.find((m) => m.id === 'merchant:10')!;
    expect(m10.links).toEqual([
      { role: 'from', target: 'house:1', missing: false },
      { role: 'to', target: 'warehouse:1', missing: false },
    ]);
    const m12 = merchants.find((m) => m.id === 'merchant:12')!;
    expect(m12.links[1]).toEqual({ role: 'to', target: 'warehouse:99', missing: true });
    const hall = ents.find((e) => e.kind === 'townhall')!;
    expect(hall.visual).toMatchObject({ crowd: 6, fire: 1, speed: 0.8 });
  });

  it('never silently clamps out-of-range values', () => {
    const ents = project(shopSnapshot({ stock: -3 }), shopGrammar, shopSchema);
    const apple = ents.find((e) => e.id === 'warehouse:1')!;
    expect(apple.visual.stack).toBe(-1);
    expect(apple.outOfRange).toContain('stack');
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(snapshotArbitrary(shopSchema), (s) => {
        expect(project(s, shopGrammar, shopSchema)).toEqual(project(s, shopGrammar, shopSchema));
      }),
      { numRuns: 50 },
    );
  });
});

describe('lens.put', () => {
  it('turns a world edit into an update command and back', () => {
    const s = shopSnapshot();
    const r = put(s, shopGrammar, shopSchema, { entityId: 'warehouse:1', edits: [{ channel: 'lit', value: false }] });
    expect(r).toEqual({ ok: true, commands: [{ op: 'update', collection: 'products', pk: 1, patch: { active: false }, before: { active: true } }] });
    if (!r.ok) return;
    const s2 = applyCommands(s, r.commands, shopSchema);
    expect(project(s2, shopGrammar, shopSchema).find((e) => e.id === 'warehouse:1')!.visual.lit).toBe(false);
    const s3 = applyCommands(s2, invertCommands(r.commands), shopSchema);
    expect(s3.collections.products).toEqual(s.collections.products);
  });

  it('GetPut: editing to the current value produces no command', () => {
    const s = shopSnapshot();
    const r = put(s, shopGrammar, shopSchema, { entityId: 'warehouse:1', edits: [{ channel: 'stack', value: 1 }] });
    expect(r).toEqual({ ok: true, commands: [] });
  });

  it('refuses read-only and unknown channels', () => {
    const s = shopSnapshot();
    expect(put(s, shopGrammar, shopSchema, { entityId: 'house:1', edits: [{ channel: 'tint', value: 'gray' }] }).ok).toBe(false);
    expect(put(s, shopGrammar, shopSchema, { entityId: 'house:1', edits: [{ channel: 'lit', value: true }] }).ok).toBe(false);
    expect(put(s, shopGrammar, shopSchema, { entityId: 'nope:1', edits: [{ channel: 'lit', value: true }] }).ok).toBe(false);
  });

  it('plans affordances (relative and absolute)', () => {
    const s = shopSnapshot();
    const restock = planAffordance(s, shopGrammar, shopSchema, 'warehouse:1', 'restock');
    expect(restock.ok && restock.commands[0].patch).toEqual({ stock: 15 });
    const cancel = planAffordance(s, shopGrammar, shopSchema, 'merchant:10', 'cancel');
    expect(cancel.ok && cancel.commands[0].patch).toEqual({ status: 'cancelled' });
    expect(planAffordance(s, shopGrammar, shopSchema, 'house:1', 'lock').ok).toBe(false);
  });
});

describe('verifier (Verified Lens)', () => {
  it('accepts a lawful grammar', () => {
    const r = verifyGrammar(shopGrammar, shopSchema, { numRuns: 80 });
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.length).toBeGreaterThanOrEqual(6);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.fidelity.score).toBeGreaterThanOrEqual(90);
  });

  it('finds a PutGet counter-example when quantization cannot round-trip', () => {
    const g = clone(shopGrammar) as WorldGrammar;
    const b = g.kinds[0].channels[0];
    if (b.channel === 'stack') b.scale = { domain: [0, 3], range: [0, 10] }; // 상자 1개 = 0.3개 → 정수 재고로 되돌릴 수 없음
    const r = verifyGrammar(g, shopSchema, { numRuns: 80 });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'PUTGET');
    expect(issue?.message).toContain('양자화');
    expect(issue?.counterexample).toBeTruthy();
  });

  it('rejects non-injective colors, privacy leaks and type mismatches', () => {
    const g = clone(shopGrammar) as WorldGrammar;
    g.kinds[2].channels[0] = { channel: 'tint', field: 'status', map: { pending: 'yellow', paid: 'yellow' }, fallback: 'purple' };
    g.kinds[1].channels.push({ channel: 'sign', field: 'email', format: 'plain' });
    g.kinds[0].channels.push({ channel: 'crowd', field: 'name', scale: { domain: [0, 1], range: [0, 1] } });
    const codes = verifyGrammar(g, shopSchema, { numRuns: 20 }).issues.map((i) => i.code);
    expect(codes).toContain('NON_INJECTIVE');
    expect(codes).toContain('PRIVACY_LEAK');
    expect(codes).toContain('TYPE_MISMATCH');
  });

  it('catches entities that vanish after an edit (filter depends on edited field)', () => {
    const g = clone(shopGrammar) as WorldGrammar;
    g.kinds[2].filter = { op: 'in', field: 'status', values: ['pending'] };
    const r = verifyGrammar(g, shopSchema, { numRuns: 80 });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('사라짐'))).toBe(true);
  });

  it('reports structure errors from the schema parser', () => {
    const r = verifyGrammar({ version: 2 }, shopSchema);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe('SCHEMA');
  });

  it('warns about unaccounted fields and lowers fidelity', () => {
    const g = clone(shopGrammar) as WorldGrammar;
    g.kinds[1].hidden = [];
    const r = verifyGrammar(g, shopSchema, { numRuns: 20 });
    expect(r.issues.filter((i) => i.code === 'UNACCOUNTED_FIELD').length).toBe(2);
    expect(r.fidelity.accounted).toBeLessThan(1);
  });
});

describe('invariant physics', () => {
  it('turns a negative stock into a ghost anomaly on the warehouse', () => {
    const w = observe(shopSnapshot({ stock: -2 }), shopGrammar, shopSchema);
    const apple = w.entities.find((e) => e.id === 'warehouse:1')!;
    expect(apple.anomalies).toEqual([
      { invariantId: 'stock_nonneg', kind: 'ghost', message: '재고는 음수가 될 수 없다', proposed: true, severity: 'critical' },
    ]);
    // 존재하지 않는 상품을 가리키는 주문은 길을 잃는다
    const orphan = w.entities.find((e) => e.id === 'merchant:12')!;
    expect(orphan.anomalies.map((a) => a.kind)).toContain('orphan');
  });

  it('mines heuristic and schema invariants', () => {
    const h = mineHeuristicInvariants(shopSchema);
    expect(h.map((i) => i.id)).toEqual(expect.arrayContaining(['nonneg_products_stock', 'nonneg_products_price', 'nonneg_orders_quantity', 'order_orders_created_at_updated_at']));
    const s = mineSchemaInvariants(shopSchema);
    // DB가 강제하지 않는 참조(product_id)만 제안
    expect(s.map((i) => i.id)).toEqual(['ref_orders_product_id']);
  });

  it('learns dynamic invariants from observation', () => {
    const learner = new DynamicInvariantLearner(shopSchema, 5, 3);
    for (let i = 0; i < 6; i++) {
      const s = shopSnapshot({ stock: 5 + i });
      s.collections.shop_stats[0].error_count = i;
      learner.observe(s);
    }
    const proposals = learner.propose([]);
    expect(proposals.map((p) => p.id)).toContain('dyn_nonneg_products_stock');
  });
});

describe('event log', () => {
  it('replaying a diff reproduces the next snapshot', () => {
    fc.assert(
      fc.property(snapshotArbitrary(shopSchema), snapshotArbitrary(shopSchema), (a, b) => {
        const b2 = { ...b, ts: a.ts + 1000 };
        const restored = applyEvents(a, diffSnapshots(a, b2, shopSchema), shopSchema);
        for (const c of shopSchema.collections) {
          const sort = (rows: unknown[]) => [...rows].map((r) => JSON.stringify(r)).sort();
          expect(sort(restored.collections[c.name])).toEqual(sort(b2.collections[c.name] ?? []));
        }
      }),
      { numRuns: 60 },
    );
  });

  it('diagnoses a check-then-act race from concurrent orders', () => {
    const t = NOW;
    const iso = (x: number) => new Date(x).toISOString();
    const events: ChangeEvent[] = [
      { ts: t, collection: 'orders', pk: 20, kind: 'insert', before: null, after: { id: 20, product_id: 1, customer_id: 1, status: 'pending', created_at: iso(t - 400), updated_at: iso(t - 400) } },
      { ts: t, collection: 'orders', pk: 21, kind: 'insert', before: null, after: { id: 21, product_id: 1, customer_id: 2, status: 'pending', created_at: iso(t - 380), updated_at: iso(t - 380) } },
      { ts: t + 500, collection: 'products', pk: 1, kind: 'update', before: { id: 1, stock: 1 }, after: { id: 1, stock: -1 } },
    ];
    const v = observe(shopSnapshot({ stock: -1 }), shopGrammar, shopSchema).violations.find((x) => x.invariantId === 'stock_nonneg')!;
    const causes = findCauses(v, events, shopSchema);
    expect(causes.map((c) => c.relation)).toEqual(['referencing', 'referencing', 'self']);
    const d = diagnose(v, shopGrammar.invariants[0], causes);
    expect(d.pattern).toBe('race');
    expect(d.confidence).toBe('high');
    expect(d.detail).toContain('20ms');
  });
});

describe('honest legend', () => {
  it('explains every binding and masks sensitive fields', () => {
    const legend = buildLegend(shopGrammar, shopSchema);
    const wh = legend.find((l) => l.kind === 'warehouse')!;
    expect(wh.lines[0]).toContain('상자 1개 ≈ 5개');
    expect(wh.lines[1]).toContain('불 켜짐');
    const masked = maskRow({ id: 1, email: 'minsu@example.com' }, shopSchema.collections[0]);
    expect(masked.email).toBe('m•••m');
  });
});
