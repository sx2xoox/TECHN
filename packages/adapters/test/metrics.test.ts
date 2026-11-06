import { describe, expect, it } from 'vitest';
import { MetricsAdapter } from '../src/index.ts';

/**
 * 지표 어댑터: 서비스 지표(Prometheus 등)를 평소와 견주는 법칙으로.
 * 공개 벤치마크(RCAEval)의 Online Boutique 지표로 정한 규칙들의 회귀 시험(재생 시계, 네트워크 없음).
 */
async function run(a: MetricsAdapter, clock: { t: number }, series: (t: number) => Record<string, Record<string, number>>, from: number, to: number) {
  const rows: Record<string, unknown>[][] = [];
  for (let t = from; t <= to; t += 15_000) {
    clock.t = t;
    a.ingest(series(t));
    rows.push((await a.snapshot()).collections.services);
  }
  return rows;
}
const over = (r: Record<string, unknown>, m: string) => r[`${m}_limit`] !== null && (r[m] as number) > (r[`${m}_limit`] as number);

describe('metrics adapter (learned limits)', () => {
  it('makes a law per "higher is worse" metric and leaves throughput alone', async () => {
    const a = new MetricsAdapter({ now: () => 0 });
    a.ingest({ carts: { cpu: 0.2, latency_90: 12, workload: 300 } });
    const s = await a.introspect();
    expect(s.constraints.map((c) => (c.expr as { field: string }).field).sort()).toEqual(['cpu', 'latency_90']);
    expect(s.collections[0].fields.map((f) => f.name)).toEqual(expect.arrayContaining(['cpu', 'cpu_limit', 'latency_90', 'latency_90_limit', 'workload']));
  });

  it('catches a fault that ramps up gradually (the limit does not follow it)', async () => {
    const clock = { t: 0 };
    const a = new MetricsAdapter({ now: () => clock.t });
    const start = 1_000_000;
    const fault = start + 10 * 60_000;
    const rows = await run(a, clock, (t) => ({ checkout: { cpu: t < fault ? 0.45 + ((t / 15_000) % 3) * 0.01 : 0.45 + ((t - fault) / 15_000) * 0.4 } }), start, fault + 3 * 60_000);
    const firstOver = rows.findIndex((r) => over(r[0], 'cpu'));
    expect(firstOver).toBeGreaterThan(0);
    expect(start + firstOver * 15_000).toBeGreaterThanOrEqual(fault); // 평상시에는 넘지 않는다
    expect(start + firstOver * 15_000).toBeLessThanOrEqual(fault + 90_000); // 오르기 시작하고 1분 반 안에
  });

  it('learns a recurring burst that resolves by itself, so it alarms at most once', async () => {
    const clock = { t: 0 };
    const a = new MetricsAdapter({ now: () => clock.t });
    const start = 2_000_000;
    // 4분마다 45초 동안 디스크를 몰아 쓴다(데이터베이스의 주기적 저장)
    const burst = (t: number) => ((t - start) % 240_000) >= 120_000 && ((t - start) % 240_000) < 165_000;
    const rows = await run(a, clock, (t) => ({ redis: { diskio: burst(t) ? 40_000 : 500 } }), start, start + 20 * 60_000);
    const starts = rows.filter((r, i) => over(r[0], 'diskio') && !(i > 0 && over(rows[i - 1][0], 'diskio'))).length;
    expect(starts).toBeLessThanOrEqual(1);
  });

  it('a single spike does not break the law (sustained over two observations)', async () => {
    const clock = { t: 0 };
    const a = new MetricsAdapter({ now: () => clock.t });
    const start = 3_000_000;
    const spike = start + 5 * 60_000;
    const rows = await run(a, clock, (t) => ({ user: { latency_90: t === spike ? 900 : 20 } }), start, start + 7 * 60_000);
    expect(rows.some((r) => over(r[0], 'latency_90'))).toBe(false);
  });

  it('asks Prometheus for an instant vector per metric', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      asked.push(decodeURIComponent(url.split('query=')[1]));
      expect(init.headers.authorization).toBe('Bearer t0k');
      return new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: { app: 'carts' }, value: [0, '0.25'] }, { metric: { app: 'orders' }, value: [0, '0.5'] }] } }));
    }) as unknown as typeof fetch;
    const a = new MetricsAdapter({ url: 'http://prom:9090', by: 'app', token: 't0k', queries: { cpu: 'sum by (app) (rate(container_cpu_usage_seconds_total[1m]))' }, fetchImpl });
    await a.connect();
    const rows = (await a.snapshot()).collections.services;
    expect(asked[0]).toContain('container_cpu_usage_seconds_total');
    expect(rows.map((r) => [r.id, r.cpu])).toEqual([['carts', 0.25], ['orders', 0.5]]);
  });
});
