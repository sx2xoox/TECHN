import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompositeAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { startFakeKube, type FakeKube } from '../../adapters/test/fake-kube.ts';
import { startTwoServices, type TwoServices } from '../../../examples/otel/two-services.ts';
import { IsomorphRuntime } from '../src/index.ts';

/**
 * 한 세계에 클러스터(Kubernetes)와 서비스(진짜 OpenTelemetry SDK 트레이스)를 함께.
 * 디플로이먼트 이름과 service.name 이 같은 체계라 자동으로 이어지고,
 * payments 의 파드가 먼저 쓰러진 뒤 payments 서비스가 실패하면 진단이 클러스터 쪽을 가리켜야 한다.
 */
let kube: FakeKube;
let otel: OtelAdapter;
let healthy: TwoServices;
let rt: IsomorphRuntime;
const tick = async () => {
  await new Promise((r) => setTimeout(r, 5));
  await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
};

beforeAll(async () => {
  kube = await startFakeKube();
  kube.addDeployment('payments', 'shop', 2);
  otel = new OtelAdapter({ port: 0 });
  await otel.connect();
  healthy = await startTwoServices({ endpoint: otel.endpoint, failRate: 0 });
  await healthy.hit(8);
  await healthy.close();
  const adapter = new CompositeAdapter({
    parts: [
      { name: 'k8s', adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }) },
      { name: 'otel', adapter: otel },
    ],
  });
  rt = new IsomorphRuntime({ adapter, writeMode: 'low', pollMs: 60_000, numRuns: 40, compile: { mode: 'heuristic' } });
  expect(await rt.start()).toBe('running');
}, 30_000);

afterAll(async () => {
  await rt?.stop();
  await kube?.close();
});

const viol = (collection: string, pk: string) => rt.world!.violations.filter((v) => v.collection === collection && String(v.pk) === pk);

describe('one world for the cluster and its services', () => {
  it('compiles one lawful world with both systems and links them by name', () => {
    expect(rt.report!.ok).toBe(true);
    const cols = rt.schema!.collections.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['k8s_nodes', 'k8s_deployments', 'k8s_pods', 'otel_services', 'otel_spans']));
    const link = rt.schema!.collections.find((c) => c.name === 'k8s_deployments')!.fields.find((f) => f.ref?.crossSystem)!;
    expect(link.ref).toEqual({ collection: 'otel_services', field: 'id', crossSystem: true });
    const deps = Object.fromEntries(rt.lastSnapshot!.collections.k8s_deployments.map((d) => [d.id, d[link.name]]));
    expect(deps).toMatchObject({ 'default/web': 'web', 'shop/payments': 'payments', 'shop/api': null });
    // 연결이 없는 쪽에 '대상 없음' 거짓 경보가 생기지 않는다
    expect(rt.world!.violations.filter((v) => v.kind === 'orphan')).toEqual([]);
  });

  it('shows what is linked across systems when you inspect either side', () => {
    const svc = rt.inspect('otel_services:payments');
    expect(svc.related!.find((r) => r.crossSystem)).toMatchObject({ collection: 'k8s_deployments', pk: 'shop/payments', direction: 'from', entityId: 'k8s_deployments:shop/payments' });
    // 오가는 스팬은 하나하나 늘어놓지 않고 수로만(목록이 계속 바뀌면 누를 수 없다)
    expect(svc.related!.some((r) => r.collection === 'otel_spans')).toBe(false);
    expect(svc.relatedMore).toBeGreaterThan(0);
    const dep = rt.inspect('k8s_deployments:shop/payments');
    expect(dep.related!.find((r) => r.crossSystem)).toMatchObject({ collection: 'otel_services', pk: 'payments', direction: 'to' });
    expect(dep.related!.filter((r) => r.collection === 'k8s_pods')).toHaveLength(2);
  });

  it('traces a failing service back to its deployment that broke first, in the other system', async () => {
    // 1) payments 의 파드가 모두 준비 상태를 잃는다(클러스터)
    kube.setReady('shop/payments', 0);
    await tick();
    expect(viol('k8s_deployments', 'shop/payments').length).toBe(1);
    // 2) 그 뒤 payments 호출이 실패하기 시작한다(서비스)
    const broken = await startTwoServices({ endpoint: otel.endpoint, failRate: 1 });
    await broken.hit(24);
    await broken.close();
    await tick();
    expect(viol('otel_services', 'payments').map((v) => v.title)).toEqual(['서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태)']);
    const d = rt.inspect('otel_services:payments').diagnosis!;
    expect(d.pattern).toBe('linked');
    expect(d.title).toBe('다른 시스템의 연결된 곳이 먼저 법칙을 어김');
    expect(d.detail).toContain('k8s_deployments #shop/payments');
    expect(d.detail).toContain('준비된 복제본 수가 원하는 수에 닿아야 함');
    // 반대로, 디플로이먼트의 진단은 나중에 실패한 서비스를 원인으로 삼지 않는다
    expect(rt.inspect('k8s_deployments:shop/payments').diagnosis!.pattern).not.toBe('linked');
    // 살펴보기의 '연결된 곳' 에 상대 시스템의 위반이 보인다
    const rel = rt.inspect('otel_services:payments').related!.find((r) => r.crossSystem)!;
    expect(rel.violations.map((v) => v.title)).toContain('준비된 복제본 수가 원하는 수에 닿아야 함');
  });

  it('follows the root-cause chain: web ← payments (where the errors start) ← the deployment that broke first', () => {
    const web = rt.inspect('otel_services:web');
    expect(viol('otel_services', 'web').length).toBe(1); // web 도 실패한다(payments 를 부르므로)
    expect(web.diagnosis).toMatchObject({ pattern: 'linked', title: '오류가 다른 곳에서 시작됨', confidence: 'high' });
    expect(web.chain!.map((s) => [s.collection, String(s.pk), s.via])).toEqual([
      ['otel_services', 'payments', 'blame'],
      ['k8s_deployments', 'shop/payments', 'linked'],
    ]);
    expect(web.chain!.at(-1)!.crossSystem).toBe(true);
    // 근본 원인 쪽에서는 더 거슬러 오를 곳이 없다
    expect(rt.inspect('k8s_deployments:shop/payments').chain ?? []).toEqual([]);
  });

  it('acts on the right system: scaling goes to Kubernetes, the trace side stays read-only', () => {
    expect(rt.grammar!.affordances.map((a) => a.id)).toEqual(['k8s_deployments_restock']);
    const dr = rt.dryRun('k8s_deployments:shop/payments', 'k8s_deployments_restock');
    expect(dr.commandText[0]).toMatch(/^\[k8s\] kubectl scale deployment\/payments -n shop --replicas=\d+$/);
  });
});
