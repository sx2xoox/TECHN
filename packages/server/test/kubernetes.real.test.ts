import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, KubernetesAdapter } from '@isomorph/adapters';
import { IsomorphRuntime } from '../src/index.ts';

/**
 * 실제 Kubernetes 클러스터(CI 에서는 kind) 통합 시험. 환경변수로 켠다:
 *   ISOMORPH_TEST_KUBECONFIG=/tmp/kubeconfig.json   (kubectl config view --raw -o json --minify)
 * 클러스터에 미리 있어야 하는 것: default/web (nginx, replicas 2, 준비 완료), default/broken (없는 이미지)
 */
const KUBECONFIG = process.env.ISOMORPH_TEST_KUBECONFIG;
const until = async (cond: () => Promise<boolean> | boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`시간 안에 일어나지 않음: ${what}`);
};

describe.skipIf(!KUBECONFIG)('KubernetesAdapter on a real cluster', () => {
  let adapter: KubernetesAdapter;
  let rt: IsomorphRuntime;
  const dep = (id: string) => rt.lastSnapshot!.collections.deployments.find((d) => d.id === id)!;

  beforeAll(async () => {
    // kind 의 kubeconfig: https + 클라이언트 인증서(mTLS) + 클러스터 CA
    adapter = new KubernetesAdapter({ kubeconfig: KUBECONFIG });
    rt = new IsomorphRuntime({ adapter, writeMode: 'low', pollMs: 60_000, numRuns: 40, compile: { mode: 'heuristic' } });
    expect(await rt.start()).toBe('running');
  }, 60_000);

  afterAll(async () => {
    await rt?.stop();
  });

  it('opens a lawful world of the real cluster: the node, the deployment and its pods', () => {
    expect(rt.report!.ok).toBe(true);
    const snap = rt.lastSnapshot!;
    expect(snap.collections.nodes.some((n) => n.ready === true)).toBe(true);
    expect(dep('default/web')).toMatchObject({ replicas: 2, ready_replicas: 2, status: 'available' });
    const pods = snap.collections.pods.filter((p) => p.deployment_id === 'default/web');
    expect(pods).toHaveLength(2);
    expect(pods.every((p) => p.phase === 'Running' && p.ready === true && snap.collections.nodes.some((n) => n.id === p.node_id))).toBe(true);
    expect(rt.grammar!.affordances.map((a) => a.id)).toEqual(['deployments_restock']);
  });

  it('shows the deployment whose image cannot be pulled as an anomaly, and not the healthy one', () => {
    const v = rt.world!.violations.map((x) => `${x.invariantId}@${x.pk}`);
    expect(v).toContain('schema_deployments_ready_replicas_replicas@default/broken');
    expect(v.some((x) => x.endsWith('@default/web'))).toBe(false);
  });

  it('honours resourceVersion as a precondition (a stale write gets 409 from the API server)', async () => {
    const r = await (adapter as unknown as { request(m: string, p: string, b: unknown, ct: string): Promise<{ status: number }> }).request('PATCH', '/apis/apps/v1/namespaces/default/deployments/web', { metadata: { resourceVersion: '1' }, spec: { replicas: 9 } }, 'application/merge-patch+json');
    expect(r.status).toBe(409);
    await expect(adapter.execute({ op: 'update', collection: 'deployments', pk: 'default/web', patch: { replicas: 9 }, before: { replicas: 5 } })).rejects.toBeInstanceOf(ConflictError);
    await rt.tick();
    expect(dep('default/web').replicas).toBe(2); // 어느 쪽도 쓰이지 않았다
  });

  it('scales through the world: preview → approve → Kubernetes actually runs the new pods → verified → undo', async () => {
    const changes: string[][] = [];
    const stop = await adapter.watch((c) => changes.push(c));
    const dr = rt.dryRun('deployments:default/web', 'deployments_restock');
    expect(dr.allowed).toBe(true);
    const target = Number(dr.commands[0].patch.replicas);
    expect(dr.commandText[0]).toBe(`kubectl scale deployment/web -n default --replicas=${target}`);
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    await until(async () => (await rt.tick(), Number(dep('default/web').ready_replicas) === target), 120_000, `파드 ${target}개 준비`);
    expect(rt.getActions().find((a) => a.id === rec.id)!.status).toBe('verified');
    expect(rt.lastSnapshot!.collections.pods.filter((p) => p.deployment_id === 'default/web' && p.ready === true)).toHaveLength(target);
    expect(changes.flat()).toContain('deployments'); // watch API 로 즉시 알림이 왔다
    await stop();

    const undo = await rt.undo(rec.id);
    expect(undo.status).toBe('applied');
    await until(async () => (await rt.tick(), Number(dep('default/web').replicas) === 2 && rt.lastSnapshot!.collections.pods.filter((p) => p.deployment_id === 'default/web').length === 2), 120_000, '원래대로 2개');
  }, 300_000);
});
