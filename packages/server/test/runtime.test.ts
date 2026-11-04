import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PostgresAdapter } from '@isomorph/adapters';
import { startShop, type ShopHandle } from '@isomorph/demo-shop';
import type { ServerMessage, WorldGrammar } from '@isomorph/core';
import { EventStore, IsomorphRuntime, serve } from '../src/index.ts';

let shop: ShopHandle;
let rt: IsomorphRuntime;
const PG_PORT = 56000 + Math.floor(Math.random() * 900);

beforeAll(async () => {
  shop = await startShop({ httpPort: 0, pgPort: PG_PORT, traffic: false, shop: { paymentMs: [80, 100], paymentFailureRate: 0 } });
  rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop' }), writeMode: 'medium', pollMs: 60_000, numRuns: 40, compile: { mode: 'heuristic' } });
  expect(await rt.start()).toBe('running');
});
afterAll(async () => {
  await rt?.stop();
  await shop?.stop();
});

const productStock = async (id: number) => (await shop.db.query<{ stock: number; active: boolean }>('select stock, active from products where id = $1', [id])).rows[0];

describe('IsomorphRuntime end-to-end on the demo shop', () => {
  let beforeSale = 0;

  it('opens a verified world', () => {
    expect(rt.report.ok).toBe(true);
    const kinds = new Set(rt.world!.entities.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['customers', 'products', 'shop_stats']));
    expect(rt.world!.violations).toEqual([]);
  });

  it('shows the race as a ghost anomaly and diagnoses it', async () => {
    beforeSale = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    await shop.traffic.flashSale(3);
    const w = await rt.tick();
    const v = w!.violations.find((x) => x.invariantId === 'nonneg_products_stock');
    expect(v).toMatchObject({ collection: 'products', pk: 3, kind: 'ghost' });
    const e = w!.entities.find((x) => x.id === 'products:3')!;
    expect(e.anomalies[0].kind).toBe('ghost');
    expect(e.outOfRange).toContain('stack');
    expect(rt.timeline().markers.some((m) => m.entityIds.includes('products:3'))).toBe(true);
    const ins = rt.inspect('products:3');
    expect(ins.fields.find((f) => f.name === 'stock')).toMatchObject({ value: -2, channel: 'stack' });
    expect(ins.diagnosis?.pattern).toBe('race');
    expect(ins.causes.filter((c) => c.relation === 'referencing').length).toBeGreaterThanOrEqual(4);
  });

  it('dry-runs, approves, verifies on the real system and undoes', async () => {
    const dr = rt.dryRun('products:3', 'products_off');
    expect(dr.allowed).toBe(true);
    expect(dr.commandText[0]).toContain('UPDATE "products" SET "active" = false');
    expect(dr.preview!.visual.lit).toBe(false);
    expect((await productStock(3)).active).toBe(true); // 드라이런은 아무것도 바꾸지 않는다
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    expect((await productStock(3)).active).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    await rt.tick();
    expect(rt.getActions()[0].status).toBe('verified');
    // 잠긴 창고로 들어오는 주문은 거절된다
    const order = await shop.shop.placeOrder(1, 3);
    expect(order.status).toBe('rejected');
    const undo = await rt.undo(rec.id);
    expect(undo.status).toBe('applied');
    expect((await productStock(3)).active).toBe(true);
  });

  it('re-plans a relative edit when the system changed in between', async () => {
    const dr = rt.dryRun('products:5', 'products_restock');
    expect(dr.allowed).toBe(true);
    await shop.db.query('update products set stock = stock - 1 where id = 5'); // 미리보기 뒤에 다른 요청이 재고를 바꿈
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    expect(rec.error).toContain('다시 계획');
    const per = Number(dr.commands[0].patch.stock) - Number(dr.commands[0].before.stock);
    expect((await productStock(5)).stock).toBe(Number(dr.commands[0].before.stock) - 1 + per);
  });

  it('travels back in time to before the flash sale', () => {
    const past = rt.seek(beforeSale);
    expect(past).not.toBeNull();
    expect(past!.violations.find((v) => v.invariantId === 'nonneg_products_stock')).toBeUndefined();
    const ins = rt.inspect('products:3', beforeSale);
    expect(ins.affordances.every((a) => !a.allowed)).toBe(true);
  });

  it('serves the world over WebSocket', async () => {
    const srv = await serve(rt, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const got: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        got.push(m);
        if (m.type === 'world') ws.send(JSON.stringify({ type: 'inspect', entityId: 'products:1' }));
        if (m.type === 'inspect') resolve();
      });
      ws.on('error', reject);
    });
    expect(got.map((m) => m.type).slice(0, 2)).toEqual(['hello', 'world']);
    const hello = got[0];
    if (hello.type === 'hello') {
      expect(hello.verification.ok).toBe(true);
      expect(hello.legend.find((l) => l.collection === 'products')!.lines.join('\n')).toContain('상자 1개');
    }
    ws.close();
    await srv.close();
  });
});

