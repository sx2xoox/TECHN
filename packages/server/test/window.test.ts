import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAdapter } from '@isomorph/adapters';
import { IsomorphRuntime } from '../src/index.ts';

/**
 * 공개 예제 DB(Pagila)에서 찾은 실제 문제 두 가지의 회귀 시험:
 *  1) 최근 N행만 읽는 관측 창 밖의 행을 가리키는 참조를 '대상 없음(유령)' 으로 잘못 그리던 문제
 *  2) 파티션 테이블의 파티션을 별개 테이블로 또 그리고, 파티션에만 걸린 외래 키를 놓치던 문제
 */
let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table warehouses (id integer primary key, name text not null, stock integer not null);
    -- 외래 키 없음: 참조는 이름으로 추정된다(그래서 '대상이 있어야 함' 은 추정 법칙)
    create table shipments (id integer primary key, warehouse_id integer not null, status text not null);
    insert into warehouses select g, 'w' || g, 10 from generate_series(1, 60) g;
    insert into shipments select g, g, 'sent' from generate_series(1, 20) g;
    insert into shipments values (21, 999, 'sent'); -- 진짜 고아 행

    create table ledger (id integer not null, warehouse_id integer not null, at date not null, primary key (id, at)) partition by range (at);
    create table ledger_2024 partition of ledger for values from ('2024-01-01') to ('2025-01-01');
    create table ledger_2025 partition of ledger for values from ('2025-01-01') to ('2026-01-01');
    alter table ledger_2024 add foreign key (warehouse_id) references warehouses (id);
    alter table ledger_2025 add foreign key (warehouse_id) references warehouses (id);
    insert into ledger values (1, 3, '2024-05-01'), (2, 4, '2025-02-01');
  `);
});

afterAll(async () => {
  await db?.close();
});

const runtime = (adapter: PostgresAdapter) => new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 20, compile: { mode: 'heuristic' } });

describe('observation window and partitions', () => {
  it('folds partitions into their parent and keeps their foreign keys', async () => {
    const schema = await new PostgresAdapter({ queryable: db, system: 'w' }).introspect();
    expect(schema.collections.map((c) => c.name).sort()).toEqual(['ledger', 'shipments', 'warehouses']);
    const ref = schema.collections.find((c) => c.name === 'ledger')!.fields.find((f) => f.name === 'warehouse_id')!;
    expect(ref.ref).toEqual({ collection: 'warehouses', field: 'id' });
    expect(ref.refEnforced).toBe(true);
  });

  it('does not show rows outside the window as missing, but still flags a real orphan', async () => {
    const rt = runtime(new PostgresAdapter({ queryable: db, system: 'w', rowLimit: 10 }));
    expect(await rt.start()).toBe('running');
    // 창: shipments 12~21, warehouses 51~60 → shipments 12~20 의 대상(12~20)은 창 밖이지만 실제로 있다
    const orphans = rt.world!.violations.filter((v) => v.invariantId === 'ref_shipments_warehouse_id');
    expect(orphans.map((v) => v.pk)).toEqual([21]);
    expect(rt.lastSnapshot!.outside?.['warehouses.id']).toHaveLength(9);
    // 시간 여행에서도 같은 판단
    expect(rt.seek(rt.lastSnapshot!.ts)!.violations.filter((v) => v.invariantId === 'ref_shipments_warehouse_id').map((v) => v.pk)).toEqual([21]);
    await rt.stop();
  });

  it('without a lookup capability, every out-of-window reference would look like a ghost', async () => {
    const adapter = new PostgresAdapter({ queryable: db, system: 'w', rowLimit: 10 });
    (adapter as { lookup?: unknown }).lookup = undefined;
    const rt = runtime(adapter);
    await rt.start();
    expect(rt.world!.violations.filter((v) => v.invariantId === 'ref_shipments_warehouse_id')).toHaveLength(10);
    await rt.stop();
  });
});
