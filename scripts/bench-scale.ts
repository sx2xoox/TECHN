import { CompositeAdapter, defineAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { attachNotifier, IsomorphRuntime } from '@isomorph/server';

/**
 * 서버 쪽 규모 시험: 클러스터(파드 수천 개) + 서비스(수백 개)를 한 세계로 묶고 잰다.
 *   npx tsx scripts/bench-scale.ts [--sizes 500,2000,5000]
 *
 * 자료는 실제 Kubernetes·OpenTelemetry 어댑터의 스키마(법칙·연결 포함)를 그대로 쓰고, 행만 합성한다(네트워크 없음).
 * 재는 것:
 *  - 시작(컴파일·검증·첫 관측)
 *  - 평상시 관측 한 번(행 1% 가 바뀜)
 *  - 살펴보기(근본 원인 사슬·연결된 곳 계산 포함) 지연 p50/p95
 *  - 한꺼번에 깨질 때: 디플로이먼트 20% 의 파드가 준비를 잃고 그 서비스가 실패하는 관측 한 번(장애 묶기·알림 포함)
 *  - 메모리(RSS)
 */
const sizes = (process.argv.includes('--sizes') ? process.argv[process.argv.indexOf('--sizes') + 1] : '500,2000,5000').split(',').map(Number);

const k8sSchema = await new KubernetesAdapter({ server: 'http://unused' }).introspect();
const otelSchema = await new OtelAdapter({ port: 0 }).introspect();

function world(pods: number) {
  const deps = Math.max(1, Math.round(pods / 10));
  const nodes = Math.max(1, Math.round(pods / 100));
  const now = new Date().toISOString();
  const state = {
    broken: new Set<number>(),
    tick: 0,
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `node-${i}`, name: `node-${i}`, ready: true, unschedulable: false, pods: 0, cpu: '8' })),
    deployments: Array.from({ length: deps }, (_, i) => ({ id: `ns-${i % 20}/app-${i}`, name: `app-${i}`, namespace: `ns-${i % 20}`, replicas: 10, ready_replicas: 10, status: 'available', image: 'registry.example/app:1.0', created_at: now })),
    pods: Array.from({ length: pods }, (_, i) => {
      const d = Math.floor(i / 10) % deps;
      return { id: `ns-${d % 20}/app-${d}-abc-${i}`, name: `app-${d}-abc-${i}`, namespace: `ns-${d % 20}`, deployment_id: `ns-${d % 20}/app-${d}`, node_id: `node-${i % nodes}`, phase: 'Running', ready: true, restarts: 0, created_at: now };
    }),
    services: Array.from({ length: deps }, (_, i) => ({ id: `app-${i}`, name: `app-${i}`, status: 'healthy', calls_per_min: 100, error_count: 0, avg_latency_ms: 20, last_seen_at: now, error_origin_id: null as string | null })),
  };
  const k8s = defineAdapter({
    system: 'kubernetes',
    schema: k8sSchema,
    read: async () => {
      // 평상시: 행 1% 가 조금씩 바뀐다(재시작 수·지연 같은 것)
      state.tick++;
      for (let i = state.tick % 100; i < state.pods.length; i += 100) state.pods[i].restarts = state.tick % 2;
      return { nodes: state.nodes, deployments: state.deployments, pods: state.pods, events: [] };
    },
  });
  const otel = defineAdapter({
    system: 'otel',
    schema: otelSchema,
    read: async () => {
      for (let i = state.tick % 100; i < state.services.length; i += 100) state.services[i].avg_latency_ms = 20 + (state.tick % 3);
      return { services: state.services, spans: [] };
    },
  });
  /** 디플로이먼트 일부가 깨진다: 파드가 준비를 잃고, 그 서비스가 실패한다 */
  const breakSome = (share: number) => {
    const n = Math.round(deps * share);
    for (let i = 0; i < n; i++) {
      const d = state.deployments[i];
      d.ready_replicas = 0;
      d.status = 'degraded';
      state.broken.add(i);
    }
    return n;
  };
  const failServices = () => {
    for (const i of state.broken) {
      const s = state.services[i];
      s.status = 'failing';
      s.error_count = 80;
    }
  };
  return { k8s, otel, breakSome, failServices, deps };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (t: number) => `${t.toFixed(t < 10 ? 1 : 0)}ms`;
const rows: Record<string, string | number>[] = [];

for (const pods of sizes) {
  const w = world(pods);
  const rt = new IsomorphRuntime({ adapter: new CompositeAdapter({ parts: [{ name: 'k8s', adapter: w.k8s }, { name: 'otel', adapter: w.otel }] }), pollMs: 3_600_000, numRuns: 30, compile: { mode: 'heuristic' } });
  let sent = 0;
  attachNotifier(rt, { webhook: 'https://example.com/hook', batchMs: 1, fetchImpl: (async () => (sent++, new Response(null, { status: 204 }))) as typeof fetch });
  let t = performance.now();
  if ((await rt.start()) !== 'running') throw new Error(`세계가 열리지 않음: ${rt.error}`);
  const startMs = performance.now() - t;
  const entities = rt.world!.entities.length;

  const ticks: number[] = [];
  for (let i = 0; i < 8; i++) {
    t = performance.now();
    await rt.refresh();
    ticks.push(performance.now() - t);
  }

  // 대량 장애: 디플로이먼트 20% 가 깨지고, 다음 관측에서 그 서비스들이 실패
  const broken = w.breakSome(0.2);
  t = performance.now();
  await rt.refresh();
  const breakTick = performance.now() - t;
  w.failServices();
  t = performance.now();
  await rt.refresh();
  const spreadTick = performance.now() - t;
  await new Promise((r) => setTimeout(r, 20));

  const ids = rt.world!.entities.map((e) => e.id);
  const sample = [...ids.filter((id) => id.startsWith('otel_services:')).slice(0, 20), ...ids.filter((id) => id.startsWith('k8s_pods:')).slice(0, 20), ...ids.filter((id) => id.startsWith('k8s_deployments:')).slice(0, 10)];
  const inspects: number[] = [];
  for (const id of sample) {
    t = performance.now();
    rt.inspect(id);
    inspects.push(performance.now() - t);
  }
  const chained = rt.inspect('otel_services:app-0');
  const incidents = rt.incidents.all().filter((i) => !i.observedFromStart);
  rows.push({
    파드: pods,
    개체: entities,
    시작: ms(startMs),
    '관측(평상시 중앙값)': ms(pct(ticks, 0.5)),
    '대량 장애 관측': `${ms(breakTick)} (${broken}곳)`,
    '번짐 관측': `${ms(spreadTick)} (+${broken}곳)`,
    '살펴보기 p50': ms(pct(inspects, 0.5)),
    '살펴보기 p95': ms(pct(inspects, 0.95)),
    '장애 묶음': `${incidents.length}건`,
    알림: `${sent}통`,
    'RSS(MB)': Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
  if (chained.chain?.at(-1)?.collection !== 'k8s_deployments') console.warn(`  (경고) ${pods}: 서비스의 근본 원인 사슬이 디플로이먼트로 이어지지 않음`);
  await rt.stop();
}
console.table(rows);
process.exit(0);