describe('safety rails', () => {
  it('refuses to open a world whose lens is unlawful', async () => {
    const grammar = JSON.parse(JSON.stringify(rt.grammar)) as WorldGrammar;
    const products = grammar.kinds.find((k) => k.collection === 'products')!;
    const tint = { channel: 'tint' as const, field: 'name', map: { a: 'red' as const, b: 'red' as const }, fallback: 'gray' as const };
    products.channels.push(tint);
    const bad = new IsomorphRuntime({ adapter: new PostgresAdapter({ queryable: shop.db, system: 'demo-shop' }), grammar, numRuns: 20 });
    expect(await bad.start()).toBe('refused');
    expect(bad.report.issues.some((i) => i.code === 'NON_INJECTIVE')).toBe(true);
    await bad.stop();
  });

  it('read-only mode never plans writes', async () => {
    const ro = new IsomorphRuntime({ adapter: new PostgresAdapter({ queryable: shop.db, system: 'demo-shop' }), grammar: rt.grammar, numRuns: 20, pollMs: 60_000 });
    expect(await ro.start()).toBe('running');
    const dr = ro.dryRun('products:1', 'products_off');
    expect(dr.allowed).toBe(false);
    expect(dr.planId).toBeNull();
    expect(dr.reason).toContain('read-only');
    await ro.stop();
  });
});

describe('EventStore', () => {
  it('reconstructs any past snapshot from keyframes + events', () => {
    const store = new EventStore(':memory:', 3);
    const schema = { system: 's', source: 'custom' as const, constraints: [], collections: [{ name: 't', primaryKey: 'id', fields: [{ name: 'id', type: 'integer' as const, nullable: false }, { name: 'v', type: 'integer' as const, nullable: false }] }] };
    type Snap = { ts: number; collections: { t: { id: number; v: number }[] } };
    let prev: Snap | null = null as Snap | null;
    const history: Snap[] = [];
    for (let i = 0; i < 10; i++) {
      const snap = { ts: 1000 + i * 100, collections: { t: Array.from({ length: (i % 3) + 1 }, (_, k) => ({ id: k + 1, v: i * 10 + k })) } };
      const events = [] as Parameters<typeof store.record>[1];
      const prevRows = new Map((prev?.collections.t ?? []).map((r) => [r.id, r]));
      for (const r of snap.collections.t) {
        const o = prevRows.get(r.id);
        if (!o) events.push({ ts: snap.ts, collection: 't', pk: r.id, kind: 'insert', before: null, after: r });
        else if (o.v !== r.v) events.push({ ts: snap.ts, collection: 't', pk: r.id, kind: 'update', before: o, after: r });
        prevRows.delete(r.id);
      }
      for (const r of prevRows.values()) events.push({ ts: snap.ts, collection: 't', pk: r.id, kind: 'delete', before: r, after: null });
      store.record(snap, events);
      history.push(snap);
      prev = snap;
    }
    for (const h of history) {
      const got = store.snapshotAt(h.ts, schema)!;
      expect(got.collections.t.sort((a, b) => Number(a.id) - Number(b.id))).toEqual(h.collections.t);
    }
    expect(store.range()).toEqual({ start: 1000, end: 1900 });
    store.close();
  });
});
