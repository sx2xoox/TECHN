import http from 'node:http';

/**
 * 시험용 가짜 Kubernetes API 서버. 응답 모양은 실제 API(v1 / apps/v1)와 같다.
 *  - Bearer 토큰을 요구한다
 *  - 목록 GET, ?watch=1 스트림, 디플로이먼트 GET/PATCH(merge-patch, resourceVersion 전제조건 → 409)
 *  - 규모를 바꾸면 컨트롤러처럼 파드를 늘리고 줄인다
 */
export interface FakeKube {
  url: string;
  token: string;
  patches: { path: string; body: unknown; contentType: string }[];
  /** 다른 누군가가 kubectl 로 바꾼 것처럼(newPodsReady=false 면 새 파드가 준비되지 못한다: 이미지·자원 문제) */
  scaleBehindBack(id: string, replicas: number, newPodsReady?: boolean): void;
  readyOf(id: string): number;
  podsOf(id: string): number;
  close(): Promise<void>;
}

type Obj = Record<string, any>;

export async function startFakeKube(): Promise<FakeKube> {
  const token = 'test-token';
  let rv = 100;
  const nextRv = () => String(++rv);
  const now = new Date().toISOString();
  const nodes: Obj[] = [
    { metadata: { name: 'kind-control-plane', uid: 'n1', resourceVersion: nextRv(), creationTimestamp: now }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '4' } } },
    { metadata: { name: 'kind-worker', uid: 'n2', resourceVersion: nextRv(), creationTimestamp: now }, spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'False' }], allocatable: { cpu: '2' } } },
  ];
  const deployments: Obj[] = [];
  const pods: Obj[] = [];
  const events: Obj[] = [];
  let podSeq = 0;
  const addPod = (dep: string, ns: string, opts: { ready?: boolean; phase?: string; restarts?: number; node?: string | null } = {}) => {
    const name = `${dep}-5f7c9d8b6-${(++podSeq).toString(36).padStart(5, 'x')}`;
    const pod = {
      metadata: { name, namespace: ns, uid: `p${podSeq}`, resourceVersion: nextRv(), creationTimestamp: now, ownerReferences: [{ kind: 'ReplicaSet', name: `${dep}-5f7c9d8b6` }] },
      spec: opts.node === null ? {} : { nodeName: opts.node ?? 'kind-control-plane' },
      status: { phase: opts.phase ?? 'Running', containerStatuses: [{ ready: opts.ready ?? true, restartCount: opts.restarts ?? 0 }] },
    };
    pods.push(pod);
    return pod;
  };
  const addDeployment = (name: string, ns: string, replicas: number, ready: number) => {
    deployments.push({ metadata: { name, namespace: ns, uid: `d-${name}`, resourceVersion: nextRv(), creationTimestamp: now }, spec: { replicas }, status: { replicas, readyReplicas: ready, conditions: [{ type: 'Available', status: ready > 0 ? 'True' : 'False' }] } });
  };
  // web: 건강함. api: 3개를 원하지만 1개만 준비됨(2개는 자리를 못 잡음). worker: 계속 다시 시작됨.
  addDeployment('web', 'default', 2, 2);
  addPod('web', 'default');
  addPod('web', 'default');
  addDeployment('api', 'shop', 3, 1);
  addPod('api', 'shop');
  addPod('api', 'shop', { ready: false, phase: 'Pending', node: null });
  addPod('api', 'shop', { ready: false, phase: 'Pending', node: null });
  addDeployment('worker', 'shop', 1, 0);
  const crash = addPod('worker', 'shop', { ready: false, restarts: 7 });
  events.push({ metadata: { name: 'e1', namespace: 'shop', uid: 'ev1', resourceVersion: nextRv(), creationTimestamp: now }, involvedObject: { kind: 'Pod', name: crash.metadata.name, namespace: 'shop' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', lastTimestamp: now });
  events.push({ metadata: { name: 'e2', namespace: 'shop', uid: 'ev2', resourceVersion: nextRv(), creationTimestamp: now }, involvedObject: { kind: 'Pod', name: pods[3].metadata.name, namespace: 'shop' }, type: 'Warning', reason: 'FailedScheduling', message: '0/2 nodes are available', lastTimestamp: now });

  const watchers = new Map<string, Set<http.ServerResponse>>();
  const notify = (kind: string, type: string, object: Obj) => {
    for (const res of watchers.get(kind) ?? []) res.write(JSON.stringify({ type, object }) + '\n');
  };
  const depId = (d: Obj) => `${d.metadata.namespace}/${d.metadata.name}`;
  const setReplicas = (d: Obj, n: number, newPodsReady = true) => {
    d.spec.replicas = n;
    d.metadata.resourceVersion = nextRv();
    // 컨트롤러 흉내: 새 파드는 바로 준비, 줄이면 뒤에서부터 지운다
    const mine = () => pods.filter((p) => p.metadata.namespace === d.metadata.namespace && p.metadata.ownerReferences[0].name.startsWith(`${d.metadata.name}-`));
    while (mine().length < n) notify('pods', 'ADDED', addPod(d.metadata.name, d.metadata.namespace, newPodsReady ? {} : { ready: false, phase: 'Pending', node: null }));
    while (mine().length > n) {
      const p = mine().at(-1)!;
      pods.splice(pods.indexOf(p), 1);
      notify('pods', 'DELETED', p);
    }
    d.status.readyReplicas = mine().filter((p) => p.status.containerStatuses[0].ready).length;
    notify('deployments', 'MODIFIED', d);
  };

  const patches: FakeKube['patches'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { kind: 'Status', message: 'Unauthorized', code: 401 });
    if (url.pathname === '/version') return send(200, { major: '1', minor: '31', gitVersion: 'v1.31.0-fake' });
    const list = /^\/(?:api\/v1|apis\/apps\/v1)(?:\/namespaces\/([^/]+))?\/(nodes|pods|events|deployments)$/.exec(url.pathname);
    if (list && req.method === 'GET') {
      const [, ns, kind] = list;
      if (url.searchParams.get('watch') === '1') {
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        if (!watchers.has(kind)) watchers.set(kind, new Set());
        watchers.get(kind)!.add(res);
        req.on('close', () => watchers.get(kind)!.delete(res));
        return;
      }
      const all = { nodes, pods, events, deployments }[kind as 'nodes']!;
      const items = ns ? all.filter((o) => o.metadata.namespace === ns) : all;
      return send(200, { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: String(rv) }, items });
    }
    const one = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const d = deployments.find((x) => x.metadata.namespace === one[1] && x.metadata.name === one[2]);
      if (!d) return send(404, { kind: 'Status', message: 'not found', code: 404 });
      if (req.method === 'GET') return send(200, d);
      if (req.method === 'PATCH') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const p = JSON.parse(body);
          patches.push({ path: url.pathname, body: p, contentType: String(req.headers['content-type']) });
          if (req.headers['content-type'] !== 'application/merge-patch+json') return send(415, { message: 'unsupported patch type' });
          if (p.metadata?.resourceVersion && p.metadata.resourceVersion !== d.metadata.resourceVersion) return send(409, { kind: 'Status', reason: 'Conflict', message: 'the object has been modified; please apply your changes to the latest version and try again', code: 409 });
          setReplicas(d, Number(p.spec.replicas));
          send(200, d);
        });
        return;
      }
    }
    send(404, { kind: 'Status', message: `no route ${req.method} ${url.pathname}`, code: 404 });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const find = (id: string) => deployments.find((d) => depId(d) === id)!;
  return {
    url,
    token,
    patches,
    scaleBehindBack: (id, n, ready) => setReplicas(find(id), n, ready),
    readyOf: (id) => Number(find(id).status.readyReplicas),
    podsOf: (id) => pods.filter((p) => `${p.metadata.namespace}/${p.metadata.ownerReferences[0].name.replace(/-[a-z0-9]+$/, '')}` === id).length,
    close: async () => {
      for (const s of watchers.values()) for (const r of s) r.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
