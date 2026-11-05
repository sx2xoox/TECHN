import type { CollectionSchema } from './schema.ts';

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
