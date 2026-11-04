import { keyOf, type EvalContext } from './expr.ts';
import type { Snapshot, SystemSchema } from './schema.ts';

/** 컬렉션별 평가 문맥(참조 집합·값 빈도)을 지연 생성·캐시한다. */
export function buildContextFactory(snapshot: Snapshot, _schema: SystemSchema): (collection: string) => EvalContext {
  const valueSets = new Map<string, Set<string>>();
  const counts = new Map<string, Map<string, number>>();
  const valuesOf = (collection: string, field: string) => {
    const key = `${collection}.${field}`;
    let s = valueSets.get(key);
    if (!s) {
      s = new Set((snapshot.collections[collection] ?? []).map((r) => keyOf(r[field])));
      for (const v of snapshot.outside?.[key] ?? []) s.add(keyOf(v));
      valueSets.set(key, s);
    }
    return s;
  };
  return (collection: string) => ({
    valuesOf,
    countOf(field: string, value: unknown) {
      const key = `${collection}.${field}`;
      let m = counts.get(key);
      if (!m) {
        m = new Map();
        for (const r of snapshot.collections[collection] ?? []) {
          const k = keyOf(r[field]);
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        counts.set(key, m);
      }
      return m.get(keyOf(value)) ?? 0;
    },
  });
}

