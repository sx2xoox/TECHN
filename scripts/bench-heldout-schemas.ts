import fs from 'node:fs';
import path from 'node:path';
import { verifyGrammar } from '@isomorph/core';
import { compile, compileHeuristic, parseRailsSchema } from '@isomorph/compiler';

/**
 * 보류 평가(held-out): 오픈소스 서비스가 실제로 운영하는 DB 스키마로 컴파일러를 시험한다.
 *  - Rails 의 db/schema.rb 를 '실행하지 않고' 글자로만 읽어 스키마를 만든다(데이터 없음).
 *  - 어휘를 고친 뒤에 처음 열어 보는 스키마들이다. 개별 테이블 이름은 출력하지 않고 집계만 낸다
 *    (보고 나서 어휘를 다시 맞추면 보류 평가가 아니게 되므로).
 *
 * 사용: npx tsx scripts/bench-heldout-schemas.ts <schema.rb 파일이 있는 폴더> [--json out.json]
 */
const dir = process.argv[2];
if (!dir) {
  console.error('사용: npx tsx scripts/bench-heldout-schemas.ts <folder-with-*.schema>');
  process.exit(2);
}
const jsonOut = (() => {
  const i = process.argv.indexOf('--json');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
})();

const GENERIC = /^(건물|주민)(\(|$)/;
type Basis = 'name' | 'structure' | 'fields' | 'generic' | 'llm' | 'manual';
/** 은유 근거: 컴파일러가 적어 둔 것(없으면 제목으로 추정 — 이전 판과 비교할 때) */
const basisOf = (k: { title: string; metaphorBasis?: Basis }): Basis => k.metaphorBasis ?? (GENERIC.test(k.title) ? 'generic' : 'name');
const rows: Record<string, string | number | boolean>[] = [];
const byBasis: Record<string, number> = {};
let total = 0;
let generic = 0;
let lawful = 0;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.schema')).sort()) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  if (!src.includes('create_table')) continue;
  const schema = parseRailsSchema(file.replace(/\.schema$/, ''), src);
  const first = verifyGrammar(compileHeuristic(schema), schema, { numRuns: 15 });
  const result = await compile(schema, { mode: 'heuristic', numRuns: 15 });
  const kinds = result.grammar.kinds;
  const g = kinds.filter((k) => basisOf(k) === 'generic').length;
  for (const k of kinds) byBasis[basisOf(k)] = (byBasis[basisOf(k)] ?? 0) + 1;
  total += kinds.length;
  generic += g;
  if (result.report.ok) lawful++;
  rows.push({
    app: schema.system,
    tables: schema.collections.length,
    refs: schema.collections.reduce((a, c) => a + c.fields.filter((f) => f.ref).length, 0),
    firstPass: first.ok,
    lawful: result.report.ok,
    fidelity: result.report.fidelity.score,
    walkers: kinds.filter((k) => k.archetype === 'npc').length,
    generic: `${g}/${kinds.length}`,
  });
}
console.table(rows);
const pct = (n: number) => `${((n / Math.max(total, 1)) * 100).toFixed(0)}%`;
console.log(`\n보류 스키마 ${rows.length}종: 렌즈 법칙 통과 ${lawful}/${rows.length} · 일반 은유('건물'·'주민')로 남은 종류 ${generic}/${total} = ${pct(generic)}`);
console.log(`은유 근거: 이름 사전 ${byBasis.name ?? 0}(${pct(byBasis.name ?? 0)}) · 구조 ${byBasis.structure ?? 0}(${pct(byBasis.structure ?? 0)}) · 필드 특징 ${byBasis.fields ?? 0}(${pct(byBasis.fields ?? 0)}) · 근거 없음 ${byBasis.generic ?? 0}(${pct(byBasis.generic ?? 0)})`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, total, generic, lawful, byBasis }, null, 2));
