import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HttpJsonAdapter, OtelAdapter } from '@isomorph/adapters';
import { evaluateInvariants, findCauses, learnModel, markSensitive, sanitizeHypothesis, simulate, type Hypothesis, type SystemSchema, type WorldGrammar } from '@isomorph/core';
import { compileHeuristic } from '@isomorph/compiler';
import { isLoopback, IsomorphRuntime, readStudyRecords, redact, serve, startStudyServer, studyCsv } from '../src/index.ts';
import { shopSchema, shopSnapshot } from '../../core/test/fixtures.ts';

/** 보안 검토에서 나온 문제마다 하나씩: 다시 생기면 여기서 걸린다 */

const people: SystemSchema = markSensitive({
  system: 'people',
  source: 'postgres',
  constraints: [],
  collections: [
    { name: 'users', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'email', type: 'string', nullable: false }, { name: 'password', type: 'string', nullable: false }] },
  ],
});

describe('H1 · a hypothesis cannot exhaust the server', () => {
  const abusive = { id: 'x', title: 'x', description: '', horizonMs: 1000, changes: Array.from({ length: 20 }, () => ({ kind: 'rate', collection: 'orders', factor: 20 })) } as Hypothesis;

  it('merges repeated rate changes and caps the product', () => {
    const h = sanitizeHypothesis(abusive, shopSchema);
    expect(h.changes).toEqual([{ kind: 'rate', collection: 'orders', factor: 20 }]);
    const patch = sanitizeHypothesis({ ...abusive, changes: [{ kind: 'set', collection: 'products', pk: 1, patch: { stock: 2, evil: 1, name: { $gt: '' } } as never }] }, shopSchema);
    expect(patch.changes).toEqual([{ kind: 'set', collection: 'products', pk: 1, patch: { stock: 2 } }]);
  });

  it('finishes quickly even if an unsanitized hypothesis reaches the simulator', () => {
    const g = compileHeuristic(shopSchema);
    const model = learnModel(shopSnapshot(), [], shopSchema);
    model.rates = [{ collection: 'orders', perMinute: 600, samples: 10, targets: {}, template: shopSnapshot().collections.orders[0] }];
    const started = Date.now();
    const r = simulate(shopSnapshot(), model, { ...abusive, horizonMs: 60_000 }, g, shopSchema, { runs: 2 });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.runs).toBe(2);
  }, 30_000);
});

describe('H2 · sensitive fields never leave the server', () => {
  const row = { id: 7, name: 'Kim', email: 'kim@example.com', password: 'hunter2' };
  it('masks them in the learned model, violation values and cause summaries', () => {
    const t0 = Date.now();
    const events = [1, 2, 3, 4, 5, 6].map((i) => ({ ts: t0 + i * 1000, collection: 'users', pk: i, kind: 'insert' as const, before: null, after: { ...row, id: i } }));
    const model = learnModel({ ts: t0, collections: { users: [] } }, events, people);
    const template = JSON.stringify(model.rates[0]?.template ?? {});
    expect(template).not.toContain('kim@example.com');
    expect(template).not.toContain('hunter2');

    const g: WorldGrammar = { ...compileHeuristic(people), invariants: [{ id: 'u', collection: 'users', title: 'email 은 하나뿐', expr: { op: 'unique', field: 'email' }, anomaly: 'doppelganger', source: 'user', status: 'confirmed', severity: 'warning' }] };
    const v = evaluateInvariants({ ts: t0, collections: { users: [row, { ...row, id: 8 }] } }, g, people);
    expect(JSON.stringify(v)).not.toContain('kim@example.com');

    const causes = findCauses(v[0], [{ ts: t0, collection: 'users', pk: 7, kind: 'update', before: { ...row, password: 'old' }, after: row }, events[0]], people, 60_000);
    const text = causes.map((c) => c.summary).join(' | ');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('kim@example.com');
    expect(text).toContain('password: (가림) 바뀜');
  });
});

describe('H3 / L3 / L4 · local-only worlds and redirects', () => {
  const adapter = { kind: 'custom' as const, system: 's', connect: async () => {}, introspect: async () => shopSchema, snapshot: async () => shopSnapshot(), execute: async () => {}, describe: () => '', close: async () => {} };
  const get = (port: number, p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; location?: string }>((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => (res.resume(), resolve({ status: res.statusCode ?? 0, location: res.headers.location }))));

  it('refuses requests whose Host is not a local name when no token is set (DNS rebinding)', async () => {
    const rt = new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 10, compile: { mode: 'heuristic' } });
    await rt.start();
    const srv = await serve(rt, { port: 0 });
    try {
      expect((await get(srv.port, '/api/hello', { host: 'evil.example:4000' })).status).toBe(403);
      expect((await get(srv.port, '/api/hello', { host: `127.0.0.1:${srv.port}` })).status).toBe(200);
      expect((await get(srv.port, '/api/hello', { host: `localhost:${srv.port}` })).status).toBe(200);
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { host: 'evil.example:4000', origin: 'http://evil.example:4000' } });
      const code = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)).on('open', () => resolve(101)));
      expect(code).toBe(403);
    } finally {
      await srv.close();
      await rt.stop();
    }
  });

  it('never redirects to another site after moving the token to a cookie', async () => {
    const rt = new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 10, compile: { mode: 'heuristic' } });
    const srv = await serve(rt, { port: 0, token: 'op' });
    try {
      const r = await get(srv.port, '/.//evil.com/x?token=op');
      expect(r.status).toBe(302);
      expect(r.location!.startsWith('//')).toBe(false);
      expect(r.location!.startsWith('/')).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('treats an empty host as "all interfaces", not loopback', async () => {
    expect(isLoopback(undefined)).toBe(true);
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback('127.0.0.1.evil.example')).toBe(false);
    const rt = new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 10 });
    await expect(serve(rt, { port: 0, host: '' })).rejects.toThrow(/토큰/);
  });
});

