import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { OtelAdapter, type OtelAdapterOptions } from '@isomorph/adapters';
import { IsomorphRuntime } from '@isomorph/server';

/**
 * 공개 RCA 벤치마크(RCAEval) 의 실제 장애 주입 기록을 ISOMORPH 로 다시 재생해 근본 원인을 맞히는지 잰다.
 *   python3 -I scripts/rcaeval/fetch.py --suites re2ob,re3ob --out data/rcaeval   (먼저 내려받기)
 *   npx tsx scripts/rcaeval/replay.ts --suites re2ob,re3ob [--limit 10] [--json out.json]
 *
 * 재생: 실제 스팬을 시각 순서대로 진짜 OpenTelemetry 어댑터에 넣고(재생 시계), 진짜 런타임을 15초마다 관측시킨다.
 *  - 법칙·진단·근본 원인 사슬·장애 묶기는 실제 서버와 같은 코드다(사람 손 없이 heuristic 컴파일).
 *  - 예측: 장애를 주입한 뒤 처음 열린 장애 기록의 근본 원인(서비스). 없으면 '못 찾음'.
 *  - 거짓 경보: 주입 전(평상시)에 열린 장애 기록.
 *  - 단순 기준선(맥락용): 주입 뒤 5분 동안 진입 스팬 p90 지연이 평소보다 가장 많이 오른 서비스.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const dataDir = path.resolve(arg('--data') ?? path.join(root, 'data/rcaeval'));
const suites = (arg('--suites') ?? 're2ob,re3ob').split(',');
const limit = Number(arg('--limit') ?? 0);
const POLL_MS = 15_000;
/** 위반이 이만큼 이어져야 장애 기록을 연다(런타임의 confirmMs) */
const CONFIRM_MS = Number(process.argv.includes('--confirm') ? process.argv[process.argv.indexOf('--confirm') + 1] : 0) * 1000;
const HORIZON_MS = 10 * 60_000;

type Span = [number, number, string, string, string | null, string, string, number | null];

/** 이름 비교: 소문자·글자와 숫자만·끝의 'service' 를 뗀다(frontendservice = frontend, ts-auth-service = tsauth) */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/service$/, '');

async function readSpans(file: string): Promise<Span[]> {
  const out: Span[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) out.push(JSON.parse(line) as Span);
  return out;
}

/** 상태 코드: gRPC 0 / HTTP 2xx·3xx / 없음 → 정상, 나머지 → 오류 */
const isError = (code: number | null) => code !== null && code !== 0 && !(code >= 200 && code < 400);

function toOtlp(batch: Span[]) {
  const byService = new Map<string, Span[]>();
  for (const s of batch) {
    const list = byService.get(s[5]);
    if (list) list.push(s);
    else byService.set(s[5], [s]);
  }
  return {
    resourceSpans: [...byService].map(([service, spans]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [
        {
          spans: spans.map((s) => ({
            traceId: s[2],
            spanId: s[3],
            parentSpanId: s[4] ?? undefined,
            name: s[6],
            startTimeUnixNano: String(BigInt(Math.round(s[0])) * 1_000_000n),
            endTimeUnixNano: String(BigInt(Math.round(s[0] + s[1])) * 1_000_000n),
            status: { code: isError(s[7]) ? 2 : 0 },
          })),
        },
      ],
    })),
  };
}

/** 맥락용 단순 기준선: 진입 스팬 p90 지연의 상승 비율 1위 */
function latencyBaseline(spans: Span[], inject: number): string | null {
  const parentOwner = new Map(spans.map((s) => [s[3], s[5]]));
  const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : NaN);
  const before = new Map<string, number[]>();
  const after = new Map<string, number[]>();
  for (const s of spans) {
    const entry = !s[4] || parentOwner.get(s[4]) !== s[5];
    if (!entry) continue;
    const m = s[0] < inject ? (s[0] >= inject - 5 * 60_000 ? before : null) : s[0] < inject + 5 * 60_000 ? after : null;
    if (!m) continue;
    const list = m.get(s[5]);
    if (list) list.push(s[1]);
    else m.set(s[5], [s[1]]);
  }
  let best: string | null = null;
  let bestR = 0;
  for (const [svc, xs] of after) {
    const r = p90(xs) / Math.max(0.001, p90(before.get(svc) ?? []));
    if (Number.isFinite(r) && r > bestR) [best, bestR] = [svc, r];
  }
  return best;
}

export interface CaseResult {
  case: string;
  suite: string;
  fault: string;
  truth: string;
  predicted: string | null;
  outcome: 'correct' | 'wrong' | 'abstain';
  detectSec: number | null;
  falseAlarms: number;
  baseline: string | null;
  baselineCorrect: boolean;
  /** 열린 순서로 처음 세 근본 원인(겹치면 한 번) 안에 정답이 있는가 */
  top3: string[];
  correct3: boolean;
}

