import { describe, expect, it } from 'vitest';
import { attachStats, markSensitive, type Snapshot, type SystemSchema } from '@isomorph/core';
import { buildWorldBundle, IsomorphRuntime } from '../src/index.ts';

const schema: SystemSchema = markSensitive({
  system: 'people',
  source: 'custom',
  constraints: [],
  collections: [{ name: 'users', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'email', type: 'string', nullable: false }, { name: 'plan', type: 'string', nullable: false }] }],
});
const rows = [
  { id: 1, name: 'A', email: 'same@example.com', plan: 'free' },
  { id: 2, name: 'B', email: 'same@example.com', plan: 'pro' },
  { id: 3, name: 'C', email: 'other@example.com', plan: 'free' },
];

describe('shareable snapshot', () => {
  it('never keeps sample values of sensitive fields in schema statistics', () => {
    const s = attachStats(schema, { ts: 0, collections: { users: rows } });
    const email = s.collections[0].fields.find((f) => f.name === 'email')!;
    expect(email.stats?.samples).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('@example.com');
  });

  it('pseudonymises sensitive values: equal stays equal, the real value is gone', async () => {
    let snap: Snapshot = { ts: Date.now(), collections: { users: rows } };
    const adapter = { kind: 'custom' as const, system: 'people', connect: async () => {}, introspect: async () => schema, snapshot: async () => ({ ...snap, ts: Date.now() }), execute: async () => {}, describe: () => '', close: async () => {} };
    const rt = new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 10, compile: { mode: 'heuristic' } });
    await rt.start();
    snap = { ts: Date.now(), collections: { users: [...rows, { id: 4, name: 'D', email: 'new@example.com', plan: 'pro' }] } };
    await rt.refresh();
    const bundle = buildWorldBundle(rt, { minutes: 5 });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain('@example.com');
    const base = bundle.base.collections.users;
    expect(base[0].email).toBe(base[1].email); // 같은 이메일 → 같은 가명(중복 법칙이 그대로 보인다)
    expect(base[0].email).not.toBe(base[2].email);
    expect(String(base[0].email)).toMatch(/^•[0-9a-f]{10}$/);
    expect(bundle.events.some((e) => e.kind === 'insert' && String(e.after?.email).startsWith('•'))).toBe(true);
    expect(bundle.hello.writeMode).toBe('read-only');
    expect(bundle.hello.role).toBe('viewer');
    // 공유본마다 키가 달라 같은 값도 다른 가명이 된다(공유본끼리 맞춰 볼 수 없다)
    expect(buildWorldBundle(rt, { minutes: 5 }).base.collections.users[0].email).not.toBe(base[0].email);
    await rt.stop();
  });
});
