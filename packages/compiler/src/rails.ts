import { inferRefs, markSensitive, type CollectionSchema, type FieldSchema, type FieldType, type SystemSchema } from '@isomorph/core';

/**
 * Rails 의 db/schema.rb 를 '실행하지 않고' 글자로만 읽어 시스템 스키마로 바꾼다.
 * create_table / t.<type> / t.references / t.timestamps / add_foreign_key 만 본다(데이터 없음).
 */
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