export async function replayCase(dir: string, adapterOpts: Partial<OtelAdapterOptions> = {}): Promise<CaseResult> {
  const name = path.basename(dir);
  const [suite, truth, fault] = name.split('_');
  const inject = Number(fs.readFileSync(path.join(dir, 'inject_time.txt'), 'utf8').trim()) * 1000;
  const spans = await readSpans(path.join(dir, 'spans.jsonl.gz'));
  let clock = spans[0][0] + 60_000;
  let next = 0;
  const feed = () => {
    const batch: Span[] = [];
    while (next < spans.length && spans[next][0] + spans[next][1] <= clock) batch.push(spans[next++]);
    if (batch.length) adapter.ingest(toOtlp(batch) as never);
  };
  const adapter = new OtelAdapter({ port: 0, now: () => clock, ...adapterOpts });
  const rt = new IsomorphRuntime({ adapter, pollMs: 3_600_000, numRuns: 5, compile: { mode: 'heuristic' }, confirmMs: CONFIRM_MS });
  feed();
  if ((await rt.start()) !== 'running') throw new Error(`${name}: 세계가 열리지 않음: ${rt.error}`);
  const end = Math.min(spans.at(-1)![0], inject + HORIZON_MS);
  while (clock < end) {
    clock += POLL_MS;
    feed();
    await rt.refresh();
    if (process.env.DEBUG === '2' && clock < inject) {
      for (const v of rt.world?.violations ?? []) {
        const r = rt.lastSnapshot!.collections.services.find((x) => x.id === v.pk);
        if (r) console.log(`   (${Math.round((clock - inject) / 1000)}s) ${v.pk} ${v.title.slice(0, 10)} calls/min=${r.calls_per_min} err=${r.error_count} ratio=${r.error_ratio} lim=${r.error_limit} p90=${r.p90_latency_ms} lim=${r.latency_limit_ms}`);
      }
    }
  }
  const incidents = rt.incidents.all().filter((i) => !i.observedFromStart);
  if (process.env.DEBUG) for (const i of [...incidents].sort((a, b) => a.openedAt - b.openedAt)) console.log(`   [${Math.round((i.openedAt - inject) / 1000)}s] root ${i.root.pk}: ${i.root.violation} · ${i.violations.map((v) => `${v.pk}(${v.title.slice(0, 12)})`).join(', ')}`);
  const falseAlarms = incidents.filter((i) => i.openedAt < inject).length;
  // 순위: 열린 순서(같은 관측이면 위반이 많은 장애 먼저, 그다음 이름 순) — 사람이 장애 목록을 위에서부터 보는 순서
  const ranked = incidents.filter((i) => i.openedAt >= inject).sort((a, b) => a.openedAt - b.openedAt || b.violations.length - a.violations.length || a.root.pk.localeCompare(b.root.pk));
  const first = ranked[0];
  const top3 = [...new Set(ranked.map((i) => i.root.pk))].slice(0, 3);
  await rt.stop();
  const predicted = first ? first.root.pk : null;
  const baseline = latencyBaseline(spans, inject);
  return {
    case: name,
    suite,
    fault,
    truth,
    predicted,
    outcome: !predicted ? 'abstain' : norm(predicted) === norm(truth) ? 'correct' : 'wrong',
    detectSec: first ? Math.round((first.openedAt - inject) / 1000) : null,
    falseAlarms,
    baseline,
    baselineCorrect: !!baseline && norm(baseline) === norm(truth),
    top3,
    correct3: top3.some((x) => norm(x) === norm(truth)),
  };
}

export function summarize(results: CaseResult[]) {
  const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : '-');
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    for (const k of [`${r.suite} · 전체`, `${r.suite} · ${r.fault}`]) groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const lines = ['| 묶음 | 사례 | AC@1(맞음) | 틀림 | 못 찾음 | AC@3 | 거짓 경보(주입 전) | 찾기까지(중앙값) | 기준선 AC@1 |', '|---|---|---|---|---|---|---|---|---|'];
  for (const [k, rs] of [...groups].sort()) {
    const det = rs.map((r) => r.detectSec).filter((x): x is number => x !== null).sort((a, b) => a - b);
    lines.push(`| ${k} | ${rs.length} | ${pct(rs.filter((r) => r.outcome === 'correct').length, rs.length)} | ${pct(rs.filter((r) => r.outcome === 'wrong').length, rs.length)} | ${pct(rs.filter((r) => r.outcome === 'abstain').length, rs.length)} | ${pct(rs.filter((r) => r.correct3).length, rs.length)} | ${rs.reduce((a, r) => a + r.falseAlarms, 0)}건 | ${det.length ? `${det[Math.floor(det.length / 2)]}초` : '-'} | ${pct(rs.filter((r) => r.baselineCorrect).length, rs.length)} |`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dirs = fs
    .readdirSync(dataDir)
    .filter((d) => suites.some((s) => d === s || d.startsWith(`${s}_`)) && fs.existsSync(path.join(dataDir, d, 'spans.jsonl.gz')))
    .sort();
  const picked = limit ? dirs.slice(0, limit) : dirs;
  const results: CaseResult[] = [];
  for (const d of picked) {
    const t0 = performance.now();
    const r = await replayCase(path.join(dataDir, d));
    results.push(r);
    console.log(`${r.case}: ${r.outcome} (예측 ${r.predicted ?? '-'}, 정답 ${r.truth}, ${r.detectSec ?? '-'}초, 거짓 경보 ${r.falseAlarms}) ${Math.round(performance.now() - t0)}ms`);
  }
  console.log(`\n${summarize(results)}`);
  const json = arg('--json');
  if (json) fs.writeFileSync(json, JSON.stringify(results, null, 2));
  process.exit(0);
}
