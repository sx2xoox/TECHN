import { makeRcaScene, RCA_FAULTS, RCA_KINDS, rcaEngineOutcome, rcaFaultApplies, type RcaFault, type RcaKind } from '@isomorph/server';

/**
 * 근본 원인 찾기 벤치마크: 엔진(근본 원인 사슬)이 얼마나 맞는가, 어디서 틀리는가.
 *   npm run bench:rca [-- --seeds 30] [--json] [--fail-on-wrong]
 *   --fail-on-wrong: 엔진이 참된 경로 밖을 짚은 장면이 하나라도 있으면 실패(CI)
 *
 * 장면은 실제 Kubernetes·OpenTelemetry 어댑터 스키마를 그대로 쓴 합성 장면이다(사용자 실험과 같은 생성기).
 * 실패한 고객 화면(frontend)을 살펴봤을 때 나오는 사슬의 끝을 참된 경로와 견준다.
 *  - 맞음: 사슬의 끝이 근본 원인
 *  - 덜 감: 사슬의 끝이 참된 경로 위에 있지만 근본 원인까지 가지 못함(사람이 더 찾아야 함)
 *  - 멈춤: 사슬이 비어 있음(엔진이 아무것도 짚지 않음)
 *  - 틀림: 사슬의 끝이 참된 경로 밖(엔진이 엉뚱한 곳을 근본 원인으로 짚음 — 가장 위험)
 */
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const seeds = Number(arg('--seeds') ?? 30);

const applies = rcaFaultApplies;

const rows: { fault: RcaFault; kind: RcaKind; n: number; correct: number; partial: number; abstain: number; wrong: number; examples: string[] }[] = [];
const ts = 1_800_000_000_000;
for (const fault of RCA_FAULTS) {
  for (const kind of RCA_KINDS) {
    if (!applies(fault, kind)) continue;
    const row = { fault, kind, n: 0, correct: 0, partial: 0, abstain: 0, wrong: 0, examples: [] as string[] };
    for (let seed = 1; seed <= seeds; seed++) {
      const s = await makeRcaScene(kind, seed, ts, fault);
      const { outcome, chain } = rcaEngineOutcome(s);
      row.n++;
      row[outcome]++;
      if (outcome !== 'correct' && row.examples.length < 1) row.examples.push(`${outcome}: ${[s.symptom, ...chain].join(' ← ') || s.symptom} (정답 ${s.target})`);
    }
    rows.push(row);
  }
}

const pct = (a: number, n: number) => `${Math.round((a / n) * 100)}%`;
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`근본 원인 찾기 벤치마크 — 상황 × 원인 종류마다 장면 ${seeds}개\n`);
  console.log('| 상황 | 원인 | 맞음 | 덜 감 | 멈춤 | 틀림 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.fault} | ${r.kind} | ${pct(r.correct, r.n)} | ${pct(r.partial, r.n)} | ${pct(r.abstain, r.n)} | ${pct(r.wrong, r.n)} |`);
  const total = rows.reduce((a, r) => ({ n: a.n + r.n, correct: a.correct + r.correct, partial: a.partial + r.partial, abstain: a.abstain + r.abstain, wrong: a.wrong + r.wrong }), { n: 0, correct: 0, partial: 0, abstain: 0, wrong: 0 });
  console.log(`| **전체** | | **${pct(total.correct, total.n)}** | ${pct(total.partial, total.n)} | ${pct(total.abstain, total.n)} | ${pct(total.wrong, total.n)} |`);
  console.log('\n예(맞지 않은 첫 장면):');
  for (const r of rows) for (const e of r.examples) console.log(`  ${r.fault}/${r.kind}: ${e}`);
}
const wrong = rows.reduce((a, r) => a + r.wrong, 0);
if (process.argv.includes('--fail-on-wrong') && wrong > 0) {
  console.error(`\n엔진이 참된 경로 밖을 근본 원인으로 짚은 장면 ${wrong}개`);
  process.exit(1);
}
process.exit(0);
