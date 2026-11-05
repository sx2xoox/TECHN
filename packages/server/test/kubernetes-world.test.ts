import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubernetesAdapter } from '@isomorph/adapters';
import { startFakeKube, type FakeKube } from '../../adapters/test/fake-kube.ts';
import { incidentReport, IsomorphRuntime } from '../src/index.ts';

/** Kubernetes → 사람 손 없이 컴파일·검증된 세계 → 규모 조정(미리보기 → 승인 → 확인 → 되돌리기) */
let kube: FakeKube;
let rt: IsomorphRuntime;

beforeAll(async () => {
  kube = await startFakeKube();
  rt = new IsomorphRuntime({ adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }), writeMode: 'low', pollMs: 60_000, numRuns: 40, compile: { mode: 'heuristic' } });
  expect(await rt.start()).toBe('running');
});

afterAll(async () => {
  await rt?.stop();
  await kube?.close();
});

const replicas = (id: string) => Number(rt.lastSnapshot!.collections.deployments.find((d) => d.id === id)!.replicas);

describe('Kubernetes → world', () => {
  it('compiles a lawful world whose only action is the one Kubernetes accepts', () => {
    expect(rt.report!.ok).toBe(true);
    const dep = rt.grammar!.kinds.find((k) => k.collection === 'deployments')!;
    expect(dep.channels.map((c) => `${c.channel}:${c.field}`)).toEqual(expect.arrayContaining(['stack:replicas', 'size:ready_replicas']));
    expect(rt.grammar!.kinds.find((k) => k.collection === 'events')!.route).toEqual({ to: 'pod_id' });
    // 노드 문 잠그기·파드 상태 바꾸기 같은 '할 수 없는 행동' 은 만들지 않는다
    expect(rt.grammar!.affordances.map((a) => a.id)).toEqual(['deployments_restock']);
    expect(rt.grammar!.affordances[0].title).toContain('복제본');
  });

  it('shows desired ≠ actual as anomalies: short deployments, crash loops, a NotReady node', () => {
    const v = rt.world!.violations.map((x) => `${x.invariantId}@${x.pk}`);
    expect(v).toEqual(
      expect.arrayContaining([
        'schema_deployments_ready_replicas_replicas@shop/api',
        'schema_deployments_ready_replicas_replicas@shop/worker',
        'schema_nodes_ready_true@kind-worker',
      ]),
    );
    expect(v.some((x) => x.startsWith('schema_pods_restarts_3@shop/worker-'))).toBe(true);
    expect(v.some((x) => x.endsWith('@default/web'))).toBe(false); // 건강한 것은 조용하다
  });

  it('scales a deployment through the world and verifies it on the cluster, then undoes it', async () => {
    const before = replicas('default/web');
    const dr = rt.dryRun('deployments:default/web', 'deployments_restock');
    expect(dr.allowed).toBe(true);
    expect(dr.commandText[0]).toMatch(/^kubectl scale deployment\/web -n default --replicas=\d+$/);
    expect(kube.podsOf('default/web')).toBe(before); // 미리보기는 아무것도 바꾸지 않는다
    const target = Number(dr.commands[0].patch.replicas);
    expect(target).toBeGreaterThan(before);
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    expect(kube.podsOf('default/web')).toBe(target);
    await new Promise((r) => setTimeout(r, 5)); // 실행 뒤에 시작한 관측으로만 확인한다
    await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
    expect(rt.getActions()[0].status).toBe('verified');
    expect(replicas('default/web')).toBe(target);
    const undo = await rt.undo(rec.id);
    expect(undo.status).toBe('applied');
    expect(kube.podsOf('default/web')).toBe(before);
  });

  it('re-plans instead of overwriting when someone scaled it with kubectl in between', async () => {
    await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
    const dr = rt.dryRun('deployments:default/web', 'deployments_restock');
    const per = Number(dr.commands[0].patch.replicas) - Number(dr.commands[0].before.replicas);
    kube.scaleBehindBack('default/web', 7); // 다른 사람이 kubectl scale --replicas=7
    const rec = await rt.approve(dr.planId!);
    expect(rec.status).toBe('applied');
    expect(rec.error).toContain('다시 계획');
    expect(kube.podsOf('default/web')).toBe(7 + per); // 7 을 덮어쓰지 않고 그 위에 더했다
  });

  it('explains a desired-vs-actual gap as a gap, not as clock skew or a race', async () => {
    const api = rt.inspect('deployments:shop/api').diagnosis!;
    expect(api.pattern).toBe('mismatch');
    expect(api.detail).toContain('ready_replicas=1, replicas=3');
    const crash = rt.world!.violations.find((v) => v.invariantId === 'schema_pods_restarts_3')!;
    expect(rt.inspect(`pods:${crash.pk}`).diagnosis!.pattern).not.toBe('race'); // 상한(재시작 ≤ 3)에는 경쟁 조건 이야기를 하지 않는다
    // 건강하던 web 의 목표를 누군가 올렸는데 새 파드가 준비되지 못하면: '기준 값이 방금 바뀜 — 따라잡는 중일 수 있음'
    await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
    const n = replicas('default/web');
    expect(rt.world!.violations.some((x) => x.pk === 'default/web')).toBe(false);
    kube.scaleBehindBack('default/web', n + 2, false);
    await new Promise((r) => setTimeout(r, 5));
    await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
    const after = rt.inspect('deployments:default/web').diagnosis!;
    expect(after.title).toBe('기준 값이 방금 바뀜');
    expect(after.detail).toContain(`replicas: ${n} → ${n + 2}`);
    kube.scaleBehindBack('default/web', n);
  });

  it('reverts the deploy that broke a deployment: preview → approve → pods back → verified', async () => {
    const hi = new IsomorphRuntime({ adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }), grammar: rt.grammar!, writeMode: 'high', pollMs: 60_000, numRuns: 20 });
    await hi.start();
    try {
      kube.deployImage('default/web', 'registry.example/app:2.0-broken'); // 누군가 나쁜 이미지를 배포
      await new Promise((r) => setTimeout(r, 5));
      await hi.refresh();
      await new Promise((r) => setTimeout(r, 60)); // 파드가 준비를 잃는다
      await hi.refresh();
      expect(hi.world!.violations.some((v) => v.pk === 'default/web')).toBe(true);
      const ins = hi.inspect('deployments:default/web');
      expect(ins.revert!.changes).toEqual([{ field: 'image', now: 'registry.example/app:2.0-broken', to: kube.goodImage }]);
      expect(ins.diagnosis).toMatchObject({ pattern: 'after-change', title: '직전 변경 뒤에 깨짐' });
      const dr = hi.dryRun('deployments:default/web', '__revert');
      expect(dr.allowed).toBe(true);
      expect(dr.commandText).toEqual([`kubectl set image deployment/web -n default app=${kube.goodImage}`]);
      expect(rt.dryRun('deployments:default/web', '__revert').allowed).toBe(false); // 쓰기 권한 low 로는 열리지 않는다(위험도 high)
      const rec = await hi.approve(dr.planId!);
      expect(rec.status).toBe('applied');
      expect(kube.imageOf('default/web')).toBe(kube.goodImage);
      await new Promise((r) => setTimeout(r, 5));
      await hi.refresh();
      expect(hi.getActions()[0].status).toBe('verified');
      expect(hi.world!.violations.some((v) => v.pk === 'default/web')).toBe(false); // 회복

      // 장애 기록: 열림(나쁜 배포) → 직전 변경 → 조치(되돌리기, 확인됨) → 닫힘, 그리고 사후 보고서
      const inc = hi.incidents.all().find((i) => i.rootKey === 'deployments:default/web')!;
      expect(inc.observedFromStart).toBeUndefined();
      expect(inc.closedAt).not.toBeNull();
      expect(inc.change).toEqual([{ field: 'image', now: 'registry.example/app:2.0-broken', to: kube.goodImage }]);
      expect(inc.actions.map((a) => [a.title, a.status])).toEqual([['직전 변경 되돌리기: image', 'verified']]);
      expect(inc.timeline.map((s) => s.kind)).toEqual(expect.arrayContaining(['start', 'action', 'verified', 'end']));
      const report = incidentReport(inc, { system: 'kubernetes', publicUrl: 'https://iso.example.com' });
      expect(report).toContain('# 장애 기록: web');
      expect(report).toContain('위반 직전의 변경: `image`');
      expect(report).toContain(`kubectl set image deployment/web -n default app=${kube.goodImage}`);
      expect(report).toContain('관측으로 확인됨');
      expect(report).toContain('https://iso.example.com/?focus=deployments%3Adefault%2Fweb');
      // 시작할 때 이미 깨져 있던 것들도 기록되지만 '관측 시작 전부터' 로 표시된다
      expect(hi.incidents.all().filter((i) => i.observedFromStart).length).toBeGreaterThan(0);
      expect(incidentReport(hi.incidents.all().find((i) => i.observedFromStart)!, { system: 'k' })).toContain('관측을 시작했을 때 이미 진행 중');
    } finally {
      await hi.stop();
    }
  });

  it('refuses to scale in read-only mode', async () => {
    const ro = new IsomorphRuntime({ adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }), grammar: rt.grammar!, pollMs: 60_000, numRuns: 20 });
    await ro.start();
    try {
      const dr = ro.dryRun('deployments:shop/api', 'deployments_restock');
      expect(dr.allowed).toBe(false);
      expect(dr.planId).toBeNull();
    } finally {
      await ro.stop();
    }
  });
});
