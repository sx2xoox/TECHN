import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MetricsAdapter } from '@isomorph/adapters';
import { IsomorphRuntime } from '@isomorph/server';
import { norm, summarize, type CaseResult } from './replay.ts';

/**
 * RCAEval 의 서비스 지표(트레이스 없음)를 지표 어댑터로 다시 재생해 근본 원인을 맞히는지 잰다.
 *   python3 -I scripts/rcaeval/fetch.py --what metrics --suites re2ss,re1ss --out data/rcaeval
 *   npx tsx scripts/rcaeval/replay-metrics.ts --suites re2ss,re1ss [--json out.json]
 *
 * 15초마다 지난 60초의 평균(Prometheus 의 rate 창과 비슷하게)을 지표 어댑터에 넣고, 진짜 런타임을 관측시킨다.
 * 예측·거짓 경보·순위는 트레이스 재생(replay.ts)과 같다. 지표로는 서비스 사이 호출을 모르므로 사슬은 없다.
 * 단순 기준선(맥락용): 주입 뒤 5분 평균이 주입 전 5분보다 가장 크게(비율) 오른 '서비스·지표' 의 서비스(처리량 제외).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dataDir = path.resolve(arg('--data') ?? path.join(root, 'data/rcaeval'));
const suites = (arg('--suites') ?? 're2ss').split(',');
const POLL_MS = 15_000;
/** 위반이 이만큼 이어져야 장애 기록을 연다(런타임의 confirmMs) */
const CONFIRM_MS = Number(process.argv.includes('--confirm') ? process.argv[process.argv.indexOf('--confirm') + 1] : 0) * 1000;
const HORIZON_MS = 10 * 60_000;
const SKIP = /workload|time/i;

interface Metrics {
  time: number[];
  cols: Record<string, (number | null)[]>;
}

/** 열 이름 '서비스_지표' → [서비스, 지표]. 서비스 이름에 '_' 가 있을 수 있어 마지막 '_' 로 가른다 */
const split = (col: string): [string, string] => {
  const i = col.lastIndexOf('_');
  return [col.slice(0, i), col.slice(i + 1)];
};

function windowMeans(m: Metrics, from: number, to: number) {
  const out: Record<string, Record<string, number>> = {};
  const idx = m.time.map((t, i) => [t * 1000, i] as const).filter(([t]) => t > from && t <= to).map(([, i]) => i);
  for (const [col, vs] of Object.entries(m.cols)) {
    const xs = idx.map((i) => vs[i]).filter((x): x is number => x !== null && Number.isFinite(x));
    if (!xs.length) continue;
    const [svc, metric] = split(col);
    (out[svc] ??= {})[metric] = xs.reduce((a, b) => a + b, 0) / xs.length;
  }
  return out;
}

function baseline(m: Metrics, inject: number): string | null {
  const before = windowMeans(m, inject - 5 * 60_000, inject);
  const after = windowMeans(m, inject, inject + 5 * 60_000);
  let best: string | null = null;
  let bestR = 0;
  for (const [svc, ms] of Object.entries(after)) {
    for (const [k, v] of Object.entries(ms)) {
      if (SKIP.test(k)) continue;
      const b = before[svc]?.[k];
      if (b === undefined) continue;
      const r = (v + 1e-9) / (Math.abs(b) + 1e-9);
      if (r > bestR) [best, bestR] = [svc, r];
    }
  }
  return best;
}

export async function replayMetricsCase(dir: string): Promise<CaseResult> {
  const name = path.basename(dir);
  const [suite, truth, fault] = name.split('_');
  const inject = Number(fs.readFileSync(path.join(dir, 'inject_time.txt'), 'utf8').trim()) * 1000;
  const m = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'metrics.json.gz'))).toString()) as Metrics;
  let clock = m.time[0] * 1000 + 60_000;
  const adapter = new MetricsAdapter({ now: () => clock, ignore: SKIP });
  adapter.ingest(windowMeans(m, clock - 60_000, clock));
  const rt = new IsomorphRuntime({ adapter, pollMs: 3_600_000, numRuns: 5, compile: { mode: 'heuristic' }, confirmMs: CONFIRM_MS });
  if ((await rt.start()) !== 'running') throw new Error(`${name}: 세계가 열리지 않음: ${rt.error}`);
  const end = Math.min(m.time.at(-1)! * 1000, inject + HORIZON_MS);
  while (clock < end) {
    clock += POLL_MS;
    adapter.ingest(windowMeans(m, clock - 60_000, clock));
    await rt.refresh();
  }
  const incidents = rt.incidents.all().filter((i) => !i.observedFromStart);
  if (process.env.DEBUG) for (const i of [...incidents].sort((a, b) => a.openedAt - b.openedAt)) console.log(`   [${Math.round((i.openedAt - inject) / 1000)}s] root ${i.root.pk}: ${i.root.violation}`);
  const falseAlarms = incidents.filter((i) => i.openedAt < inject).length;
  const ranked = incidents.filter((i) => i.openedAt >= inject).sort((a, b) => a.openedAt - b.openedAt || b.violations.length - a.violations.length || a.root.pk.localeCompare(b.root.pk));
  await rt.stop();
  const first = ranked[0];
  const top3 = [...new Set(ranked.map((i) => i.root.pk))].slice(0, 3);
  const predicted = first ? first.root.pk : null;
  const base = baseline(m, inject);
  return {
    case: name,
    suite,
    fault,
    truth,
    predicted,
    outcome: !predicted ? 'abstain' : norm(predicted) === norm(truth) ? 'correct' : 'wrong',
    detectSec: first ? Math.round((first.openedAt - inject) / 1000) : null,
    falseAlarms,
    baseline: base,
    baselineCorrect: !!base && norm(base) === norm(truth),
    top3,
    correct3: top3.some((x) => norm(x) === norm(truth)),
  };
}

const dirs = fs
  .readdirSync(dataDir)
  .filter((d) => suites.some((s) => d === s || d.startsWith(`${s}_`)) && fs.existsSync(path.join(dataDir, d, 'metrics.json.gz')))
  .sort();
const results: CaseResult[] = [];
for (const d of dirs) {
  const r = await replayMetricsCase(path.join(dataDir, d));
  results.push(r);
  console.log(`${r.case}: ${r.outcome} (예측 ${r.predicted ?? '-'}, 정답 ${r.truth}, ${r.detectSec ?? '-'}초, 거짓 경보 ${r.falseAlarms})`);
}
console.log(`\n${summarize(results)}`);
const json = arg('--json');
if (json) fs.writeFileSync(json, JSON.stringify(results, null, 2));
process.exit(0);
