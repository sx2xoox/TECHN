import { PostgresAdapter } from '@isomorph/adapters';
import { startShop } from '@isomorph/demo-shop';
import { IsomorphRuntime } from '@isomorph/server';
import type { WorldState } from '@isomorph/core';

/** KPI: 시스템 상태 변화 → 세계 반영 지연(관측 주기 500ms, 트래픽 켜짐) */
const shop = await startShop({ httpPort: 0, pgPort: 58000 + Math.floor(Math.random() * 900), traffic: { firstFlashSaleMs: -1, flashSaleEveryMs: 0 } });
const rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop' }), pollMs: 500, numRuns: 50, compile: { mode: 'heuristic' } });
await rt.start();
const samples: number[] = [];
for (let i = 0; i < 20; i++) {
  const target = i % 2 === 0;
  const t0 = performance.now();
  await shop.db.query('update products set active = $1 where id = 2', [!target ? true : false]);
  const want = !target;
  await new Promise<void>((resolve) => {
    const on = (w: WorldState) => {
      if (w.entities.find((e) => e.id === 'products:2')?.visual.lit === want) {
        rt.off('world', on);
        resolve();
      }
    };
    rt.on('world', on);
  });
  samples.push(performance.now() - t0);
  await new Promise((r) => setTimeout(r, 137));
}
samples.sort((a, b) => a - b);
const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].toFixed(0);
console.log(`상태→세계 반영 지연 (n=${samples.length}, poll 500ms): 중앙값 ${p(0.5)}ms · p95 ${p(0.95)}ms · 최대 ${samples.at(-1)!.toFixed(0)}ms`);
await rt.stop();
await shop.stop();
process.exit(0);
