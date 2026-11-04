import fs from 'node:fs';
import path from 'node:path';
import { markSensitive, verifyGrammar, type CollectionSchema, type FieldSchema, type FieldType, type SystemSchema } from '@isomorph/core';
import { inferRefs } from '@isomorph/adapters';
import { compile, compileHeuristic } from '@isomorph/compiler';

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

const TYPE: Record<string, FieldType> = {
  string: 'string', text: 'string', citext: 'string', uuid: 'string', inet: 'string', cidr: 'string', enum: 'string', binary: 'string', interval: 'string', virtual: 'string',
  integer: 'integer', bigint: 'integer', smallint: 'integer', serial: 'integer', bigserial: 'integer',
  float: 'number', decimal: 'number', numeric: 'number', real: 'number', money: 'number',
  boolean: 'boolean',
  datetime: 'timestamp', timestamp: 'timestamp', timestamptz: 'timestamp', date: 'timestamp', time: 'timestamp',
  json: 'json', jsonb: 'json', hstore: 'json',
};

function singularize(name: string) {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(name)) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/** Rails db/schema.rb → SystemSchema (create_table / t.<type> / t.references / add_foreign_key 만 읽는다) */
export function parseRailsSchema(system: string, src: string): SystemSchema {
  const tables = new Map<string, CollectionSchema>();
  const fks: { from: string; to: string; column: string }[] = [];
  let cur: CollectionSchema | null = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const ct = /^create_table "([^"]+)"(.*) do \|t\|$/.exec(line);
    if (ct) {
      const opts = ct[2];
      const noId = /\bid: false\b/.test(opts);
      const pk = /primary_key: "([^"]+)"/.exec(opts)?.[1] ?? 'id';
      const idType: FieldType = /\bid: :(uuid|string)\b/.test(opts) ? 'string' : 'integer';
      cur = { name: ct[1], primaryKey: noId ? '' : pk, fields: noId ? [] : [{ name: pk, type: idType, nullable: false }] };
      tables.set(cur.name, cur);
      continue;
    }
    if (!cur) {
      const fk = /^add_foreign_key "([^"]+)", "([^"]+)"(.*)$/.exec(line);
      if (fk) fks.push({ from: fk[1], to: fk[2], column: /column: "([^"]+)"/.exec(fk[3])?.[1] ?? `${singularize(fk[2])}_id` });
      continue;
    }
    if (line === 'end') {
      if (!cur.primaryKey) cur.primaryKey = cur.fields[0]?.name ?? 'id';
      cur = null;
      continue;
    }
    if (line.startsWith('t.timestamps')) {
      cur.fields.push({ name: 'created_at', type: 'timestamp', nullable: false }, { name: 'updated_at', type: 'timestamp', nullable: false });
      continue;
    }
    const ref = /^t\.(references|belongs_to) "([^"]+)"(.*)$/.exec(line);
    if (ref) {
      const opts = ref[3];
      cur.fields.push({ name: `${ref[2]}_id`, type: /type: :uuid/.test(opts) ? 'string' : 'integer', nullable: !/null: false/.test(opts) });
      if (/polymorphic: true/.test(opts)) cur.fields.push({ name: `${ref[2]}_type`, type: 'string', nullable: true });
      continue;
    }
    const col = /^t\.(\w+) "([^"]+)"(.*)$/.exec(line);
    if (col && col[1] !== 'index' && col[1] !== 'check_constraint') {
      const opts = col[3];
      const f: FieldSchema = { name: col[2], type: /array: true/.test(opts) ? 'json' : (TYPE[col[1]] ?? 'string'), nullable: !/null: false/.test(opts) };
      cur.fields.push(f);
    }
  }
  const collections = inferRefs([...tables.values()]).map((c) => ({
    ...c,
    fields: c.fields.map((f) => {
      const fk = fks.find((x) => x.from === c.name && x.column === f.name && tables.has(x.to));
      return fk ? { ...f, ref: { collection: fk.to, field: tables.get(fk.to)!.primaryKey }, refEnforced: true } : f;
    }),
  }));
  return markSensitive({ system, source: 'postgres', collections, constraints: [] });
}

const GENERIC = /^(건물|주민)(\(|$)/;
const rows: Record<string, string | number | boolean>[] = [];
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
  const g = kinds.filter((k) => GENERIC.test(k.title)).length;
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
console.log(`\n보류 스키마 ${rows.length}종: 렌즈 법칙 통과 ${lawful}/${rows.length} · 일반 은유('건물'·'주민')로 남은 종류 ${generic}/${total} = ${((generic / Math.max(total, 1)) * 100).toFixed(0)}%`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, total, generic, lawful }, null, 2));
