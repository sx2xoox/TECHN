import { PostgresAdapter } from '@isomorph/adapters';
import { learnModel, simulate, suggestHypotheses, type Hypothesis } from '@isomorph/core';
import { cloneDb, runTrial, startShop } from '@isomorph/demo-shop';
import { IsomorphRuntime } from '@isomorph/server';

/**
 * 가설 실험실 검증: 학습된 모델의 예측 vs 실제 코드 샌드박스(복제 DB)에서의 관측
 *   npm run bench:lab
 * 쇼핑몰을 30초 관측해 규칙을 배우고, 가설마다 모델 200회 · 실제 코드 TRIALS 회를 돌려 비교한다.
 */
const TRIALS = Number(process.env.TRIALS ?? 8);
const HORIZON = Number(process.env.HORIZON ?? 20_000);
const orderEveryMs: [number, number] = [150, 400];

const shop = await startShop({ httpPort: 0, pgPort: 0, traffic: { orderEveryMs, firstFlashSaleMs: 3000, flashSaleEveryMs: 9000 } });
const rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop', changeFeed: 'log', feedMs: 50 }), pollMs: 1000, numRuns: 40, compile: { mode: 'heuristic' } });
await rt.start();
setTimeout(() => void shop.db.query('update products set active = false where id = 5'), 8000);
setTimeout(() => void shop.db.query('update products set active = true where id = 5'), 20000);
console.log('쇼핑몰을 30초 관측하며 규칙을 배우는 중…');
await new Promise((r) => setTimeout(r, 30_000));
shop.traffic.stop();
await new Promise((r) => setTimeout(r, 1500)); // 진행 중 결제 마무리
await rt.refresh();
const base = rt.lastSnapshot!;
const range = rt.store.range()!;
const model = learnModel(rt.store.snapshotAt(range.start, rt.schema)!, rt.store.eventsBetween(range.start, range.end), rt.schema);
console.log(`\n학습한 규칙:\n  ${model.rules.join('\n  ')}\n`);
const dump = await cloneDb(shop.db);

const rows: Record<string, string | number>[] = [];
for (const h0 of suggestHypotheses(model, base, rt.schema)) {
  const h: Hypothesis = { ...h0, horizonMs: Math.min(h0.horizonMs, HORIZON) };
  const sim = simulate(base, model, h, rt.grammar, rt.schema, { runs: 200 });
  const law = sim.laws.find((l) => l.invariantId === 'nonneg_products_stock');
  const trials = [];
  for (let b = 0; b < TRIALS; b += 4) trials.push(...(await Promise.all(Array.from({ length: Math.min(4, TRIALS - b) }, () => runTrial(dump, h, { orderEveryMs })))));
  const hit = trials.filter((t) => t.newViolation).length;
  const pModel = law?.probability ?? 0;
  const pReal = hit / trials.length;
  rows.push({
    가설: h.title,
    '모델 P(새 음수 재고)': pModel.toFixed(2),
    '실제 코드 관측': `${hit}/${trials.length} = ${pReal.toFixed(2)}`,
    '차이': Math.abs(pModel - pReal).toFixed(2),
    '주문 수(모델 평균)': Math.round(sim.arrivals.orders ?? 0),
    '주문 수(실제 평균)': Math.round(trials.reduce((a, t) => a + t.orders, 0) / trials.length),
  });
  console.log(`  ${h.title}: 모델 ${pModel.toFixed(2)} · 실제 ${hit}/${trials.length}`);
}
console.log(`\n시간 지평 ${HORIZON / 1000}초, 모델 200회 vs 실제 코드 ${TRIALS}회`);
console.table(rows);
await rt.stop();
await shop.stop();
process.exit(0);
