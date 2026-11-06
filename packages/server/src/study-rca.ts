import { CompositeAdapter, defineAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { attachStats, buildInspect, diffSnapshots, observe, type ChangeEvent, type Row, type Snapshot, type SystemSchema, type WorldGrammar, type WorldState } from '@isomorph/core';
import { compileHeuristic } from '@isomorph/compiler';

/**
 * 사용자 실험의 두 번째 과제: 근본 원인 찾기(RCA).
 * 클러스터(Kubernetes) 위에서 도는 쇼핑몰 서비스(OpenTelemetry)에서 장애가 번진 '정적 장면' 을 만든다.
 * 고객 화면(frontend)이 실패하고 있고, 참가자는 장애가 처음 시작된 곳과 그 종류를 고른다.
 *
 * 원본 스키마·연결은 실제 Kubernetes·OpenTelemetry 어댑터와 여러 시스템 묶기(CompositeAdapter)를 그대로 쓴다.
 * 장면마다 '시간에 따른 관측' 여러 개를 만들어 변경 기록(사건)도 함께 준다 — 표 조건도 같은 기록을 본다.
 * 헷갈리게 하는 것(일부러 넣음): 장애와 상관없이 먼저 깨져 있던 배치 작업, 장애 직전의 상관없는 배포, 지연 시간 잡음.
 */

export const RCA_KINDS = ['bad_deploy', 'node_down', 'service_bug'] as const;
export type RcaKind = (typeof RCA_KINDS)[number];

export const RCA_CHOICES: { id: RcaKind; text: string }[] = [
  { id: 'bad_deploy', text: '새로 배포한 버전(이미지)이 잘못됐다' },
  { id: 'node_down', text: '서버 컴퓨터(노드)가 멈췄다' },
  { id: 'service_bug', text: '서비스 자체 코드의 오류다(배포·노드는 정상)' },
];

/** 두 조건 모두에 똑같이 보여주는 규칙 카드(시스템의 법칙 + 읽는 법) */
export const RCA_RULES: { id: string; text: string }[] = [
  { id: 'node', text: '노드(서버 컴퓨터)는 준비(ready = true) 상태여야 한다' },
  { id: 'deploy', text: '디플로이먼트의 준비된 복제본 수(ready_replicas)가 원하는 수(replicas)에 닿아야 한다' },
  { id: 'pod', text: '파드는 실패(Failed) 상태로 남거나 3번 넘게 다시 시작(restarts)되면 안 된다' },
  { id: 'service', text: '서비스는 실패(failing) 상태면 안 된다. error_origin_id 는 그 서비스의 오류가 시작된 다른 서비스다' },
];

export const RCA_GLOSSARY: string[] = [
  '디플로이먼트: 앱 하나의 배포 단위. image 가 지금 배포된 버전이다. 이름이 같은 서비스와 이어진다.',
  '파드: 그 앱이 실제로 도는 복제본. deployment_id 가 속한 디플로이먼트, node_id 가 올라 있는 노드다.',
  '서비스: 요청을 받는 쪽에서 본 앱(오류 수·지연 시간). frontend 가 고객 화면이고, 다른 서비스들을 부른다.',
];

export interface RcaLogEntry {
  at: number;
  key: string;
  kind: ChangeEvent['kind'];
  text: string;
}

/** 살펴보기(세계·표+위반 강조 조건): 엔진이 계산한 것만 담는다 */
export interface RcaInsight {
  key: string;
  violations: string[];
  diagnosis: { title: string; detail: string } | null;
  chain: { key: string; label: string; violation: string; via: string }[];
  change: { field: string; from: unknown; to: unknown }[] | null;
  related: { key: string; label: string; bad: boolean; cross: boolean }[];
}

/**
 * 엔진을 어렵게 만드는 실제 상황(근본 원인 찾기 벤치마크·'어려운 과제' 용). clean 이 기본 장면이다.
 *  - no-trace: 고객 화면의 호출이 트레이스로 이어지지 않는다(계측 안 된 호출) → '오류가 시작된 곳' 이 비어 있다
 *  - same-tick: 번짐이 관측 한 번 안에 일어난다(관측 간격이 길 때) → 어느 쪽이 먼저인지 시각으로는 모른다
 *  - slow-spread: 번짐이 느리다(재시도·시간 초과로 45초 간격)
 *  - lag: 클러스터가 늦게 알아챈다(준비 상태 검사·노드 감시 지연) → 서비스가 먼저 실패한 것으로 보인다
 *  - coincidence: 서비스 코드 오류 직전에, 같은 앱의 복제본을 늘리는 중이라 디플로이먼트가 잠시 모자라다(상관없는 우연)
 *  - jitter: 번짐 간격이 장면마다 무작위(0~60초, 0이면 같은 관측). 엔진을 고칠 때 쓰지 않고 남겨 둔 확인용 상황이다
 */
export const RCA_FAULTS = ['clean', 'no-trace', 'same-tick', 'slow-spread', 'lag', 'coincidence', 'jitter'] as const;
export type RcaFault = (typeof RCA_FAULTS)[number];
/** 그 상황이 의미 있는 원인 종류만(우연은 서비스 코드 오류에만, 감시 지연은 클러스터가 끼는 경우에만) */
export const rcaFaultApplies = (fault: RcaFault, kind: RcaKind) => (fault === 'coincidence' ? kind === 'service_bug' : fault === 'lag' ? kind !== 'service_bug' : true);

export interface RcaScene {
  kind: RcaKind;
  fault: RcaFault;
  /** 증상(frontend)에서 근본 원인까지의 참된 경로(키 목록, 마지막이 근본 원인) */
  path: string[];
  /** 정답: 근본 원인 행 `${collection}:${pk}` */
  target: string;
  /** 장애가 드러난 곳(과제 문구에 쓴다) */
  symptom: string;
  snapshot: Snapshot;
  events: ChangeEvent[];
  log: RcaLogEntry[];
  world: WorldState;
  insights: Record<string, RcaInsight>;
}

function rng(seed: number) {
  // 이웃한 시드가 비슷한 첫 값을 내지 않도록 섞는다(선형 합동 생성기의 첫 출력은 시드에 거의 비례한다)
  let s = seed >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x7feb352d);
  s = Math.imul(s ^ (s >>> 15), 0x846ca68b);
  s = (s ^ (s >>> 16)) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BACKENDS = ['payments', 'search', 'catalog', 'cart', 'reviews', 'shipping', 'accounts', 'pricing'];
const NODES = ['node-a', 'node-b', 'node-c'];
const NS = 'shop';

interface State {
  nodes: Row[];
  deployments: Row[];
  pods: Row[];
  services: Row[];
}

const clone = (s: State): State => ({ nodes: s.nodes.map((r) => ({ ...r })), deployments: s.deployments.map((r) => ({ ...r })), pods: s.pods.map((r) => ({ ...r })), services: s.services.map((r) => ({ ...r })) });

/** 실제 어댑터의 스키마를 그대로 쓰는 묶음. read() 는 지금 상태를 돌려준다 */
async function composite(get: () => State) {
  const k8sSchema = await new KubernetesAdapter({ server: 'http://unused' }).introspect();
  const otelSchema = await new OtelAdapter({ port: 0 }).introspect();
  const k8s = defineAdapter({
    system: 'kubernetes',
    schema: k8sSchema,
    read: async () => ({ nodes: get().nodes, deployments: get().deployments, pods: get().pods, events: [] }),
    // 쓰기는 하지 않지만, 실제 어댑터처럼 '쓸 수 있는 필드'(replicas·image)를 남겨 둔다(직전 변경 찾기가 같게 동작하도록)
    write: async () => {
      throw new Error('실험 장면은 읽기 전용입니다');
    },
  });
  const otel = defineAdapter({ system: 'otel', schema: otelSchema, read: async () => ({ services: get().services, spans: [] }) });
  return new CompositeAdapter({ parts: [{ name: 'k8s', adapter: k8s }, { name: 'otel', adapter: otel }] });
}

let cached: Promise<{ schema: SystemSchema; grammar: WorldGrammar }> | null = null;

/** 실험 전체에서 쓰는 하나의 세계 문법(모든 장면이 같은 모습 규칙·법칙을 쓴다) */
export function rcaGrammar(): Promise<{ schema: SystemSchema; grammar: WorldGrammar }> {
  cached ??= (async () => {
    const base = baseState(rng(1), 'payments', 'search', 'bad_deploy');
    const c = await composite(() => base);
    const schema0 = await c.introspect();
    const snap = await c.snapshot();
    const schema = attachStats(schema0, snap);
    const grammar = compileHeuristic(schema);
    // 확정된 시스템 법칙만(추정 법칙은 빼서 두 조건이 같은 규칙 카드만 갖게)
    grammar.invariants = grammar.invariants.filter((i) => i.status === 'confirmed' && i.source === 'schema' && i.expr.op !== 'unique');
    return { schema, grammar };
  })();
  return cached;
}

function baseState(r: () => number, root: string, herring: string, kind: RcaKind, rootNode = 'node-b'): State {
  const pickN = <T,>(xs: T[], n: number) => {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  };
  const backends = [...new Set([root, herring, ...pickN(BACKENDS.filter((b) => b !== root && b !== herring), 2)])];
  const apps = pickN(backends, backends.length);
  const created = new Date(Date.now() - 86_400_000 * (3 + Math.floor(r() * 20))).toISOString();
  const deployments: Row[] = [];
  const pods: Row[] = [];
  const hex = () => Math.floor(r() * 0xfffff).toString(16).padStart(5, '0');
  const others = NODES.filter((n) => n !== rootNode);
  const place = (name: string, i: number): string => {
    if (kind === 'node_down') {
      if (name === root) return rootNode; // 근본 원인 노드 위에 그 앱의 복제본이 모두 있다(그래서 그 앱만 완전히 멈춘다)
      if (name === herring || name === 'frontend') return others[i % others.length]; // 헷갈리는 배포·고객 화면은 그 노드를 비켜 간다
      return i === 0 ? rootNode : others[i % others.length]; // 나머지는 일부만 그 노드에(부분적으로 준비 안 됨)
    }
    return NODES[(i + Math.floor(r() * NODES.length)) % NODES.length];
  };
  const addDeployment = (ns: string, name: string, replicas: number, version: string) => {
    const hash = hex().slice(0, 4);
    deployments.push({ id: `${ns}/${name}`, name, namespace: ns, replicas, ready_replicas: replicas, status: 'available', image: `registry.example/${name}:${version}`, created_at: created });
    for (let i = 0; i < replicas; i++) {
      const n = `${name}-${hash}-${hex()}`;
      pods.push({ id: `${ns}/${n}`, name: n, namespace: ns, deployment_id: `${ns}/${name}`, node_id: place(name, i), phase: 'Running', ready: true, restarts: 0, created_at: created });
    }
  };
  addDeployment(NS, 'frontend', 3, `2.${Math.floor(r() * 9)}.${Math.floor(r() * 9)}`);
  for (const a of apps) addDeployment(NS, a, 2 + Math.floor(r() * 2), `1.${Math.floor(r() * 9)}.${Math.floor(r() * 9)}`);
  addDeployment('ops', 'reports', 1, '0.9.1');
  const nowIso = new Date().toISOString();
  const services: Row[] = ['frontend', ...apps].map((name) => ({
    id: name,
    name,
    status: 'healthy',
    calls_per_min: name === 'frontend' ? 600 + Math.floor(r() * 300) : 80 + Math.floor(r() * 300),
    error_count: 0,
    avg_latency_ms: name === 'frontend' ? 90 + Math.floor(r() * 40) : 15 + Math.floor(r() * 50),
    last_seen_at: nowIso,
    error_origin_id: null,
  }));
  const nodes: Row[] = NODES.map((n) => ({ id: n, name: n, ready: true, unschedulable: false, pods: pods.filter((p) => p.node_id === n).length, cpu: '8' }));
  return { nodes, deployments, pods, services };
}

/** 사건 하나를 사람이 읽는 한 줄로(시각 필드는 뺀다) */
function describeEvent(e: ChangeEvent): string {
  if (e.kind === 'insert') {
    const r = e.after!;
    if (e.collection === 'k8s_pods') return `새 파드 (node_id=${r.node_id}, phase=${r.phase}, ready=${r.ready})`;
    return '생성';
  }
  if (e.kind === 'delete') return '삭제';
  const parts: string[] = [];
  for (const k of Object.keys(e.after!)) {
    if (/(_at)$/.test(k)) continue;
    if (JSON.stringify(e.before![k]) === JSON.stringify(e.after![k])) continue;
    parts.push(`${k}: ${JSON.stringify(e.before![k])} → ${JSON.stringify(e.after![k])}`);
  }
  return parts.join(', ');
}

/**
 * 장면 하나. 같은 시드면 같은 장면이다.
 * 시간 순서(장면 시각 T 기준): 배치 작업이 먼저 깨짐(T-300초) → 상관없는 배포(T-90초) → 근본 원인(T-46초) → 번짐(6초 간격) → 지금(T)
 */
export async function makeRcaScene(kind: RcaKind, seed: number, ts = Date.now(), fault: RcaFault = 'clean'): Promise<RcaScene> {
  const r = rng(seed ^ 0x51ed27);
  const { schema, grammar } = await rcaGrammar();
  const pool = [...BACKENDS];
  const root = pool.splice(Math.floor(r() * pool.length), 1)[0];
  const herring = pool[Math.floor(r() * pool.length)];
  const rootNode = NODES[Math.floor(r() * NODES.length)];
  let state = baseState(r, root, herring, kind, rootNode);
  const steps: { at: number; state: State }[] = [];
  const push = (sec: number, change: (s: State) => void) => {
    const next = clone(state);
    change(next);
    // 평상시 잡음: 서비스 한두 곳의 지연 시간이 조금 바뀐다
    for (let i = 0; i < 2; i++) {
      const s = next.services[Math.floor(r() * next.services.length)];
      if (s.status === 'healthy') s.avg_latency_ms = Math.max(5, Number(s.avg_latency_ms) + Math.round((r() - 0.5) * 12));
    }
    state = next;
    steps.push({ at: ts - sec * 1000, state: next });
  };
  const dep = (s: State, name: string) => s.deployments.find((d) => d.name === name)!;
  const svc = (s: State, name: string) => s.services.find((x) => x.id === name)!;
  const recount = (s: State) => {
    for (const d of s.deployments) {
      const ready = s.pods.filter((p) => p.deployment_id === d.id && p.ready).length;
      d.ready_replicas = ready;
      d.status = ready >= Number(d.replicas) ? 'available' : 'degraded';
    }
    for (const n of s.nodes) n.pods = s.pods.filter((p) => p.node_id === n.id).length;
  };
  const roll = (s: State, name: string, image: string, ok: boolean) => {
    const d = dep(s, name);
    const old = s.pods.filter((p) => p.deployment_id === d.id);
    s.pods = s.pods.filter((p) => p.deployment_id !== d.id);
    const hash = Math.floor(r() * 0xffff).toString(16).padStart(4, '0');
    old.forEach((p, i) => {
      const n = `${name}-${hash}-${Math.floor(r() * 0xfffff).toString(16).padStart(5, '0')}`;
      s.pods.push({ id: `${d.namespace}/${n}`, name: n, namespace: d.namespace, deployment_id: d.id, node_id: kind === 'node_down' ? p.node_id : NODES[(i + 1) % NODES.length], phase: ok ? 'Running' : 'Pending', ready: ok, restarts: 0, created_at: new Date(steps.at(-1)?.at ?? ts).toISOString() });
    });
    d.image = image;
    recount(s);
  };
  const fail = (s: State, name: string, origin: string | null) => {
    const x = svc(s, name);
    x.status = 'failing';
    x.error_count = Math.round(Number(x.calls_per_min) * (0.55 + r() * 0.4));
    x.error_origin_id = origin;
  };
  const reports = (s: State) => s.pods.find((p) => p.deployment_id === 'ops/reports')!;

  // 확인용 상황의 번짐 간격: 0~60초(5분의 1은 0 = 같은 관측). 별도 난수라 다른 상황의 장면은 그대로다
  function jittered() {
    const j = rng(seed ^ 0x7177e5);
    const gaps = [0, 1, 2].map(() => (j() < 0.2 ? 0 : 1 + Math.floor(j() * 60)));
    const last = 20;
    return [last + gaps[0] + gaps[1] + gaps[2], last + gaps[1] + gaps[2], last + gaps[2], last];
  }
  // 일정: [몇 초 전, 바꾸기]. 시각 순서대로 관측한다(같은 시각이면 한 관측)
  const plan: [number, (s: State) => void][] = [];
  const at = (sec: number, fn: (s: State) => void) => plan.push([sec, fn]);
  at(600, (s) => (reports(s).restarts = 2));
  at(420, (s) => (reports(s).restarts = 3));
  at(300, (s) => (reports(s).restarts = 5)); // 상관없는 배치 작업: 가장 먼저 법칙을 어긴다(근본 원인이 아니다)
  at(150, () => {});
  at(90, (s) => {
    const d = dep(s, herring);
    const [maj, min, patch] = String(d.image).split(':')[1].split('.').map(Number);
    roll(s, herring, `registry.example/${herring}:${maj}.${min}.${patch + 1}`, true); // 상관없는 정상 배포
  });
  const bump = (s: State) => {
    const d = dep(s, root);
    const [maj, min] = String(d.image).split(':')[1].split('.').map(Number);
    return `registry.example/${root}:${maj}.${min + 1}.0`;
  };
  // 번짐 단계의 시각: 기본 6초 간격, 느린 번짐은 45초 간격, 같은 관측이면 묶는다
  const T = fault === 'slow-spread' ? [200, 155, 110, 65] : fault === 'jitter' ? jittered() : [46, 40, 34, 28];
  const frontendOrigin = fault === 'no-trace' ? null : root;
  const nodeDown = (s: State) => (s.nodes.find((n) => n.id === rootNode)!.ready = false);
  const podsLost = (s: State) => {
    for (const p of s.pods.filter((x) => x.node_id === rootNode)) Object.assign(p, { ready: false, phase: 'Unknown' });
    recount(s);
  };
  const othersSlow = (s: State) => {
    // 일부 복제본만 잃은 앱은 느려지기만 한다(실패는 아님)
    for (const d of s.deployments.filter((x) => x.status === 'degraded' && x.name !== root)) {
      const x = s.services.find((y) => y.id === d.name);
      if (x) Object.assign(x, { status: 'degraded', error_count: Math.round(Number(x.calls_per_min) * 0.1), avg_latency_ms: Number(x.avg_latency_ms) * 3 });
    }
  };
  let target = '';
  const svcKey = `otel_services:${root}`;
  const depKey = `k8s_deployments:${NS}/${root}`;
  let path: string[] = [];
  if (kind === 'bad_deploy') {
    let next = '';
    const deploy = (s: State) => {
      next = bump(s);
      dep(s, root).image = next; // 잘못된 버전을 배포
    };
    const rolled = (s: State) => roll(s, root, next, false); // 새 파드가 뜨지 못한다 → 준비된 복제본 0
    at(T[0], deploy);
    if (fault === 'same-tick') {
      at(T[1], (s) => (rolled(s), fail(s, root, null)));
      at(T[2], (s) => fail(s, 'frontend', frontendOrigin));
    } else if (fault === 'lag') {
      // 파드는 이미 오류를 내지만 준비 상태 검사가 늦게 반영된다
      at(T[1], (s) => fail(s, root, null));
      at(T[2], (s) => fail(s, 'frontend', frontendOrigin));
      at(T[3], rolled);
    } else {
      at(T[1], rolled);
      at(T[2], (s) => fail(s, root, null));
      at(T[3], (s) => fail(s, 'frontend', frontendOrigin));
    }
    target = depKey;
    path = ['otel_services:frontend', svcKey, depKey];
  } else if (kind === 'node_down') {
    if (fault === 'same-tick') {
      at(T[0], nodeDown);
      at(T[1], (s) => (podsLost(s), fail(s, root, null), othersSlow(s)));
      at(T[2], (s) => fail(s, 'frontend', frontendOrigin));
    } else if (fault === 'lag') {
      // 노드는 이미 죽었지만 감시가 늦게 알아챈다(그 사이 서비스는 실패)
      at(T[1], (s) => fail(s, root, null));
      at(T[2], (s) => fail(s, 'frontend', frontendOrigin));
      at(T[3], nodeDown);
      at(T[3] - 6, (s) => (podsLost(s), othersSlow(s)));
    } else {
      at(T[0], nodeDown);
      at(T[1], podsLost);
      at(T[2], (s) => (fail(s, root, null), othersSlow(s)));
      at(T[3], (s) => fail(s, 'frontend', frontendOrigin));
    }
    target = `k8s_nodes:${rootNode}`;
    path = ['otel_services:frontend', svcKey, depKey, target];
  } else {
    if (fault === 'coincidence') {
      // 상관없는 우연: 복제본을 하나 늘리는 중이고 새 파드는 아직 준비되지 않았다
      at(T[0] + 6, (s) => {
        const d = dep(s, root);
        d.replicas = Number(d.replicas) + 1;
        const n = `${root}-${Math.floor(r() * 0xffff).toString(16).padStart(4, '0')}-scale`;
        s.pods.push({ id: `${NS}/${n}`, name: n, namespace: NS, deployment_id: d.id, node_id: NODES[0], phase: 'Pending', ready: false, restarts: 0, created_at: new Date(ts - (T[0] + 6) * 1000).toISOString() });
        recount(s);
      });
    } else at(T[0], () => {});
    if (fault === 'same-tick') {
      at(T[1], (s) => (fail(s, root, null), fail(s, 'frontend', frontendOrigin)));
    } else {
      at(T[1], (s) => fail(s, root, null)); // 배포·노드는 그대로인데 서비스가 실패한다(코드의 오류)
      at(T[2], (s) => fail(s, 'frontend', frontendOrigin));
    }
    at(T[3], () => {});
    target = svcKey;
    path = ['otel_services:frontend', svcKey];
  }
  at(0, () => {});
  // 같은 시각의 바꾸기는 한 관측으로 합친다
  const bySec = new Map<number, ((s: State) => void)[]>();
  for (const [sec, fn] of plan) bySec.set(sec, [...(bySec.get(sec) ?? []), fn]);
  for (const sec of [...bySec.keys()].sort((a, b) => b - a)) push(sec, (st) => bySec.get(sec)!.forEach((fn) => fn(st)));

  // 관측: 실제 묶음 어댑터로 각 시점의 스냅숏을 만들고(연결 필드 포함), 이어진 두 스냅숏의 차이를 사건으로
  let current = steps[0].state;
  const c = await composite(() => current);
  await c.introspect();
  const snaps: Snapshot[] = [];
  for (const st of steps) {
    current = st.state;
    snaps.push({ ...(await c.snapshot()), ts: st.at });
  }
  const events: ChangeEvent[] = [];
  for (let i = 1; i < snaps.length; i++) events.push(...diffSnapshots(snaps[i - 1], snaps[i], schema));
  const snapshot = snaps.at(-1)!;
  const world = observe(snapshot, grammar, schema);
  const log: RcaLogEntry[] = events
    .map((e) => ({ at: e.ts, key: `${e.collection}:${String(e.pk)}`, kind: e.kind, text: describeEvent(e) }))
    .filter((x) => x.text)
    .sort((a, b) => a.at - b.at);

  const insights: Record<string, RcaInsight> = {};
  const keyOf = (collection: string, pk: unknown) => `${collection}:${String(pk)}`;
  // 살펴보기 글은 두 조건(세계·표+위반 강조)에 똑같이 준다: 세계의 비유 이름(공장 등) 대신 원본 컬렉션 이름으로
  const neutral = (text: string) => grammar.kinds.reduce((t, k) => t.split(k.title).join(k.collection), text);
  for (const e of world.entities) {
    const ins = buildInspect({ snapshot, grammar, schema, events, entityId: e.id, writeMode: 'read-only', history: true, world });
    const key = keyOf(e.source.collection, e.source.pk);
    insights[key] = {
      key,
      violations: ins.violations.map((v) => v.title),
      diagnosis: ins.diagnosis && ins.diagnosis.pattern !== 'unknown' ? { title: neutral(ins.diagnosis.title), detail: neutral(ins.diagnosis.detail) } : null,
      chain: (ins.chain ?? []).map((s) => ({ key: keyOf(s.collection, s.pk), label: s.label, violation: s.violation, via: s.via === 'blame' ? '오류가 시작된 곳' : s.through ? `${s.through.collection} ${s.through.count}개를 거쳐, 먼저 법칙을 어김` : s.basis === 'same-observation' ? '같은 관측에서 함께 깨진 기반(순서는 모름)' : s.basis === 'recent-change' ? '지금 깨져 있고 직전에 바뀐 기반' : '먼저 법칙을 어김' })),
      change: ins.revert ? ins.revert.changes.map((x) => ({ field: x.field, from: x.to, to: x.now })) : null,
      related: (ins.related ?? []).slice(0, 8).map((x) => ({ key: keyOf(x.collection, x.pk), label: x.label, bad: x.violations.length > 0, cross: x.crossSystem })),
    };
  }
  return { kind, fault, path, target, symptom: 'otel_services:frontend', snapshot, events, log, world, insights };
}

/** 엔진의 결과: 실패한 고객 화면에서 시작한 근본 원인 사슬의 끝을 참된 경로와 견준다 */
export type RcaEngineOutcome = 'correct' | 'partial' | 'abstain' | 'wrong';
export function rcaEngineOutcome(s: Pick<RcaScene, 'insights' | 'symptom' | 'target' | 'path'>): { outcome: RcaEngineOutcome; end: string | null; chain: string[] } {
  const chain = (s.insights[s.symptom]?.chain ?? []).map((c) => c.key);
  const end = chain.at(-1) ?? null;
  // 맞음: 끝이 근본 원인 · 덜 감: 참된 경로 위에서 멈춤 · 멈춤: 아무것도 짚지 않음 · 틀림: 경로 밖을 짚음
  const outcome: RcaEngineOutcome = !end ? 'abstain' : end === s.target ? 'correct' : s.path.includes(end) ? 'partial' : 'wrong';
  return { outcome, end, chain };
}

/** 과제 배정(라틴 방진): 조건마다 세 종류를 같은 수만큼, 참가자마다 순서를 돌린다 */
export function planRcaTrials(participant: number, conditions: string[], perCondition: number): { condition: string; anomaly: RcaKind }[] {
  const blocks = conditions.map((_, i) => conditions[(i + participant) % conditions.length]);
  const out: { condition: string; anomaly: RcaKind }[] = [];
  blocks.forEach((condition, b) => {
    for (let k = 0; k < perCondition; k++) out.push({ condition, anomaly: RCA_KINDS[(k + b + participant) % RCA_KINDS.length] });
  });
  return out;
}
