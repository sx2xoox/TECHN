import { findCollection, pkOf, type Pk, type Row, type Snapshot, type SystemSchema } from './schema.ts';

/** 두 스냅샷 사이의 행 단위 변화. 이벤트 저장소·타임 스크러버·원인 추적의 원재료. */
export interface ChangeEvent {
  ts: number;
  collection: string;
  pk: Pk;
  kind: 'insert' | 'update' | 'delete';
  before: Row | null;
  after: Row | null;
}

function indexRows(rows: Row[], pkField: string): Map<string, Row> {
  return new Map(rows.map((r) => [String(r[pkField]), r]));
}

export function diffSnapshots(prev: Snapshot | null, next: Snapshot, schema: SystemSchema): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (const col of schema.collections) {
    const nextRows = next.collections[col.name] ?? [];
    const prevIdx = indexRows(prev?.collections[col.name] ?? [], col.primaryKey);
    const nextIdx = indexRows(nextRows, col.primaryKey);
    for (const [key, row] of nextIdx) {
      const old = prevIdx.get(key);
      if (!old) out.push({ ts: next.ts, collection: col.name, pk: pkOf(row, col), kind: 'insert', before: null, after: row });
      else if (JSON.stringify(old) !== JSON.stringify(row)) out.push({ ts: next.ts, collection: col.name, pk: pkOf(row, col), kind: 'update', before: old, after: row });
    }
    for (const [key, row] of prevIdx) {
      if (!nextIdx.has(key)) out.push({ ts: next.ts, collection: col.name, pk: pkOf(row, col), kind: 'delete', before: row, after: null });
    }
  }
  return out;
}

/** base 위에 이벤트를 순서대로 재생해 과거 시점의 스냅샷을 복원한다. */
export function applyEvents(base: Snapshot, events: ChangeEvent[], schema: SystemSchema, ts?: number): Snapshot {
  const maps = new Map<string, Map<string, Row>>();
  for (const col of schema.collections) maps.set(col.name, indexRows(base.collections[col.name] ?? [], col.primaryKey));
  let last = base.ts;
  for (const e of events) {
    const col = findCollection(schema, e.collection);
    const m = maps.get(e.collection);
    if (!col || !m) continue;
    const key = String(e.pk);
    if (e.kind === 'delete') m.delete(key);
    else if (e.after) m.set(key, e.after);
    last = Math.max(last, e.ts);
  }
  const collections: Record<string, Row[]> = {};
  for (const [name, m] of maps) collections[name] = [...m.values()];
  return { ts: ts ?? last, collections };
}
