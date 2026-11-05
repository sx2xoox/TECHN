import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompositeAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { startTwoServices, type TwoServices } from '../../../examples/otel/two-services.ts';
import { IsomorphRuntime } from '../src/index.ts';

/**
 * 실제 클러스터 + 진짜 OpenTelemetry 트레이스를 한 세계로(CI 의 kind 작업에서 켠다):
 *   ISOMORPH_TEST_KUBECONFIG=/tmp/kubeconfig.json
 *   ISOMORPH_TEST_PAYMENTS_URL=http://<노드 IP>:<NodePort>/   (default/payments 디플로이먼트, nginx 2개)
 *
 * payments 서비스는 실제로 클러스터 안의 payments 파드를 부른다. 실패를 꾸미지 않는다:
 * 디플로이먼트의 이미지를 없는 것으로 바꾸면(Recreate) 파드가 사라지고, 그래서 호출이 실제로 실패한다.
 * ISOMORPH 는 실패한 서비스의 원인으로 '먼저 법칙을 어긴' 클러스터의 디플로이먼트를 가리켜야 한다.
 */
const KUBECONFIG = process.env.ISOMORPH_TEST_KUBECONFIG;
const BACKEND = process.env.ISOMORPH_TEST_PAYMENTS_URL;
const until = async (cond: () => Promise<boolean> | boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`시간 안에 일어나지 않음: ${what}`);
};

describe.skipIf(!KUBECONFIG || !BACKEND)('one world: a real cluster and the services that call it', () => {
  let k8s: KubernetesAdapter;
  let otel: OtelAdapter;
  let app: TwoServices;
  let rt: IsomorphRuntime;
  let traffic: NodeJS.Timeout;
  const viol = (c: string, pk: string) => rt.world!.violations.filter((v) => v.collection === c && String(v.pk) === pk);

  beforeAll(async () => {
    k8s = new KubernetesAdapter({ kubeconfig: KUBECONFIG });
    otel = new OtelAdapter({ port: 0 });
    await otel.connect();
    app = await startTwoServices({ endpoint: otel.endpoint, paymentsBackend: BACKEND });
    const first = await app.hit(8);
    expect(first.failed).toBe(0); // 파드가 살아 있으면 호출은 성공한다
    traffic = setInterval(() => void app.hit(2, 2).catch(() => {}), 500);
    rt = new IsomorphRuntime({ adapter: new CompositeAdapter({ parts: [{ name: 'k8s', adapter: k8s }, { name: 'otel', adapter: otel }] }), writeMode: 'high', pollMs: 2000, numRuns: 40, compile: { mode: 'heuristic' } });
    expect(await rt.start()).toBe('running');
  }, 60_000);

  afterAll(async () => {
    clearInterval(traffic);
    await app?.close();
    await rt?.stop();
  });

  it('links the real deployments to the services by name, with no false orphans', () => {
    expect(rt.report!.ok).toBe(true);
    const link = rt.schema!.collections.find((c) => c.name === 'k8s_deployments')!.fields.find((f) => f.ref?.crossSystem)!;
    const deps = Object.fromEntries(rt.lastSnapshot!.collections.k8s_deployments.map((d) => [d.id, d[link.name]]));
    expect(deps['default/payments']).toBe('payments');
    expect(deps['default/web']).toBe('web');
    expect(deps['default/broken']).toBeNull();
    expect(rt.world!.violations.filter((v) => v.kind === 'orphan')).toEqual([]);
    expect(viol('otel_services', 'payments')).toEqual([]);
  });

  it('traces a real failing service back to the deployment that broke first', async () => {
    // 이미지를 없는 것으로(Recreate: 기존 파드부터 내린다) → 파드가 사라진다 → 호출이 실제로 실패한다
    const r = await (k8s as unknown as { request(m: string, p: string, b: unknown, ct: string): Promise<{ status: number }> }).request(
      'PATCH',
      '/apis/apps/v1/namespaces/default/deployments/payments',
      { spec: { strategy: { type: 'Recreate', rollingUpdate: null }, template: { spec: { containers: [{ name: 'nginx', image: 'registry.invalid/isomorph/gone:1' }] } } } },
      'application/merge-patch+json',
    );
    expect(r.status).toBe(200);
    await until(async () => (await rt.tick(), viol('k8s_deployments', 'default/payments').length > 0), 120_000, 'payments 디플로이먼트 위반');
    await until(async () => (await rt.tick(), viol('otel_services', 'payments').length > 0), 120_000, 'payments 서비스 실패');
    const d = rt.inspect('otel_services:payments').diagnosis!;
    expect(d.pattern).toBe('linked');
    expect(d.detail).toContain('k8s_deployments #default/payments');
    expect(rt.inspect('k8s_deployments:default/payments').diagnosis!.pattern).not.toBe('linked');
    const rel = rt.inspect('otel_services:payments').related!.find((x) => x.crossSystem)!;
    expect(rel).toMatchObject({ collection: 'k8s_deployments', pk: 'default/payments' });
    expect(rel.violations.length).toBeGreaterThan(0);
    // web 도 실패한다(payments 를 부르므로). 근본 원인 사슬: web ← payments(실제 트레이스로 본 오류 시작점) ← 클러스터
    await until(async () => (await rt.tick(), viol('otel_services', 'web').length > 0), 60_000, 'web 서비스 실패');
    const chain = rt.inspect('otel_services:web').chain ?? [];
    expect(chain.map((s) => [s.collection, String(s.pk), s.via])).toEqual([
      ['otel_services', 'payments', 'blame'],
      ['k8s_deployments', 'default/payments', 'linked'],
    ]);
  }, 300_000);

  it('fixes it at the root: revert the bad image → the real pods come back → payments and web recover', async () => {
    const dep = 'k8s_deployments:default/payments';
    const ins = rt.inspect(dep);
    expect(ins.diagnosis!.pattern).toBe('after-change');
    expect(ins.revert!.changes).toEqual([{ field: 'image', now: 'registry.invalid/isomorph/gone:1', to: 'nginx:1.27-alpine' }]);
    const dr = rt.dryRun(dep, '__revert');
    expect(dr.allowed).toBe(true);
    expect(dr.commandText).toEqual(['[k8s] kubectl set image deployment/payments -n default nginx=nginx:1.27-alpine']);
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    await until(async () => (await rt.refresh(), viol('k8s_deployments', 'default/payments').length === 0), 180_000, '디플로이먼트 회복(파드 준비)');
    expect(rt.getActions().find((a) => a.id === rec.id)!.status).toBe('verified');
    const ok = await app.hit(6);
    expect(ok.failed).toBe(0); // 호출이 실제로 다시 성공한다
    // 서비스는 최근 1분의 오류 비율이 내려가면 회복한다
    await until(async () => (await rt.refresh(), viol('otel_services', 'payments').length === 0 && viol('otel_services', 'web').length === 0), 120_000, 'payments·web 서비스 회복');
  }, 360_000);
});
