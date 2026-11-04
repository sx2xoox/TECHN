import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { attachStats } from '@isomorph/core';
import { compile } from '@isomorph/compiler';
import { ConflictError, DockerAdapter, PostgresAdapter } from '../src/index.ts';

/**
 * 실제 시스템 통합 테스트(환경변수로 켬):
 *   ISOMORPH_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres
 *   ISOMORPH_TEST_DOCKER=1   (/var/run/docker.sock 에 실제 데몬, 'iso-web' 컨테이너 실행 중)
 */
const PG_URL = process.env.ISOMORPH_TEST_PG_URL;
const DOCKER = process.env.ISOMORPH_TEST_DOCKER === '1';

describe.skipIf(!PG_URL)('PostgresAdapter on a real PostgreSQL server', () => {
  const schemaName = `iso_test_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: PG_URL });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create schema ${schemaName}`);
    await admin.query(`set search_path to ${schemaName}`);
    await admin.query(`
      create type ${schemaName}.mood as enum ('calm', 'busy', 'angry');
      create table ${schemaName}.warehouses (
        id bigserial primary key,
        code uuid not null default gen_random_uuid(),
        name text not null,
        capacity numeric(10,2) not null check (capacity > 0),
        load real not null,
        opened_on date not null,
        meta jsonb,
        open boolean not null default true,
        mood ${schemaName}.mood not null default 'calm'
      );
      create table ${schemaName}.shipments (
        id serial primary key,
        warehouse_id bigint not null references ${schemaName}.warehouses(id),
        quantity integer not null,
        status text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      insert into ${schemaName}.warehouses (name, capacity, load, opened_on, meta) values
        ('북항', 1200.50, 0.42, '2024-03-01', '{"zone":"A"}'),
        ('남항', 800, 0.9, '2025-01-15', null);
      insert into ${schemaName}.shipments (warehouse_id, quantity, status) values (1, 3, 'pending'), (1, 5, 'delivered'), (2, 2, 'pending');
    `);
  });
  afterAll(async () => {
    await admin.query(`drop schema if exists ${schemaName} cascade`);
    await admin.end();
  });

  it('introspects real types, normalizes values and compiles a lawful world', async () => {
    const a = new PostgresAdapter({ connectionString: PG_URL, schema: schemaName, system: 'real-pg' });
    await a.connect();
    const schema = await a.introspect();
    const wh = schema.collections.find((c) => c.name === 'warehouses')!;
    const t = (n: string) => wh.fields.find((f) => f.name === n)!.type;
    expect([t('id'), t('code'), t('capacity'), t('load'), t('opened_on'), t('meta'), t('open'), t('mood')]).toEqual(['integer', 'string', 'number', 'number', 'timestamp', 'json', 'boolean', 'string']);
    expect(wh.fields.find((f) => f.name === 'mood')!.enumValues).toEqual(['calm', 'busy', 'angry']);
    expect(schema.constraints).toEqual([expect.objectContaining({ collection: 'warehouses', expr: { op: 'cmp', field: 'capacity', cmp: '>', value: 0 }, enforced: true })]);
    const sh = schema.collections.find((c) => c.name === 'shipments')!;
    expect(sh.fields.find((f) => f.name === 'warehouse_id')).toMatchObject({ ref: { collection: 'warehouses', field: 'id' }, refEnforced: true });

    const snap = await a.snapshot();
    const w1 = snap.collections.warehouses[0];
    expect(typeof w1.id).toBe('number'); // bigint → number
    expect(w1.capacity).toBe(1200.5); // numeric 문자열 → number
    expect(w1.opened_on).toMatch(/^2024-03-0\dT/); // date → ISO
    expect(w1.meta).toEqual({ zone: 'A' });
    expect(String(snap.collections.shipments[0].created_at)).toMatch(/Z$/);

    const r = await compile(attachStats(schema, snap), { mode: 'heuristic', numRuns: 60 });
    expect(r.report.ok).toBe(true);
    // CHECK 로 강제되는 capacity > 0 은 다시 제안하지 않는다
    expect(r.grammar.invariants.some((i) => i.expr.op === 'cmp' && i.expr.field === 'capacity')).toBe(false);

    const cmd = { op: 'update' as const, collection: 'warehouses', pk: 1, patch: { open: false }, before: { open: true } };
    await a.execute(cmd);
    await expect(a.execute(cmd)).rejects.toBeInstanceOf(ConflictError);
    expect((await admin.query(`select open from ${schemaName}.warehouses where id = 1`)).rows[0].open).toBe(false);
    await a.close();
  });
});

describe.skipIf(!DOCKER)('DockerAdapter on a real Docker daemon', () => {
  it('observes real containers and stops/starts one through the lens', async () => {
    const a = new DockerAdapter({});
    await a.connect();
    const snap = await a.snapshot();
    const web = snap.collections.containers.find((c) => c.name === 'iso-web');
    expect(web).toMatchObject({ state: 'running', image: 'busybox:1.36' });
    expect(typeof web!.cpu_percent).toBe('number');
    const id = String(web!.id);
    await a.execute({ op: 'update', collection: 'containers', pk: id, patch: { state: 'exited' }, before: { state: 'running' } });
    const after = (await a.snapshot()).collections.containers.find((c) => c.id === id)!;
    expect(after.state).toBe('exited');
    await a.execute({ op: 'update', collection: 'containers', pk: id, patch: { state: 'running' }, before: { state: 'exited' } });
    expect((await a.snapshot()).collections.containers.find((c) => c.id === id)!.state).toBe('running');
    const r = await compile(attachStats(await a.introspect(), snap), { mode: 'heuristic', numRuns: 40 });
    expect(r.report.ok).toBe(true);
  }, 60_000);
});
