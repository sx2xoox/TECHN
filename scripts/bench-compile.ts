import * as fc from 'fast-check';
import { markSensitive, verifyGrammar, type CollectionSchema, type FieldType, type SystemSchema } from '@isomorph/core';
import { BENCH_SCHEMAS, compile, compileHeuristic } from '@isomorph/compiler';

/**
 * 무인 컴파일 KPI: "처음 보는 스키마에서 사람 개입 없이 렌즈 법칙 통과 비율"
 *  1) 도메인 스키마 12종 (손으로 만든 현실적 예시)
 *  2) 무작위 스키마 N종 (이름·타입·참조를 무작위로 — 컴파일러가 설계 시 보지 못한 입력)
 */
const NUM_RUNS = Number(process.env.RUNS ?? 60);

function randomSchemaArb(): fc.Arbitrary<SystemSchema> {
  const word = fc.constantFrom('alpha', 'beta', 'item', 'node', 'user', 'event', 'log', 'order', 'task', 'thing', 'record', 'entry', 'zone', 'asset', 'ticket', 'unit');
  const fieldName = fc.constantFrom('name', 'status', 'state', 'count', 'value', 'score', 'active', 'flag', 'created_at', 'updated_at', 'level', 'kind', 'amount', 'latency_ms', 'errors', 'note', 'email', 'stock', 'is_open', 'label', 'priority', 'total', 'ratio', 'payload');
  const type = fc.constantFrom<FieldType>('integer', 'number', 'string', 'boolean', 'timestamp', 'json');
  return fc.tuple(fc.uniqueArray(word, { minLength: 1, maxLength: 5 }), fc.integer({ min: 0, max: 1_000_000 })).chain(([names, seed]) =>
    fc.tuple(...names.map(() => fc.uniqueArray(fc.tuple(fieldName, type, fc.boolean(), fc.boolean()), { minLength: 1, maxLength: 7, selector: (t) => t[0] }))).map((fieldSets) => {
      const collections: CollectionSchema[] = names.map((n, i) => ({
        name: `${n}s`,
        primaryKey: 'id',
        fields: [
          { name: 'id', type: 'integer' as const, nullable: false },
          ...fieldSets[i].map(([fname, t, nullable, useEnum]) => ({
            name: fname,
            type: t,
            nullable,
            ...(t === 'string' && useEnum ? { enumValues: ['a', 'b', 'c', 'ok', 'failed'].slice(0, 2 + (seed % 4)) } : {}),
            ...(t === 'integer' || t === 'number' ? { stats: { min: 0, max: (seed % 997) + 1 } } : {}),
          })),
          // 앞 컬렉션을 가리키는 참조(사건 → 장소 구조를 무작위로 만든다)
          ...(i > 0 && (seed + i) % 2 === 0 ? [{ name: `${names[i - 1]}_id`, type: 'integer' as const, nullable: false, ref: { collection: `${names[i - 1]}s`, field: 'id' } }] : []),
        ],
      }));
      return markSensitive({ system: `random-${seed}`, source: 'http', collections, constraints: [] });
    }),
  );
}

async function main() {
  const rows: { name: string; firstPass: boolean; repaired: boolean; score: number; rounds: number; kinds: number; checks: number }[] = [];
  for (const schema of BENCH_SCHEMAS) {
    const first = verifyGrammar(compileHeuristic(schema), schema, { numRuns: NUM_RUNS });
    const result = await compile(schema, { mode: 'heuristic', numRuns: NUM_RUNS });
    rows.push({ name: schema.system, firstPass: first.ok, repaired: result.report.ok, score: result.report.fidelity.score, rounds: result.rounds.length, kinds: result.grammar.kinds.length, checks: result.report.checks.length });
  }
  console.log('\n도메인 스키마 12종 (규칙 기반 컴파일러, 사람 개입 없음)');
  console.table(rows);
  const firstPass = rows.filter((r) => r.firstPass).length;
  const repaired = rows.filter((r) => r.repaired).length;
  console.log(`1차 통과: ${firstPass}/${rows.length}, 자동 수리 후 통과: ${repaired}/${rows.length}`);

  const N = Number(process.env.RANDOM ?? 100);
  const samples = fc.sample(randomSchemaArb(), { numRuns: N, seed: 7 });
  let rFirst = 0;
  let rFinal = 0;
  const failures: string[] = [];
  for (const schema of samples) {
    const first = verifyGrammar(compileHeuristic(schema), schema, { numRuns: 30 });
    if (first.ok) rFirst++;
    const result = await compile(schema, { mode: 'heuristic', numRuns: 30 });
    if (result.report.ok) rFinal++;
    else failures.push(`${schema.system}: ${result.report.issues.filter((i) => i.level === 'error').map((i) => i.code + ' ' + i.message).slice(0, 2).join(' | ')}`);
  }
  console.log(`\n무작위 스키마 ${N}종: 1차 통과 ${rFirst}/${N}, 자동 수리 후 통과 ${rFinal}/${N}`);
  for (const f of failures.slice(0, 10)) console.log('  실패:', f);
  const kpi = repaired >= Math.ceil(rows.length * 0.8);
  console.log(`\nKPI(10종 중 8종 이상 무인 통과): ${kpi ? '달성 ✅' : '미달 ❌'}`);
  if (!kpi) process.exitCode = 1;
}

main();
