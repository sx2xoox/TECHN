import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  findRevert,
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
  simulate,
  suggestHypotheses,
  learnModel,
  assignGlyphs,
  colorDistance,
  deltaE2000Lab,
  MIN_DISTINGUISHABLE_DE,
  tintAccessibility,
  type ChangeEvent,
  type Hypothesis,
  type SystemModel,
  type WorldGrammar,
} from '../src/index.ts';
import { NOW, shopGrammar, shopSchema, shopSnapshot } from './fixtures.ts';
import { compileHeuristic } from '../../compiler/src/index.ts';

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
    expect(restock.ok && restock.commands[0].patch).toEqual({ stock: 17 }); // 7 + 2상자×5
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

describe('colour-blind accessibility', () => {
  it('finds the change that preceded a violation, and only offers to revert what is safe to revert', () => {
    const schema = {
      system: 'k',
      source: 'custom' as const,
      constraints: [],
      collections: [
        {
          name: 'deployments',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string' as const, nullable: false },
            { name: 'replicas', type: 'integer' as const, nullable: false },
            { name: 'ready', type: 'integer' as const, nullable: false },
            { name: 'image', type: 'string' as const, nullable: true },
            { name: 'note', type: 'string' as const, nullable: true, readOnly: true },
          ],
        },
      ],
    };
    const inv = { id: 'r', collection: 'deployments', title: '준비 ≥ 원함', expr: { op: 'cmpField' as const, field: 'ready', cmp: '>=' as const, other: 'replicas' }, anomaly: 'glitch' as const, source: 'schema' as const, status: 'confirmed' as const, severity: 'warning' as const };
    const v = { invariantId: 'r', collection: 'deployments', pk: 'web', title: 't', kind: 'glitch', severity: 'warning', proposed: false, values: {} } as never;
    const row0 = { id: 'web', replicas: 2, ready: 2, image: 'app:1', note: 'a' };
    const row1 = { ...row0, image: 'app:2', note: 'b' }; // 배포(이미지 바뀜) — 아직 법칙은 지켜진다
    const row2 = { ...row1, ready: 0 }; // 그 뒤 파드가 준비를 잃음 → 위반 시작
    const ev = [
      { ts: 1000, collection: 'deployments', pk: 'web', kind: 'update' as const, before: row0, after: row1 },
      { ts: 2000, collection: 'deployments', pk: 'web', kind: 'update' as const, before: row1, after: row2 },
    ];
    expect(findRevert(v, ev, schema, inv, row2)).toEqual({ at: 1000, changes: [{ field: 'image', now: 'app:2', to: 'app:1' }] }); // 읽기 전용(note)과 법칙의 필드는 빼고
    expect(findRevert(v, ev, schema, inv, { ...row2, image: 'app:3' })).toBeNull(); // 그 뒤로 다시 바뀌었으면 덮어쓰지 않는다
    expect(findRevert(v, [ev[1]], { ...schema }, inv, row2)).toBeNull(); // 위반 전의 변경이 관측되지 않았으면 안을 내지 않는다
    expect(findRevert(v, ev.map((e) => ({ ...e, ts: e.ts + (e.ts === 1000 ? -60 * 60_000 : 0) })), schema, inv, row2)).toBeNull(); // 너무 오래된 변경은 원인으로 보지 않는다
  });

  it('tells a timestamp order problem from a gap between two quantities', () => {
    const inv = (field: string, other: string) => ({ id: 'x', collection: 'c', title: 't', expr: { op: 'cmpField' as const, field, cmp: '>=' as const, other }, anomaly: 'glitch' as const, source: 'schema' as const, status: 'confirmed' as const, severity: 'warning' as const });
    const v = (values: Record<string, unknown>) => ({ invariantId: 'x', collection: 'c', pk: 1, kind: 'glitch', severity: 'warning', title: 't', values }) as never;
    expect(diagnose(v({ closed_at: '2026-01-01T00:00:00Z', opened_at: '2026-01-02T00:00:00Z' }), inv('closed_at', 'opened_at'), []).pattern).toBe('time-order');
    expect(diagnose(v({ ready: 1, wanted: 3 }), inv('ready', 'wanted'), []).pattern).toBe('mismatch');
  });

  it('computes CIEDE2000 like the published reference data (Sharma, Wu & Dalal 2005)', () => {
    const cases: [[number, number, number], [number, number, number], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    ];
    for (const [a, b, want] of cases) expect(deltaE2000Lab(a, b)).toBeCloseTo(want, 3);
  });

  it('chooses status colours that stay apart for colour-blind viewers, and gives each value a shape', () => {
    const b = compileHeuristic(shopSchema).kinds.find((k) => k.collection === 'orders')!.channels.find((c) => c.channel === 'tint')!;
    if (b.channel !== 'tint' || !('map' in b)) throw new Error('no tint');
    expect(b.glyphs).toMatchObject({ pending: 'hourglass', paid: 'check', failed: 'cross' });
    const a = tintAccessibility(b);
    expect(a.ok && a.byGlyph).toBe(true);
    for (const v of ['protan', 'deutan', 'tritan'] as const) expect(colorDistance(b.map.paid, b.map.failed, v)).toBeGreaterThanOrEqual(MIN_DISTINGUISHABLE_DE);
  });

  it('warns when colours collide for colour-blind viewers and nothing else tells them apart', () => {
    const g = structuredClone(shopGrammar);
    const kind = g.kinds.find((k) => k.channels.some((c) => c.channel === 'tint'))!;
    const tint = kind.channels.find((c) => c.channel === 'tint')!;
    const confusable = (r: ReturnType<typeof verifyGrammar>) => r.issues.some((i) => i.code === 'CVD_CONFUSABLE' && i.kind === kind.id);
    if (tint.channel !== 'tint' || !('map' in tint)) throw new Error('no tint');
    const [v1, v2] = Object.keys(tint.map);
    tint.map[v1] = 'teal';
    tint.map[v2] = 'pink'; // 녹색맹에게 거의 같은 색(ΔE 0.3)
    delete tint.glyphs;
    expect(confusable(verifyGrammar(g, shopSchema, { numRuns: 10 }))).toBe(true);
    tint.glyphs = assignGlyphs(Object.keys(tint.map));
    expect(confusable(verifyGrammar(g, shopSchema, { numRuns: 10 }))).toBe(false);
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

describe('cause analysis anchoring', () => {
  it('anchors at the violation onset, not at later fixes', () => {
    const t = NOW;
    const iso = (x: number) => new Date(x).toISOString();
    const events: ChangeEvent[] = [
      { ts: t, collection: 'orders', pk: 20, kind: 'insert', before: null, after: { id: 20, product_id: 1, status: 'pending', created_at: iso(t - 30), updated_at: iso(t - 30) } },
      { ts: t, collection: 'orders', pk: 21, kind: 'insert', before: null, after: { id: 21, product_id: 1, status: 'pending', created_at: iso(t - 10), updated_at: iso(t - 10) } },
      { ts: t + 800, collection: 'products', pk: 1, kind: 'update', before: { id: 1, stock: 1, active: true }, after: { id: 1, stock: -1, active: true } },
      // 30초 뒤 운영자가 문을 잠금 — 원인이 아니다
      { ts: t + 30_800, collection: 'products', pk: 1, kind: 'update', before: { id: 1, stock: -1, active: true }, after: { id: 1, stock: -1, active: false } },
    ];
    const v = observe(shopSnapshot({ stock: -1 }), shopGrammar, shopSchema).violations.find((x) => x.invariantId === 'stock_nonneg')!;
    const inv = shopGrammar.invariants[0];
    const causes = findCauses(v, events, shopSchema, 20_000, undefined, inv);
    expect(causes.map((c) => c.summary)).not.toContain('active: true → false');
    expect(diagnose(v, inv, causes).pattern).toBe('race');
  });
});

describe('rule learning', () => {
  it('explains away rows already explained by another rule and learns which rule wins', () => {
    // 재고 0 인 상품 1: 판매 중일 때 주문은 failed, 판매 중지 뒤의 주문은 rejected(실제 코드처럼 '판매 중지' 확인이 먼저)
    const base = shopSnapshot({ stock: 0 });
    base.collections.orders = [];
    const iso = (x: number) => new Date(x).toISOString();
    const events: ChangeEvent[] = [];
    let t = NOW + 1000;
    let id = 100;
    const order = (productId: number, status: string) => {
      const row = { id: ++id, customer_id: 1, product_id: productId, quantity: 1, status, created_at: iso(t), updated_at: iso(t) };
      events.push({ ts: t, collection: 'orders', pk: row.id, kind: 'insert', before: null, after: row });
      if (status === 'pending') events.push({ ts: t + 150, collection: 'orders', pk: row.id, kind: 'update', before: row, after: { ...row, status: 'paid' } });
      t += 300;
    };
    for (let i = 0; i < 4; i++) order(1, 'failed');
    for (let i = 0; i < 6; i++) order(2, 'pending');
    events.push({ ts: t, collection: 'products', pk: 1, kind: 'update', before: { id: 1, name: '사과', price: 1200, stock: 0, active: true }, after: { id: 1, name: '사과', price: 1200, stock: 0, active: false } });
    t += 300;
    for (let i = 0; i < 3; i++) order(1, 'rejected');
    const model = learnModel(base, events, shopSchema);
    // 단순 집계라면 재고 ≤ 0 → failed 는 4/7 = 57% 라 규칙이 되지 못한다
    const stock = model.gates.find((g) => g.field === 'stock')!;
    expect(stock).toMatchObject({ outcome: { value: 'failed' }, prob: 1, samples: 4 });
    expect(model.gates.map((g) => g.field)).toEqual(['active', 'stock']);
    expect(model.rules.find((r) => r.startsWith('products.stock'))).toContain('다른 규칙으로 설명되는 3건 제외');
  });
});

describe('hypothesis simulator', () => {
  const model: SystemModel = {
    learnedFrom: { events: 100, spanMs: 60_000, start: NOW - 60_000, end: NOW },
    rates: [{ collection: 'orders', perMinute: 0, samples: 50, targets: { product_id: { '1': 1 }, customer_id: { '1': 1 } }, template: { id: 0, customer_id: 1, product_id: 1, quantity: 1, status: 'pending', created_at: '', updated_at: '' } }],
    initialStatus: [{ collection: 'orders', field: 'status', value: 'pending' }],
    transitions: [{ collection: 'orders', field: 'status', from: 'pending', to: 'paid', prob: 1, dwellMs: 500, samples: 50 }],
    effects: [{ source: 'orders', refField: 'product_id', target: 'products', field: 'stock', delta: -1, onStatus: { field: 'status', value: 'paid' }, lagMs: 500, samples: 50 }],
    gates: [{ source: 'orders', refField: 'product_id', target: 'products', field: 'stock', when: { op: '<=', value: 0 }, outcome: { field: 'status', value: 'failed' }, prob: 1, samples: 10 }],
    replenish: [],
    frozen: [],
    rules: [],
  };
  const flash = (atomic: boolean): Hypothesis => ({
    id: 'f',
    title: 'flash',
    description: '',
    horizonMs: 5000,
    changes: [
      { kind: 'set', collection: 'products', pk: 1, patch: { stock: 2 } },
      { kind: 'burst', collection: 'orders', refField: 'product_id', target: 1, count: 4, atMs: 1000, spreadMs: 30 },
      ...(atomic ? [{ kind: 'atomic' as const, target: 'products', field: 'stock' }] : []),
    ],
  });

  it('reproduces the check-then-act race and shows that an atomic fix removes it', () => {
    const base = shopSnapshot({ stock: 7 });
    const racy = simulate(base, model, flash(false), shopGrammar, shopSchema, { runs: 20 });
    const law = racy.laws.find((l) => l.invariantId === 'stock_nonneg')!;
    expect(law.probability).toBe(1);
    expect(law.medianFirstMs).toBeGreaterThanOrEqual(1000);
    const last = racy.frames.at(-1)!.world.entities.find((e) => e.id === 'warehouse:1')!;
    expect(last.anomalies.map((a) => a.kind)).toContain('ghost');
    const fixed = simulate(base, model, flash(true), shopGrammar, shopSchema, { runs: 20 });
    expect(fixed.laws.find((l) => l.invariantId === 'stock_nonneg')!.probability).toBe(0);
  });

  it('is deterministic for a seed and ignores violations that already existed', () => {
    const base = shopSnapshot({ stock: -3 });
    const a = simulate(base, model, flash(false), shopGrammar, shopSchema, { runs: 5, seed: 1 });
    const b = simulate(base, model, flash(false), shopGrammar, shopSchema, { runs: 5, seed: 1 });
    expect(JSON.stringify(a.laws)).toBe(JSON.stringify(b.laws));
    // 가설이 손대지 않으면, 처음부터 음수였던 상품 1 은 '이미 깨짐'이지 이 가설의 결과가 아니다
    const idle = simulate(base, model, { id: 'idle', title: 'idle', description: '', horizonMs: 3000, changes: [] }, shopGrammar, shopSchema, { runs: 3 });
    const law = idle.laws.find((l) => l.invariantId === 'stock_nonneg')!;
    expect(law.preExisting).toBe(1);
    expect(law.probability).toBe(0);
  });

  it('suggests hypotheses from the learned rules', () => {
    const hs = suggestHypotheses({ ...model, rates: [{ ...model.rates[0], perMinute: 60 }] }, shopSnapshot(), shopSchema);
    expect(hs.map((h) => h.id)).toEqual(expect.arrayContaining(['baseline', 'traffic3_orders', 'flash_products_1', 'flash_fixed_products_1']));
  });
});
