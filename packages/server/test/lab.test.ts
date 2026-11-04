import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PostgresAdapter } from '@isomorph/adapters';
import type { Hypothesis, ServerMessage } from '@isomorph/core';
import { cloneDb, runTrial, startShop, type ShopHandle } from '@isomorph/demo-shop';
import { IsomorphRuntime, serve } from '../src/index.ts';

/**
 * 가설 실험실 통합 검증: 데모 쇼핑몰을 관측해 규칙을 배우고,
 * 모델의 예측을 '복제한 DB + 진짜 쇼핑몰 코드' 의 결과와 비교한다.
 */
const orderEveryMs: [number, number] = [150, 400];
let shop: ShopHandle;
let rt: IsomorphRuntime;

beforeAll(async () => {
  shop = await startShop({ httpPort: 0, pgPort: 59200 + Math.floor(Math.random() * 300), traffic: { orderEveryMs, firstFlashSaleMs: 2500, flashSaleEveryMs: 6000 } });
  rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop', changeFeed: 'log', feedMs: 50 }), pollMs: 1000, numRuns: 30, compile: { mode: 'heuristic' } });
  expect(await rt.start()).toBe('running');
  const gap = () => new Promise((r) => setTimeout(r, 200));
  // 드문 상황의 근거를 우연에 맡기지 않는다: 판매 중지·재고 0 상황에서 진짜 쇼핑몰 코드로 주문을 몇 건 넣는다
  setTimeout(async () => {
    await shop.db.query('update products set active = false where id = 5');
    for (let i = 0; i < 3; i++) await gap().then(() => shop.shop.placeOrder(1, 5));
  }, 5000);
  setTimeout(() => void shop.db.query('update products set active = true where id = 5'), 14000);
  setTimeout(async () => {
    await shop.db.query('update products set stock = 0 where id = 6');
    for (let i = 0; i < 3; i++) await gap().then(() => shop.shop.placeOrder(2, 6));
  }, 9000);
  await new Promise((r) => setTimeout(r, 20_000));
  shop.traffic.stop();
  await new Promise((r) => setTimeout(r, 1500));
  await rt.refresh();
}, 60_000);

afterAll(async () => {
  await rt?.stop();
  await shop?.stop();
});

describe('hypothesis lab on the demo shop', () => {
  it('learns the real rules of the shop from its event history', () => {
    const { model, hypotheses } = rt.lab();
    expect(model.gates.map((g) => `${g.target}.${g.field}->${g.outcome.value}`)).toEqual(expect.arrayContaining(['products.stock->failed', 'products.active->rejected']));
    expect(model.effects).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'orders', target: 'products', field: 'stock', delta: -1, onStatus: { field: 'status', value: 'paid' } })]));
    expect(model.transitions.find((t) => t.from === 'pending' && t.to === 'paid')!.prob).toBeGreaterThan(0.8);
    expect(hypotheses.map((h) => h.id)).toEqual(expect.arrayContaining(['baseline', 'traffic3_orders']));
    expect(hypotheses.some((h) => h.id.startsWith('flash_fixed_'))).toBe(true);
  });

  it('agrees with the real code on flash sale, the atomic fix and stopping sales', async () => {
    const { hypotheses } = rt.lab();
    const dump = await cloneDb(shop.db);
    const pick = (prefix: string) => ({ ...hypotheses.find((h) => h.id.startsWith(prefix))!, horizonMs: 8000 }) as Hypothesis;
    const cases = [pick('flash_products_'), pick('flash_fixed_'), pick('stopall_')];
    for (const h of cases) {
      const predicted = (await rt.simulate(h)).laws.find((l) => l.invariantId === 'nonneg_products_stock')!.probability;
      const trials = await Promise.all([0, 1, 2].map(() => runTrial(dump, h, { orderEveryMs })));
      const observed = trials.filter((t) => t.newViolation).length / trials.length;
      if (h.id.startsWith('flash_products_')) {
        expect(predicted).toBeGreaterThan(0.5);
        expect(observed).toBeGreaterThan(0.5);
      } else {
        expect(predicted).toBe(0);
        expect(observed).toBe(0);
      }
    }
  }, 120_000);

  it('serves the lab over WebSocket with progress and a playable future', async () => {
    const srv = await serve(rt, { port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const got: ServerMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as ServerMessage;
        got.push(m);
        if (m.type === 'hello') ws.send(JSON.stringify({ type: 'lab' }));
        if (m.type === 'lab') {
          const h = m.hypotheses.find((x) => x.id.startsWith('flash_products_'))!;
          ws.send(JSON.stringify({ type: 'simulate', hypothesis: { ...h, horizonMs: 6000, changes: [...h.changes, { kind: 'rate', collection: 'orders', factor: 999 }] } }));
        }
        if (m.type === 'simulation') resolve();
      });
      ws.on('error', reject);
    });
    expect(got.some((m) => m.type === 'simulation-progress')).toBe(true);
    const sim = got.find((m) => m.type === 'simulation');
    if (sim?.type !== 'simulation') throw new Error('no simulation');
    // 서버가 위험한 값을 잘라낸다(배수 999 → 20)
    expect(sim.result.hypothesis.changes.find((c) => c.kind === 'rate')).toMatchObject({ factor: 20 });
    expect(sim.result.frames.length).toBeGreaterThan(10);
    expect(sim.result.frames[0].world.entities.length).toBeGreaterThan(5);
    ws.close();
    await srv.close();
  }, 60_000);
});
