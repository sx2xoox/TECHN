import { describe, expect, it } from 'vitest';
import type { Row, SystemSchema, UpdateCommand } from '@isomorph/core';
import { CompositeAdapter, defineAdapter, UnsupportedCommandError } from '../src/index.ts';

/** 여러 시스템을 한 세계로: 이름 붙이기, 시스템 사이 연결, 경로 나누기 */
const services: Row[] = [
  { id: 'web', status: 'healthy' },
  { id: 'payments', status: 'failing' },
];
const deployments: Row[] = [
  { id: 'default/web', name: 'web', ready: 2 },
  { id: 'shop/payments', name: 'payments', ready: 0 },
  { id: 'shop/batch', name: 'batch', ready: 1 }, // 트레이스를 보내지 않는 앱
];
const otelSchema: SystemSchema = {
  system: 'otel',
  source: 'custom',
  constraints: [{ collection: 'services', expr: { op: 'cmp', field: 'status', cmp: '!=', value: 'failing' }, description: '실패 상태면 안 됨', enforced: false }],
  collections: [
    { name: 'services', primaryKey: 'id', fields: [{ name: 'id', type: 'string', nullable: false, joinKey: 'service' }, { name: 'status', type: 'string', nullable: false }] },
    { name: 'spans', primaryKey: 'id', fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'service_id', type: 'string', nullable: false, ref: { collection: 'services', field: 'id' } }] },
  ],
};
const k8sSchema: SystemSchema = {
  system: 'k8s',
  source: 'custom',
  constraints: [],
  collections: [{ name: 'deployments', primaryKey: 'id', fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'name', type: 'string', nullable: false, joinKey: 'service' }, { name: 'ready', type: 'integer', nullable: false }] }],
};

function make(opts: { links?: { from: string; to: string }[]; autoLink?: boolean } = {}) {
  const writes: UpdateCommand[] = [];
  let k8sWatch: ((c: string[]) => void) | undefined;
  let otelWatch: ((c: string[]) => void) | undefined;
  const otel = defineAdapter({
    system: 'otel',
    schema: otelSchema,
    read: async () => ({ services, spans: [{ id: 's1', service_id: 'payments' }] }),
    watch: async (on) => {
      otelWatch = on;
      return async () => {};
    },
  });
  const k8s = defineAdapter({
    system: 'k8s',
    schema: k8sSchema,
    read: async () => ({ deployments }),
    write: async (c) => void writes.push(c),
    describe: (c) => `kubectl scale ${c.pk}`,
    watch: async (on) => {
      k8sWatch = on;
      return async () => {};
    },
  });
  const a = new CompositeAdapter({ parts: [{ name: 'otel', adapter: otel }, { name: 'k8s', adapter: k8s }], ...opts });
  return { a, writes, fire: (c: string[]) => k8sWatch!(c), fireOtel: (c: string[]) => otelWatch!(c) };
}

describe('CompositeAdapter', () => {
  it('prefixes every collection and keeps each system’s refs and laws', async () => {
    const { a } = make();
    const s = await a.introspect();
    expect(s.collections.map((c) => c.name)).toEqual(['otel_services', 'otel_spans', 'k8s_deployments']);
    expect(s.collections[1].fields.find((f) => f.name === 'service_id')!.ref).toEqual({ collection: 'otel_services', field: 'id' });
    expect(s.constraints[0].collection).toBe('otel_services');
  });

  it('links systems that share a naming scheme, pointing at the side whose key is unique', async () => {
    const { a } = make();
    const s = await a.introspect();
    const link = s.collections.find((c) => c.name === 'k8s_deployments')!.fields.find((f) => f.name === 'otel_services_id')!;
    expect(link).toMatchObject({ ref: { collection: 'otel_services', field: 'id', crossSystem: true }, readOnly: true });
    expect(s.collections.find((c) => c.name === 'otel_services')!.fields.some((f) => f.ref)).toBe(false); // 한 방향만
    const snap = await a.snapshot();
    expect(snap.collections.k8s_deployments.map((d) => d.otel_services_id)).toEqual(['web', 'payments', null]); // 없는 상대는 null(거짓 경보 없음)
  });

  it('can be told explicitly, maps through non-key fields, and refuses ambiguous matches', async () => {
    const { a } = make({ autoLink: false, links: [{ from: 'otel.services.id', to: 'k8s.deployments.name' }] });
    const s = await a.introspect();
    expect(s.collections.find((c) => c.name === 'otel_services')!.fields.find((f) => f.name === 'k8s_deployments_id')!.ref).toMatchObject({ collection: 'k8s_deployments', field: 'id' });
    deployments.push({ id: 'other/web', name: 'web', ready: 1 }); // 같은 이름이 두 네임스페이스에
    try {
      const snap = await a.snapshot();
      expect(snap.collections.otel_services.map((r) => r.k8s_deployments_id)).toEqual([null, 'shop/payments']);
    } finally {
      deployments.pop();
    }
    expect(() => new CompositeAdapter({ parts: [{ name: 'x', adapter: make().a }], links: [] })).not.toThrow();
    await expect(make({ links: [{ from: 'otel.nope.id', to: 'k8s.deployments.name' }] }).a.introspect()).rejects.toThrow(/연결을 찾을 수 없습니다/);
  });

  it('routes writes to the owning system and never lets a write touch a link', async () => {
    const { a, writes } = make();
    await a.introspect();
    const cmd: UpdateCommand = { op: 'update', collection: 'k8s_deployments', pk: 'shop/payments', patch: { ready: 2 }, before: { ready: 0 } };
    expect(a.describe(cmd)).toBe('[k8s] kubectl scale shop/payments');
    await a.execute(cmd);
    expect(writes).toEqual([{ ...cmd, collection: 'deployments' }]);
    await expect(a.execute({ ...cmd, patch: { otel_services_id: 'web' } })).rejects.toBeInstanceOf(UnsupportedCommandError);
    await expect(a.execute({ op: 'update', collection: 'otel_services', pk: 'web', patch: { status: 'x' }, before: {} })).rejects.toThrow(/읽기 전용/);
  });

  it('reads only what was asked, still filling links from the last view of the other side', async () => {
    const { a } = make();
    await a.introspect();
    await a.snapshot();
    const part = await a.snapshot(['k8s_deployments']);
    expect(Object.keys(part.collections)).toEqual(['k8s_deployments']);
    expect(part.collections.k8s_deployments[1].otel_services_id).toBe('payments');
  });

  it('forwards push notifications with prefixes, and re-reads link holders when a target changes', async () => {
    const { a, fire, fireOtel } = make();
    await a.introspect();
    const seen: string[][] = [];
    const stop = await a.watch((c) => seen.push(c));
    fire(['deployments']);
    expect(seen).toEqual([['k8s_deployments']]);
    fireOtel(['services']); // 새 서비스가 나타나면 디플로이먼트의 연결 값도 다시 계산해야 한다
    expect(seen[1].sort()).toEqual(['k8s_deployments', 'otel_services']);
    expect(stop).not.toBeNull();
  });

  it('rejects bad or duplicate system names', () => {
    const { a } = make();
    expect(() => new CompositeAdapter({ parts: [{ name: 'K8S', adapter: a }] })).toThrow(/소문자/);
    expect(() => new CompositeAdapter({ parts: [{ name: 'a', adapter: a }, { name: 'a', adapter: a }] })).toThrow(/겹칩니다/);
  });
});
