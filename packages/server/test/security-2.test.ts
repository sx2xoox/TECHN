import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachStats, buildInspect, findRevert, markSensitive, observe, type Snapshot, type SystemSchema } from '@isomorph/core';
import { compileHeuristic } from '@isomorph/compiler';
import { attachNotifier, buildWorldBundle, formatPayload, IsomorphRuntime, renderSnapshotHtml, serve, type NotifyItem, type ViolationEvent } from '../src/index.ts';
import { shopSchema, shopSnapshot } from '../../core/test/fixtures.ts';

/**
 * 두 번째 독립 보안 검토(d30699a 이후 추가된 것: 여러 시스템 묶기, Kubernetes 쓰기, 되돌리기, 알림, 바로가기, 공유본)에서 나온 문제의 회귀 시험.
 * Kubernetes 쪽(인증 플러그인, '.'·'..' 이름)은 packages/adapters/test/kubernetes.test.ts 에 있다.
 */
const people: SystemSchema = markSensitive({
  system: 'shop',
  source: 'custom',
  constraints: [],
  collections: [
    { name: 'customers', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'email', type: 'string', nullable: false }] },
    {
      name: 'orders',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'total', type: 'integer', nullable: false },
        { name: 'customer_email', type: 'string', nullable: true, ref: { collection: 'customers', field: 'email' }, refEnforced: false },
      ],
    },
  ],
});
// alice 의 고객 행은 관측 창 밖(지금 보이는 것은 bob 뿐)
const rows = () => ({
  customers: [{ id: 2, name: 'bob', email: 'bob@example.com' }],
  orders: [
    { id: 10, total: 5, customer_email: 'alice.secret@example.com' },
    { id: 11, total: 7, customer_email: 'bob@example.com' },
  ],
});

describe('S2-1 · inspecting does not leak a sensitive reference whose target is outside the window', () => {
  it('drops the related entry instead of showing the raw value', () => {
    const snap: Snapshot = { ts: Date.now(), collections: rows() };
    const schema = attachStats(people, snap);
    const grammar = compileHeuristic(schema);
    const order = observe(snap, grammar, schema).entities.find((e) => e.source.collection === 'orders' && e.source.pk === 10)!;
    const ins = buildInspect({ snapshot: snap, grammar, schema, events: [], entityId: order.id, writeMode: 'read-only', history: false });
    expect(JSON.stringify(ins)).not.toContain('alice.secret@example.com');
  });
});

