import * as fc from 'fast-check';
import type { CollectionSchema, FieldSchema, Pk, Row, Snapshot, SystemSchema } from './schema.ts';

export interface SnapshotArbOptions {
  maxRows?: number;
  ts?: number;
}

function pkList(c: CollectionSchema, n: number): Pk[] {
  const pkField = c.fields.find((f) => f.name === c.primaryKey);
  const numeric = !pkField || pkField.type === 'integer' || pkField.type === 'number';
  return Array.from({ length: n }, (_, i) => (numeric ? i + 1 : `${c.name}-${i + 1}`));
}

function fieldArb(f: FieldSchema, refPks: Map<string, Pk[]>, ts: number): fc.Arbitrary<unknown> {
  let base: fc.Arbitrary<unknown>;
  if (f.ref) {
    const pks = refPks.get(f.ref.collection) ?? [];
    const dangling = fc.constant<unknown>(typeof pks[0] === 'string' || f.type === 'string' ? 'missing-ref' : 999_999);
    base = pks.length
      ? fc.oneof({ arbitrary: fc.constantFrom<unknown>(...pks), weight: 8 }, { arbitrary: dangling, weight: 1 })
      : dangling;
  } else {
    switch (f.type) {
      case 'integer': {
        const lo = Math.min(-5, Math.floor(f.stats?.min ?? 0));
        const hi = Math.max(20, Math.ceil((f.stats?.max ?? 50) * 2));
        base = fc.oneof(fc.integer({ min: lo, max: hi }), fc.constantFrom(0, -1, 1));
        break;
      }
      case 'number': {
        const hi = Math.max(10, (f.stats?.max ?? 500) * 2);
        base = fc.oneof(
          fc.double({ min: -100, max: hi, noNaN: true, noDefaultInfinity: true }),
          fc.constantFrom(0, -1, 0.5),
        );
        break;
      }
      case 'boolean':
        base = fc.boolean();
        break;
      case 'timestamp':
        base = fc.integer({ min: 0, max: 300_000 }).map((d) => new Date(ts - d).toISOString());
        break;
      case 'json':
        base = fc.constant(null);
        break;
      default:
        base = f.enumValues?.length
          ? fc.oneof(
              { arbitrary: fc.constantFrom<unknown>(...f.enumValues), weight: 9 },
              { arbitrary: fc.constant<unknown>('__unknown__'), weight: 1 },
            )
          : fc.string({ maxLength: 6 });
    }
  }
  return f.nullable ? fc.option(base, { nil: null, freq: 6 }) : base;
}

/** 스키마로부터 무작위 시스템 상태를 생성한다(참조는 대부분 유효, 가끔 끊김). */
export function snapshotArbitrary(schema: SystemSchema, opts: SnapshotArbOptions = {}): fc.Arbitrary<Snapshot> {
  const maxRows = opts.maxRows ?? 5;
  const ts = opts.ts ?? 1_700_000_000_000;
  const cols = schema.collections;
  if (cols.length === 0) return fc.constant({ ts, collections: {} });
  return fc.tuple(...cols.map(() => fc.integer({ min: 0, max: maxRows }))).chain((counts) => {
    const refPks = new Map(cols.map((c, i) => [c.name, pkList(c, counts[i])] as const));
    const perCol = cols.map((c) => {
      const pks = refPks.get(c.name)!;
      if (pks.length === 0) return fc.constant<Row[]>([]);
      const fields = c.fields.filter((f) => f.name !== c.primaryKey);
      const rec = fc.record(Object.fromEntries(fields.map((f) => [f.name, fieldArb(f, refPks, ts)])) as Record<string, fc.Arbitrary<unknown>>);
      return fc.tuple(...pks.map((pk) => rec.map((r) => ({ [c.primaryKey]: pk, ...r }) as Row)));
    });
    return fc.tuple(...perCol).map((all) => ({
      ts,
      collections: Object.fromEntries(cols.map((c, i) => [c.name, all[i] as Row[]])),
    }));
  });
}
