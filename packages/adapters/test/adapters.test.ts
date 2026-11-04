import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachStats } from '@isomorph/core';
import { compile } from '@isomorph/compiler';
import { startShop, type ShopHandle } from '@isomorph/demo-shop';
import { ConflictError, DockerAdapter, HttpJsonAdapter, inferCollection, inferRefs, parseCheck, PostgresAdapter } from '../src/index.ts';

let shop: ShopHandle;
const PG_PORT = 55400 + Math.floor(Math.random() * 500);

beforeAll(async () => {
  shop = await startShop({ httpPort: 0, pgPort: PG_PORT, traffic: false, shop: { paymentMs: [80, 100], paymentFailureRate: 0 } });
});
afterAll(async () => {
  await shop?.stop();
});

describe('PostgresAdapter', () => {
  it('introspects tables, keys, enums, CHECK constraints and name-inferred refs over the wire protocol', async () => {
    const a = new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop' });
    await a.connect();
    const schema = await a.introspect();
    const names = schema.collections.map((c) => c.name).sort();
    expect(names).toEqual(['customers', 'orders', 'products', 'shop_stats']);
    const orders = schema.collections.find((c) => c.name === 'orders')!;
    expect(orders.primaryKey).toBe('id');
    expect(orders.fields.find((f) => f.name === 'customer_id')).toMatchObject({ ref: { collection: 'customers', field: 'id' }, refEnforced: true });
    expect(orders.fields.find((f) => f.name === 'product_id')).toMatchObject({ ref: { collection: 'products', field: 'id' }, refEnforced: false });
    expect(orders.fields.find((f) => f.name === 'status')).toMatchObject({ type: 'string', enumValues: ['pending', 'paid', 'failed', 'rejected', 'cancelled'] });
    expect(orders.fields.find((f) => f.name === 'created_at')!.type).toBe('timestamp');
    const customers = schema.collections.find((c) => c.name === 'customers')!;
    expect(customers.fields.find((f) => f.name === 'email')!.sensitive).toBe(true);
    expect(schema.constraints).toEqual([{ collection: 'products', expr: { op: 'cmp', field: 'price', cmp: '>=', value: 0 }, description: 'CHECK ((price >= 0))', enforced: true }]);

    const snap = await a.snapshot();
    expect(snap.collections.products).toHaveLength(8);
    expect(typeof snap.collections.shop_stats[0].avg_latency_ms).toBe('number');
    expect(String(snap.collections.customers[0].created_at)).toMatch(/Z$/);

    // 스키마 + 표본 → 검증된 세계
    const r = await compile(attachStats(schema, snap), { mode: 'heuristic', numRuns: 40 });
    expect(r.report.ok).toBe(true);
    expect(r.grammar.invariants.map((i) => i.id)).toEqual(expect.arrayContaining(['nonneg_products_stock', 'ref_orders_product_id']));
    // DB 가 CHECK 로 강제하는 price ≥ 0 은 추정 법칙으로 중복 제안하지 않는다
    expect(r.grammar.invariants.map((i) => i.id)).not.toContain('nonneg_products_price');
    await a.close();
  });

  it('executes guarded updates and detects conflicts (optimistic concurrency)', async () => {
    const a = new PostgresAdapter({ queryable: shop.db, system: 'demo-shop' });
    await a.connect();
    await a.introspect();
    const cmd = { op: 'update' as const, collection: 'products', pk: 1, patch: { active: false }, before: { active: true } };
    expect(a.describe(cmd)).toBe('UPDATE "products" SET "active" = false WHERE "id" = 1 AND "active" IS NOT DISTINCT FROM true;');
    await a.execute(cmd);
    expect((await shop.db.query<{ active: boolean }>('select active from products where id = 1')).rows[0].active).toBe(false);
    await expect(a.execute(cmd)).rejects.toBeInstanceOf(ConflictError); // 이미 false → before 불일치
    await a.execute({ ...cmd, patch: { active: true }, before: { active: false } });
    await expect(a.execute({ ...cmd, collection: 'products; drop table x' })).rejects.toThrow('알 수 없는 테이블');
  });

  it('parses simple CHECK constraints', () => {
    expect(parseCheck('CHECK ((stock >= 0))')).toEqual({ op: 'cmp', field: 'stock', cmp: '>=', value: 0 });
    expect(parseCheck('CHECK ((qty < 100))')).toEqual({ op: 'cmp', field: 'qty', cmp: '<', value: 100 });
    expect(parseCheck("CHECK ((kind <> 'x'::text))")).toEqual({ op: 'cmp', field: 'kind', cmp: '!=', value: 'x' });
    expect(parseCheck('CHECK ((a > b) AND (c > 0))')).toBeNull();
  });
});