describe('S2-2 · the shareable file pseudonymises values confirmed outside the window too', () => {
  it('uses the same pseudonym as the rows (so laws still hold), never the raw value', async () => {
    const adapter = {
      kind: 'custom' as const,
      system: 'shop',
      connect: async () => {},
      introspect: async () => people,
      snapshot: async () => ({ ts: Date.now(), collections: rows() }),
      lookup: async (_c: string, _f: string, values: unknown[]) => values.filter((v) => v === 'alice.secret@example.com'),
      execute: async () => {},
      describe: () => '',
      close: async () => {},
    };
    const rt = new IsomorphRuntime({ adapter, pollMs: 100_000, numRuns: 5 });
    await rt.start();
    try {
      const b = buildWorldBundle(rt, { minutes: 1 });
      expect(JSON.stringify(b)).not.toContain('alice.secret@example.com');
      const pseud = b.base.collections.orders.find((o) => o.id === 10)!.customer_email;
      expect(b.base.outside!['customers.email']).toEqual([pseud]);
    } finally {
      await rt.stop();
    }
  });

  it("is not broken by '$' patterns in system data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-viewer-'));
    try {
      fs.writeFileSync(path.join(dir, 'snapshot.html'), '<!doctype html><html><head><title>뷰어</title></head><body></body></html>');
      const bundle = { version: 1, createdAt: 0, hello: { grammar: { title: '$` 마을 $&' } }, schema: {}, base: { ts: 0, collections: { spans: [{ id: 'a', name: "$` $& $$5 $'" }] } }, events: [], start: 0, end: 0, markers: [] } as never;
      const html = renderSnapshotHtml(bundle, dir);
      expect(html.match(/<\/head>/g)).toHaveLength(1);
      const json = /<script id="isomorph-snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
      expect(JSON.parse(json).base.collections.spans[0].name).toBe("$` $& $$5 $'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** 알림만 시험하는 가짜 런타임 */
function fakeRuntime(inspect: (id: string) => unknown) {
  return Object.assign(new EventEmitter(), { schema: { system: 'shop' }, inspect }) as unknown as IsomorphRuntime;
}
const vio = (i: number): ViolationEvent => ({
  phase: 'start',
  ts: 1000 + i,
  initial: false,
  entityId: `orders:${i}`,
  violation: { invariantId: 'x', collection: 'orders', pk: i, title: '법칙', kind: 'glitch', severity: 'warning', proposed: false, values: {} },
});

describe('S2-4 · notifications cannot crash or flood the server', () => {
  it('rejects a bad webhook or public URL without echoing the secret address', () => {
    const rt = fakeRuntime(() => ({}));
    expect(() => attachNotifier(rt, { webhook: 'hooks.slack.com/services/T0/B0/SECRET123' })).toThrow(/올바른 주소/);
    try {
      attachNotifier(rt, { webhook: 'hooks.slack.com/services/T0/B0/SECRET123' });
    } catch (e) {
      expect(String(e)).not.toContain('SECRET123');
      expect(JSON.stringify(e)).not.toContain('SECRET123');
    }
    expect(() => attachNotifier(rt, { webhook: 'https://example.com/h', publicUrl: 'isomorph.example.com' })).toThrow(/공개 주소/);
  });

  it('survives an exception while preparing a message', async () => {
    const logs: string[] = [];
    const rt = fakeRuntime(() => {
      throw new Error('boom');
    });
    const n = attachNotifier(rt, { webhook: 'https://example.com/h', batchMs: 5, log: (m) => logs.push(m), fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch });
    rt.emit('violation', vio(1));
    await n.flush();
    expect(n.stats.failed).toBe(1);
    expect(logs.join('\n')).toContain('알림 준비 실패');
  });

  it('caps one message at 20 items and inspects only those', async () => {
    let inspected = 0;
    const bodies: { items: NotifyItem[]; more?: number; text: string }[] = [];
    const rt = fakeRuntime(() => (inspected++, { diagnosis: null, chain: [] }));
    const n = attachNotifier(rt, {
      webhook: 'https://example.com/h',
      batchMs: 50,
      fetchImpl: (async (_u: unknown, init: { body: string }) => (bodies.push(JSON.parse(init.body)), new Response(null, { status: 204 }))) as unknown as typeof fetch,
    });
    for (let i = 0; i < 1000; i++) rt.emit('violation', vio(i));
    await n.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].items).toHaveLength(20);
    expect(bodies[0].more).toBe(980);
    expect(bodies[0].text).toContain('그 밖에 980건');
    expect(inspected).toBeLessThanOrEqual(40);
  });
});

describe('S2-5 · data cannot become links or formatting in Discord', () => {
  it('escapes markdown that came from the system', () => {
    const item: NotifyItem = { phase: 'start', at: 1, title: '[Fix here](https://evil.example) **now**', severity: 'warning', collection: 'services', pk: '`x`', entityId: null, values: {}, diagnosis: null, link: null, root: null, change: null };
    const d = formatPayload('discord', { system: 'shop', text: '', items: [item] }) as { content: string };
    expect(d.content).toContain('\\[Fix here\\]\\(https://evil.example\\) \\*\\*now\\*\\*');
    expect(d.content).toContain('\\`x\\`');
  });
});

describe('S2-8 · a revert never rewinds bookkeeping (timestamps, version counters)', () => {
  it('proposes only the real change', () => {
    const schema: SystemSchema = {
      system: 's',
      source: 'custom',
      constraints: [],
      collections: [
        {
          name: 'cfg',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'integer', nullable: false },
            { name: 'limit', type: 'integer', nullable: false },
            { name: 'mode', type: 'string', nullable: false },
            { name: 'version', type: 'integer', nullable: false },
            { name: 'updated_at', type: 'timestamp', nullable: false },
          ],
        },
      ],
    };
    const inv = { id: 'l', collection: 'cfg', title: '한도 > 0', expr: { op: 'cmp' as const, field: 'limit', cmp: '>' as const, value: 0 }, anomaly: 'glitch' as const, source: 'schema' as const, status: 'confirmed' as const, severity: 'warning' as const };
    const r0 = { id: 1, limit: 5, mode: 'safe', version: 3, updated_at: '2026-01-01T00:00:00Z' };
    const r1 = { ...r0, mode: 'fast', version: 4, updated_at: '2026-01-01T00:01:00Z' };
    const r2 = { ...r1, limit: 0, version: 5, updated_at: '2026-01-01T00:02:00Z' };
    const ev = [
      { ts: 1000, collection: 'cfg', pk: 1, kind: 'update' as const, before: r0, after: r1 },
      { ts: 2000, collection: 'cfg', pk: 1, kind: 'update' as const, before: r1, after: r2 },
    ];
    const v = { invariantId: 'l', collection: 'cfg', pk: 1, title: 't', kind: 'glitch', severity: 'warning', proposed: false, values: {} } as never;
    // 법칙의 필드(limit)도, 버전·시각도 아닌 진짜 변경(mode)만
    const r = findRevert(v, ev, schema, inv, r2)!;
    expect(r.changes.map((c) => c.field)).toEqual(['mode']);
  });
});

describe('S2-9 · inspecting is rate-limited per connection', () => {
  it('answers at most 20 inspections per second', async () => {
    const adapter = {
      kind: 'custom' as const,
      system: 'shop',
      connect: async () => {},
      introspect: async () => shopSchema,
      snapshot: async () => ({ ...shopSnapshot(), ts: Date.now() }),
      execute: async () => {},
      describe: () => '',
      close: async () => {},
    };
    const rt = new IsomorphRuntime({ adapter, pollMs: 100_000, numRuns: 5, compile: { mode: 'heuristic' } });
    await rt.start();
    const srv = await serve(rt, { port: 0 });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      await new Promise((r) => ws.on('open', r));
      let answers = 0;
      ws.on('message', (d) => JSON.parse(String(d)).type === 'inspect' && answers++);
      const id = rt.world!.entities[0].id;
      for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'inspect', entityId: id }));
      await new Promise((r) => setTimeout(r, 400));
      expect(answers).toBeGreaterThan(0);
      expect(answers).toBeLessThanOrEqual(20);
      ws.close();
    } finally {
      await srv.close();
      await rt.stop();
    }
  });
});