describe('M1 / L1 / L2 · study server', () => {
  async function study() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-sec-'));
    const srv = await startStudyServer({ port: 0, staticDir: dataDir, dataDir, conditions: ['world', 'table'] });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { srv, dataDir, base, post, done: async () => (await srv.close(), fs.rmSync(dataDir, { recursive: true, force: true })) };
  }

  it('stops reading an oversized body and keeps serving', async () => {
    const t = await study();
    try {
      const r = await post2(t.srv.port, 'x'.repeat(400_000)).catch(() => 0);
      expect([0, 500]).toContain(r);
      expect((await t.post('/api/study/session', { developer: 'none' })).status).toBe(200);
    } finally {
      await t.done();
    }
    function post2(port: number, body: string) {
      return new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/study/session', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on('error', reject);
        req.end(body);
      });
    }
  });

  it('limits fields, answers each questionnaire once, neutralises spreadsheet formulas and hides answers', async () => {
    const t = await study();
    try {
      const info = (await (await t.post('/api/study/session', { developer: '=HYPERLINK("http://evil")' + 'x'.repeat(500) })).json()) as { session: string; total: number };
      expect((await t.post('/api/study/questionnaire', { session: info.session, condition: 'world', effort: 3, confidence: 3 })).status).toBe(200);
      expect((await t.post('/api/study/questionnaire', { session: info.session, condition: 'world', effort: 3, confidence: 3 })).status).toBe(409);
      const recs = readStudyRecords(t.dataDir);
      const dev = (recs.find((r) => r.type === 'session') as { background: { developer: string } }).background.developer;
      expect(dev.length).toBeLessThanOrEqual(20);
      for (let key = 0; key < info.total; key++) await t.post('/api/study/answer', { session: info.session, key, answer: null, choice: 'none', timeMs: 1000 });
      await t.post('/api/study/questionnaire', { session: info.session, condition: 'final', final: true });
      const csv = studyCsv(readStudyRecords(t.dataDir));
      expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
      expect(csv).toContain("'=HYPERLINK");
      // 정답이 적힌 위반 목록은 보내지 않는다. 표 조건에는 세계 자체를 보내지 않는다.
      const trials = await Promise.all(Array.from({ length: info.total }, (_, key) => fetch(`${t.base}/api/study/trial?session=${info.session}&key=${key}`).then((r) => r.json() as Promise<{ condition: string; world: { violations: unknown[] } | null }>)));
      for (const tr of trials) {
        if (tr.condition === 'world') expect(tr.world!.violations).toEqual([]);
        else expect(tr.world).toBeNull();
      }
    } finally {
      await t.done();
    }
  });
});

describe('M2 · OTLP receiver', () => {
  it('needs an ingest token off-loopback, checks it, accepts only application/json and bounds services', async () => {
    await expect(new OtelAdapter({ port: 0, host: '0.0.0.0' }).connect()).rejects.toThrow(/수신 토큰/);
    const a = new OtelAdapter({ port: 0, token: 'ingest', maxServices: 50 });
    await a.connect();
    try {
      const body = (n: number) => JSON.stringify({ resourceSpans: Array.from({ length: n }, (_, i) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: `svc-${i}` } }] }, scopeSpans: [{ spans: [{ traceId: 't', spanId: `s${i}`, name: 'x', startTimeUnixNano: '1', endTimeUnixNano: '2' }] }] })) });
      expect((await fetch(a.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(1) })).status).toBe(401);
      expect((await fetch(a.endpoint, { method: 'POST', headers: { 'content-type': 'text/plain;x=json', authorization: 'Bearer ingest' }, body: body(1) })).status).toBe(415);
      expect((await fetch(a.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ingest' }, body: body(300) })).status).toBe(200);
      expect((await a.snapshot()).collections.services.length).toBeLessThanOrEqual(50);
    } finally {
      await a.close();
    }
  });
});

describe('L5 / L6 · adapters and error text', () => {
  it('refuses write paths that would climb out of the resource (pk ".." )', () => {
    const a = new HttpJsonAdapter({ system: 'x', baseUrl: 'http://127.0.0.1:1', collections: [{ name: 'items', path: '/api/items', update: { path: '/api/items/:id' } }] });
    expect(() => a.describe({ op: 'update', collection: 'items', pk: '..', patch: { a: 1 }, before: {} })).toThrow(/안전한 쓰기 경로/);
    expect(a.describe({ op: 'update', collection: 'items', pk: 'a/b', patch: { a: 1 }, before: {} })).toContain('/api/items/a%2Fb');
  });

  it('removes credentials and query strings from messages shown to every client', () => {
    const m = redact('GET https://api.example.com/items?api_key=SECRET123 → 500; db postgres://app:pa55word@db:5432/x failed');
    expect(m).not.toContain('SECRET123');
    expect(m).not.toContain('pa55word');
    expect(m).toContain('https://api.example.com/items?…');
  });
});