describe('HttpJsonAdapter', () => {
  it('infers a schema from samples and writes with PATCH', async () => {
    const a = new HttpJsonAdapter({
      system: 'demo-shop-http',
      baseUrl: shop.httpUrl,
      collections: [
        { name: 'customers', path: '/api/customers' },
        { name: 'products', path: '/api/products', update: { path: '/api/products/:id' } },
        { name: 'orders', path: '/api/orders' },
        { name: 'shop_stats', path: '/api/shop_stats' },
      ],
    });
    const schema = await a.introspect();
    const products = schema.collections.find((c) => c.name === 'products')!;
    expect(products.fields.map((f) => [f.name, f.type])).toEqual([
      ['id', 'integer'],
      ['name', 'string'],
      ['price', 'integer'],
      ['stock', 'integer'],
      ['active', 'boolean'],
    ]);
    const cmd = { op: 'update' as const, collection: 'products', pk: 2, patch: { stock: 99 }, before: { stock: 12 } };
    expect(a.describe(cmd)).toBe('PATCH /api/products/2 {"stock":99}');
    await a.execute(cmd);
    const snap = await a.snapshot();
    expect(snap.collections.products.find((p) => p.id === 2)!.stock).toBe(99);
    await expect(a.execute(cmd)).rejects.toBeInstanceOf(ConflictError);
    await expect(a.execute({ ...cmd, collection: 'customers', pk: 1 })).rejects.toThrow('쓰기 경로');
    await a.execute({ ...cmd, patch: { stock: 12 }, before: { stock: 99 } });
  });

  it('infers refs from naming conventions', () => {
    const cols = inferRefs([
      inferCollection('users', [{ id: 1, name: 'a' }]),
      inferCollection('categories', [{ id: 1 }]),
      inferCollection('posts', [{ id: 1, user_id: 1, categoryId: 1, created_at: '2026-01-01T00:00:00Z', meta: { a: 1 } }]),
    ]);
    const posts = cols[2];
    expect(posts.fields.find((f) => f.name === 'user_id')!.ref).toEqual({ collection: 'users', field: 'id' });
    expect(posts.fields.find((f) => f.name === 'categoryId')!.ref).toEqual({ collection: 'categories', field: 'id' });
    expect(posts.fields.find((f) => f.name === 'created_at')!.type).toBe('timestamp');
    expect(posts.fields.find((f) => f.name === 'meta')!.type).toBe('json');
  });
});

describe('DockerAdapter (mock Engine API over a unix socket)', () => {
  let server: http.Server;
  let socketPath: string;
  const calls: string[] = [];
  const containers = [
    { Id: 'aaaaaaaaaaaa1111', Names: ['/web'], Image: 'nginx:1.27', State: 'running', Status: 'Up 3 minutes', Created: 1_700_000_000 },
    { Id: 'bbbbbbbbbbbb2222', Names: ['/worker'], Image: 'app:2', State: 'exited', Status: 'Exited (1)', Created: 1_700_000_100 },
  ];
  beforeAll(async () => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-docker-')), 'docker.sock');
    server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/_ping') return res.end('OK');
      if (req.url === '/containers/json?all=1') return res.end(JSON.stringify(containers));
      const m = /^\/containers\/(\w+)\/(json|stats\?stream=false|start|stop|pause|unpause)$/.exec(req.url ?? '');
      if (m && m[2] === 'json') return res.end(JSON.stringify({ RestartCount: m[1].startsWith('b') ? 4 : 0 }));
      if (m && m[2].startsWith('stats')) {
        return res.end(JSON.stringify({ cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 20000, online_cpus: 2 }, precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 }, memory_stats: { usage: 64 * 1048576 } }));
      }
      if (m) {
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
  });
  afterAll(() => server.close());

  it('reads containers with stats and maps state changes to Engine actions', async () => {
    const a = new DockerAdapter({ socketPath });
    await a.connect();
    const snap = await a.snapshot();
    expect(snap.collections.containers).toEqual([
      expect.objectContaining({ id: 'aaaaaaaaaaaa', name: 'web', state: 'running', cpu_percent: 20, mem_mb: 64, restart_count: 0 }),
      expect.objectContaining({ id: 'bbbbbbbbbbbb', name: 'worker', state: 'exited', cpu_percent: null, restart_count: 4 }),
    ]);
    const stop = { op: 'update' as const, collection: 'containers', pk: 'aaaaaaaaaaaa', patch: { state: 'exited' }, before: { state: 'running' } };
    expect(a.describe(stop)).toBe('POST /containers/aaaaaaaaaaaa/stop');
    await a.execute(stop);
    await a.execute({ ...stop, patch: { state: 'running' }, before: { state: 'paused' } });
    expect(calls).toEqual(expect.arrayContaining(['POST /containers/aaaaaaaaaaaa/stop', 'POST /containers/aaaaaaaaaaaa/unpause']));
    expect(() => a.describe({ ...stop, patch: { name: 'x' } })).toThrow('state 만');
    const r = await compile(await a.introspect(), { mode: 'heuristic', numRuns: 30 });
    expect(r.report.ok).toBe(true);
  });
});

describe('demo shop race condition', () => {
  it('lets a flash sale drive stock negative (the planted bug)', async () => {
    const r = await shop.traffic.flashSale(3);
    expect(r!.orders.filter((o) => o.status === 'paid').length).toBe(4);
    const stock = (await shop.db.query<{ stock: number }>('select stock from products where id = 3')).rows[0].stock;
    expect(stock).toBe(-2);
  });

  it('does not go negative once the bug is fixed', async () => {
    shop.shop.fixed = true;
    await shop.traffic.flashSale(4);
    const stock = (await shop.db.query<{ stock: number }>('select stock from products where id = 4')).rows[0].stock;
    expect(stock).toBe(0);
    shop.shop.fixed = false;
  });
});
