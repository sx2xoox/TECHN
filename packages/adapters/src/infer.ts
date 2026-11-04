import type { CollectionSchema, FieldSchema, FieldType, Row } from '@isomorph/core';

const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function typeOf(values: unknown[]): FieldType {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return 'string';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'number')) return present.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  if (present.every((v) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)))) return 'timestamp';
  if (present.some((v) => typeof v === 'object')) return 'json';
  return 'string';
}

/** 표본 행들로부터 컬렉션 스키마를 추론한다(HTTP/JSON 처럼 스키마가 없는 시스템용). */
export function inferCollection(name: string, rows: Row[], pkHint?: string): CollectionSchema {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const primaryKey = pkHint ?? (keys.includes('id') ? 'id' : keys.find((k) => /(^|_)id$/i.test(k)) ?? keys[0] ?? 'id');
  if (!keys.includes(primaryKey)) keys.unshift(primaryKey);
  const fields: FieldSchema[] = keys.map((k) => {
    const values = rows.map((r) => r[k]);
    return { name: k, type: typeOf(values), nullable: values.some((v) => v === null || v === undefined) || k !== primaryKey && rows.length === 0 };
  });
  return { name, primaryKey, fields, rowCountHint: rows.length };
}

function singular(s: string): string[] {
  const out = [s, `${s}s`, `${s}es`];
  if (s.endsWith('y')) out.push(`${s.slice(0, -1)}ies`);
  return out;
}

/** `product_id` / `productId` 같은 이름으로 참조를 추론한다(DB가 강제하지 않음 → refEnforced=false). */
export function inferRefs(collections: CollectionSchema[]): CollectionSchema[] {
  const names = new Map(collections.map((c) => [c.name.toLowerCase(), c] as const));
  return collections.map((c) => ({
    ...c,
    fields: c.fields.map((f) => {
      if (f.ref || f.name === c.primaryKey) return f;
      const m = /^(.+?)(?:_id|Id|ID)$/.exec(f.name);
      if (!m) return f;
      const base = m[1].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      const parts = base.split('_');
      const candidates = [...singular(base), ...singular(parts.at(-1)!)];
      const target = candidates.map((x) => names.get(x)).find((x) => x && x.name !== c.name);
      return target ? { ...f, ref: { collection: target.name, field: target.primaryKey }, refEnforced: false } : f;
    }),
  }));
}
