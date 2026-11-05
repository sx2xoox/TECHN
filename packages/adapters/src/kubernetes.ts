import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { markSensitive, readOnlyExcept, type Row, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { ConflictError, UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * Kubernetes 어댑터: 노드·디플로이먼트·파드는 건물, 최근 이벤트는 걸어 다니는 일꾼.
 * 쓸 수 있는 것은 하나: 디플로이먼트의 replicas(규모 조정). resourceVersion 으로 낙관적 동시성을 지킨다.
 * 변경은 watch API 로 즉시 받는다(폴링은 안전망).
 *
 * 연결: kubeconfig(JSON 이면 바로, YAML 이면 kubectl 로 JSON 변환) 또는 server/token/ca 를 직접.
 */
export interface KubernetesAdapterOptions {
  /** kubeconfig 경로(기본 $KUBECONFIG 또는 ~/.kube/config) */
  kubeconfig?: string;
  context?: string;
  /** 한 네임스페이스만(기본: 전체) */
  namespace?: string;
  /** 직접 지정(kubeconfig 대신) */
  server?: string;
  token?: string;
  /** PEM 문자열 */
  ca?: string;
  insecureSkipTLSVerify?: boolean;
  system?: string;
  /** 최근 이벤트 수 */
  maxEvents?: number;
}

interface ExecConfig {
  command: string;
  args?: string[];
  env?: { name: string; value: string }[] | null;
}

interface Conn {
  server: string;
  token?: string;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  insecure?: boolean;
  /** 클라우드 클러스터(EKS·GKE·AKS)의 인증 플러그인: 실행해서 토큰을 받는다 */
  exec?: ExecConfig;
  tokenExpires?: number;
  tokenFile?: string;
}

type K8sObject = { metadata: { name: string; namespace?: string; uid: string; resourceVersion: string; creationTimestamp?: string; ownerReferences?: { kind: string; name: string }[]; labels?: Record<string, string> }; spec?: Record<string, unknown>; status?: Record<string, unknown> } & Record<string, unknown>;

const b64 = (s?: string) => (s ? Buffer.from(s, 'base64') : undefined);
/** 컨테이너 이미지 참조(레지스트리/경로:태그@다이제스트) */
const IMAGE_RE = /^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i;

/** kubeconfig(YAML 또는 JSON)를 읽어 연결 정보로. kubectl 이 없어도 된다. */
export function loadKubeconfig(opts: KubernetesAdapterOptions): Conn {
  if (opts.server) return { server: opts.server.replace(/\/$/, ''), token: opts.token, ca: opts.ca ? Buffer.from(opts.ca) : undefined, insecure: opts.insecureSkipTLSVerify };
  const file = opts.kubeconfig ?? process.env.KUBECONFIG?.split(path.delimiter).find(Boolean) ?? path.join(os.homedir(), '.kube', 'config');
  // 클러스터 안(파드)에서 돌 때: 서비스 계정으로
  const sa = '/var/run/secrets/kubernetes.io/serviceaccount';
  if (!opts.kubeconfig && !process.env.KUBECONFIG && !fs.existsSync(file) && process.env.KUBERNETES_SERVICE_HOST && fs.existsSync(`${sa}/token`)) {
    const host = process.env.KUBERNETES_SERVICE_HOST.includes(':') ? `[${process.env.KUBERNETES_SERVICE_HOST}]` : process.env.KUBERNETES_SERVICE_HOST;
    return { server: `https://${host}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`, ca: fs.readFileSync(`${sa}/ca.crt`), tokenFile: `${sa}/token` };
  }
  const cfg = YAML.parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 }) ?? {};
  const rel = (f: string) => (path.isAbsolute(f) ? f : path.join(path.dirname(file), f));
  const ctxName = opts.context ?? cfg['current-context'];
  const ctxEntry = (cfg.contexts ?? []).find((c: { name: string }) => c.name === ctxName) ?? (opts.context ? undefined : cfg.contexts?.[0]);
  if (!ctxEntry) throw new Error(`kubeconfig 에 컨텍스트 ${ctxName ?? '(없음)'} 가 없습니다: ${file}`);
  const ctx = ctxEntry.context ?? {};
  const cluster = (cfg.clusters ?? []).find((c: { name: string }) => c.name === ctx.cluster)?.cluster;
  const user = (cfg.users ?? []).find((u: { name: string }) => u.name === ctx.user)?.user ?? {};
  if (!cluster?.server) throw new Error(`kubeconfig 에서 클러스터 ${ctx.cluster ?? ''} 의 주소를 찾지 못했습니다: ${file}`);
  return {
    server: String(cluster.server).replace(/\/$/, ''),
    ca: b64(cluster['certificate-authority-data']) ?? (cluster['certificate-authority'] ? fs.readFileSync(rel(cluster['certificate-authority'])) : undefined),
    insecure: !!cluster['insecure-skip-tls-verify'],
    token: user.token,
    tokenFile: user.tokenFile ? rel(user.tokenFile) : undefined,
    cert: b64(user['client-certificate-data']) ?? (user['client-certificate'] ? fs.readFileSync(rel(user['client-certificate'])) : undefined),
    key: b64(user['client-key-data']) ?? (user['client-key'] ? fs.readFileSync(rel(user['client-key'])) : undefined),
    ...(user.exec?.command ? { exec: user.exec as ExecConfig } : {}),
  };
}

/** client.authentication.k8s.io ExecCredential: 플러그인을 실행해 토큰(또는 인증서)을 받는다 */
function runExec(conn: Conn) {
  const e = conn.exec!;
  const env = { ...process.env, ...Object.fromEntries((e.env ?? []).map((x) => [x.name, x.value])), KUBERNETES_EXEC_INFO: JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', spec: { interactive: false } }) };
  let out: string;
  try {
    out = execFileSync(e.command, e.args ?? [], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`kubeconfig 의 인증 플러그인(${path.basename(e.command)})을 실행하지 못했습니다: ${String((err as Error).message).split('\n')[0].slice(0, 160)}`);
  }
  const status = (JSON.parse(out) as { status?: { token?: string; clientCertificateData?: string; clientKeyData?: string; expirationTimestamp?: string } }).status ?? {};
  conn.token = status.token ?? conn.token;
  if (status.clientCertificateData) conn.cert = Buffer.from(status.clientCertificateData);
  if (status.clientKeyData) conn.key = Buffer.from(status.clientKeyData);
  conn.tokenExpires = status.expirationTimestamp ? Date.parse(status.expirationTimestamp) : Date.now() + 10 * 60_000;
}

export class KubernetesAdapter implements Adapter {
  readonly kind = 'custom' as const;
  readonly system: string;
  private conn!: Conn;
  private subs = new Set<{ closed: boolean; reqs: Set<http.ClientRequest>; timers: Set<NodeJS.Timeout> }>();
  private closed = false;
  /** 디플로이먼트 → 첫 컨테이너 이름(드라이런 명령을 정확히 보여 주려고) */
  private containerOf = new Map<string, string>();

  constructor(private opts: KubernetesAdapterOptions = {}) {
    this.system = opts.system ?? 'kubernetes';
  }

  /** 인증 헤더: 고정 토큰, 토큰 파일(서비스 계정은 주기적으로 바뀐다), 인증 플러그인(만료 1분 전 갱신) */
  private headers(): Record<string, string> {
    const c = this.conn;
    if (c.exec && (!c.token || (c.tokenExpires ?? 0) - 60_000 < Date.now())) runExec(c);
    const token = c.tokenFile ? fs.readFileSync(c.tokenFile, 'utf8').trim() : c.token;
    return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  private tls(url: URL): https.RequestOptions {
    return url.protocol === 'https:' ? { ca: this.conn.ca, cert: this.conn.cert, key: this.conn.key, rejectUnauthorized: !this.conn.insecure } : {};
  }

  private request(method: string, p: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; json: unknown }> {
    const url = new URL(this.conn.server + p);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method,
          headers: { ...this.headers(), ...(data ? { 'content-type': contentType, 'content-length': data.length } : {}) },
          ...this.tls(url),
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              json = { message: text.slice(0, 200) };
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Kubernetes API 응답 시간 초과')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  private async list(p: string): Promise<K8sObject[]> {
    const r = await this.request('GET', p);
    if (r.status !== 200) throw new Error(`GET ${p} → ${r.status} ${(r.json as { message?: string })?.message ?? ''}`);
    return ((r.json as { items?: K8sObject[] }).items ?? []) as K8sObject[];
  }

  private ns(apiGroup: string, kind: string) {
    return this.opts.namespace ? `${apiGroup}/namespaces/${encodeURIComponent(this.opts.namespace)}/${kind}` : `${apiGroup}/${kind}`;
  }

  async connect() {
    this.conn = loadKubeconfig(this.opts);
    const r = await this.request('GET', '/version');
    if (r.status !== 200) throw new Error(`Kubernetes API 에 연결하지 못했습니다(${r.status})`);
  }

  async introspect(): Promise<SystemSchema> {
    const s = (name: string): { name: string; type: 'string'; nullable: boolean } => ({ name, type: 'string', nullable: false });
    // 쓸 수 있는 곳은 디플로이먼트의 replicas(규모)와 image(첫 컨테이너의 이미지: 직전 변경 되돌리기용)뿐: 나머지는 보이기만 한다
    return readOnlyExcept(markSensitive({
      system: this.system,
      source: 'custom',
      // Kubernetes 의 핵심 약속: '원하는 상태' 와 '실제 상태' 가 같아야 한다. 시스템이 강제하지 못하므로(수렴할 뿐) 세계의 법칙이 된다.
      constraints: [
        { collection: 'deployments', expr: { op: 'cmpField', field: 'ready_replicas', cmp: '>=', other: 'replicas' }, description: '준비된 복제본 수가 원하는 수에 닿아야 함', enforced: false },
        { collection: 'pods', expr: { op: 'cmp', field: 'phase', cmp: '!=', value: 'Failed' }, description: '파드가 실패 상태로 남아 있으면 안 됨', enforced: false },
        { collection: 'pods', expr: { op: 'cmp', field: 'restarts', cmp: '<=', value: 3 }, description: '파드가 되풀이해서 다시 시작되면 안 됨(CrashLoop)', enforced: false },
        { collection: 'nodes', expr: { op: 'cmp', field: 'ready', cmp: '==', value: true }, description: '노드는 준비(Ready) 상태여야 함', enforced: false },
      ],
      collections: [
        {
          name: 'nodes',
          primaryKey: 'id',
          fields: [s('id'), s('name'), { name: 'ready', type: 'boolean', nullable: false }, { name: 'unschedulable', type: 'boolean', nullable: false }, { name: 'pods', type: 'integer', nullable: false }, { name: 'cpu', type: 'string', nullable: true }],
        },
        {
          name: 'deployments',
          primaryKey: 'id',
          // 디플로이먼트 이름 = 보통 그 앱의 서비스 이름(OpenTelemetry service.name 과 같은 체계)
          fields: [s('id'), { ...s('name'), joinKey: 'service' }, s('namespace'), { name: 'replicas', type: 'integer', nullable: false }, { name: 'ready_replicas', type: 'integer', nullable: false }, { name: 'status', type: 'string', nullable: false, enumValues: ['available', 'progressing', 'degraded'] }, { name: 'image', type: 'string', nullable: true }, { name: 'created_at', type: 'timestamp', nullable: true }],
        },
        {
          name: 'pods',
          primaryKey: 'id',
          fields: [
            s('id'),
            s('name'),
            s('namespace'),
            { name: 'deployment_id', type: 'string', nullable: true, ref: { collection: 'deployments', field: 'id' }, refEnforced: false },
            { name: 'node_id', type: 'string', nullable: true, ref: { collection: 'nodes', field: 'id' }, refEnforced: false },
            { name: 'phase', type: 'string', nullable: false, enumValues: ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'] },
            { name: 'ready', type: 'boolean', nullable: false },
            { name: 'restarts', type: 'integer', nullable: false },
            { name: 'created_at', type: 'timestamp', nullable: true },
          ],
        },
        {
          name: 'events',
          primaryKey: 'id',
          fields: [
            s('id'),
            { name: 'pod_id', type: 'string', nullable: true, ref: { collection: 'pods', field: 'id' }, refEnforced: false },
            { name: 'object', type: 'string', nullable: true },
            { name: 'type', type: 'string', nullable: false, enumValues: ['Normal', 'Warning'] },
            s('reason'),
            { name: 'message', type: 'string', nullable: true },
            { name: 'created_at', type: 'timestamp', nullable: true },
          ],
        },
      ],
    }), ['deployments.replicas', 'deployments.image']);
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    const want = (c: string) => !only || only.includes(c);
    const [nodes, deps, pods, events] = await Promise.all([
      want('nodes') || want('pods') ? this.list('/api/v1/nodes') : [],
      want('deployments') || want('pods') ? this.list(this.ns('/apis/apps/v1', 'deployments')) : [],
      want('pods') || want('nodes') || want('events') ? this.list(this.ns('/api/v1', 'pods')) : [],
      want('events') ? this.list(this.ns('/api/v1', 'events')) : [],
    ]);
    const depIds = new Set(deps.map((d) => `${d.metadata.namespace}/${d.metadata.name}`));
    const collections: Snapshot['collections'] = {};
    if (want('nodes')) {
      collections.nodes = nodes.map((n): Row => {
        const conds = ((n.status?.conditions as { type: string; status: string }[]) ?? []);
        return {
          id: n.metadata.name,
          name: n.metadata.name,
          ready: conds.some((c) => c.type === 'Ready' && c.status === 'True'),
          unschedulable: !!n.spec?.unschedulable,
          pods: pods.filter((p) => p.spec?.nodeName === n.metadata.name).length,
          cpu: String((n.status?.allocatable as Record<string, string> | undefined)?.cpu ?? ''),
        };
      });
    }
    if (want('deployments')) {
      collections.deployments = deps.map((d): Row => {
        const replicas = Number(d.spec?.replicas ?? 1);
        const ready = Number(d.status?.readyReplicas ?? 0);
        const conds = ((d.status?.conditions as { type: string; status: string }[]) ?? []);
        const available = conds.some((c) => c.type === 'Available' && c.status === 'True');
        const c0 = ((d.spec?.template as { spec?: { containers?: { name: string; image: string }[] } } | undefined)?.spec?.containers ?? [])[0];
        const id = `${d.metadata.namespace}/${d.metadata.name}`;
        if (c0) this.containerOf.set(id, c0.name);
        return { id, name: d.metadata.name, namespace: d.metadata.namespace ?? 'default', replicas, ready_replicas: ready, status: ready >= replicas && available ? 'available' : available ? 'progressing' : 'degraded', image: c0?.image ?? null, created_at: d.metadata.creationTimestamp ?? null };
      });
    }
    if (want('pods')) {
      collections.pods = pods.map((p): Row => {
        // ReplicaSet 이름은 '디플로이먼트-해시' 이다
        const rs = p.metadata.ownerReferences?.find((o) => o.kind === 'ReplicaSet')?.name;
        const dep = rs ? `${p.metadata.namespace}/${rs.replace(/-[a-z0-9]+$/, '')}` : null;
        const statuses = ((p.status?.containerStatuses as { ready: boolean; restartCount: number }[]) ?? []);
        return {
          id: `${p.metadata.namespace}/${p.metadata.name}`,
          name: p.metadata.name,
          namespace: p.metadata.namespace ?? 'default',
          deployment_id: dep && depIds.has(dep) ? dep : null,
          node_id: (p.spec?.nodeName as string | undefined) ?? null,
          phase: String(p.status?.phase ?? 'Unknown'),
          ready: statuses.length > 0 && statuses.every((c) => c.ready),
          restarts: statuses.reduce((a, c) => a + (c.restartCount ?? 0), 0),
          created_at: p.metadata.creationTimestamp ?? null,
        };
      });
    }
    if (want('events')) {
      const recent = events
        .map((e) => ({ e, at: String(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') }))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, this.opts.maxEvents ?? 200);
      // 이벤트는 대상이 지워진 뒤에도 한동안(기본 1시간) 남는다: 지금 있는 파드만 잇고, 원래 대상은 글자로 남긴다('대상 없음' 거짓 경보 방지)
      const podIds = new Set(pods.map((p) => `${p.metadata.namespace}/${p.metadata.name}`));
      collections.events = recent.map(({ e, at }): Row => {
        const obj = e.involvedObject as { kind?: string; name?: string; namespace?: string } | undefined;
        const podId = obj?.kind === 'Pod' ? `${obj.namespace}/${obj.name}` : null;
        return {
          id: e.metadata.uid,
          pod_id: podId && podIds.has(podId) ? podId : null,
          object: obj?.kind ? `${obj.kind} ${obj.namespace ? `${obj.namespace}/` : ''}${obj.name ?? ''}` : null,
          type: String(e.type ?? 'Normal'),
          reason: String(e.reason ?? ''),
          message: String(e.message ?? '').slice(0, 200),
          created_at: at || null,
        };
      });
    }
    return { ts: Date.now(), collections };
  }

  /** watch API: 파드·디플로이먼트·이벤트가 바뀌면 곧바로 알린다(끊기면 다시 붙는다). 구독마다 따로 열고 닫는다. */
  async watch(onChange: (collections: string[]) => void) {
    const sub = { closed: false, reqs: new Set<http.ClientRequest>(), timers: new Set<NodeJS.Timeout>() };
    this.subs.add(sub);
    const later = (fn: () => void, ms: number) => {
      if (sub.closed || this.closed) return;
      const t = setTimeout(() => {
        sub.timers.delete(t);
        fn();
      }, ms);
      sub.timers.add(t);
    };
    const topics: [string, string][] = [
      [this.ns('/api/v1', 'pods'), 'pods'],
      [this.ns('/apis/apps/v1', 'deployments'), 'deployments'],
      [this.ns('/api/v1', 'events'), 'events'],
    ];
    const open = async (p: string, collection: string) => {
      if (sub.closed || this.closed) return;
      // 목록의 resourceVersion 부터 지켜본다(처음 전부를 다시 받지 않게)
      const first = await this.request('GET', p).catch(() => null);
      if (sub.closed || this.closed) return;
      const rv = (first?.json as { metadata?: { resourceVersion?: string } })?.metadata?.resourceVersion ?? '';
      const url = new URL(`${this.conn.server}${p}?watch=1&resourceVersion=${encodeURIComponent(rv)}&allowWatchBookmarks=false`);
      const mod = url.protocol === 'https:' ? https : http;
      let headers: Record<string, string>;
      try {
        headers = this.headers();
      } catch {
        return later(() => void open(p, collection), 30_000);
      }
      const req = mod.request(url, { headers, ...this.tls(url) }, (res) => {
        if (res.statusCode !== 200) {
          // 권한 없음 등: 두드리지 말고 한참 뒤에 다시(폴링이 안전망)
          res.resume();
          sub.reqs.delete(req);
          return later(() => void open(p, collection), 30_000);
        }
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          if (buf.length > 4_000_000) buf = '';
          let i: number;
          let changed = false;
          while ((i = buf.indexOf('\n')) >= 0) {
            if (buf.slice(0, i).trim()) changed = true;
            buf = buf.slice(i + 1);
          }
          if (changed) onChange(collection === 'pods' ? ['pods', 'nodes', 'deployments'] : [collection]);
        });
        res.on('end', () => {
          sub.reqs.delete(req);
          later(() => void open(p, collection), 1000);
        });
      });
      req.on('error', () => {
        sub.reqs.delete(req);
        later(() => void open(p, collection), 2000);
      });
      req.end();
      sub.reqs.add(req);
    };
    for (const [p, c] of topics) void open(p, c);
    return async () => {
      sub.closed = true;
      for (const t of sub.timers) clearTimeout(t);
      for (const r of sub.reqs) r.destroy();
      this.subs.delete(sub);
    };
  }

  private parseId(cmd: UpdateCommand) {
    const id = String(cmd.pk);
    const m = /^([a-z0-9-]{1,63})\/([a-z0-9.-]{1,253})$/.exec(id);
    if (!m) throw new UnsupportedCommandError(`잘못된 디플로이먼트 id: ${id}`);
    return { namespace: m[1], name: m[2] };
  }

  private checkCmd(cmd: UpdateCommand) {
    const keys = Object.keys(cmd.patch);
    if (cmd.collection !== 'deployments' || !keys.length || keys.some((k) => k !== 'replicas' && k !== 'image')) throw new UnsupportedCommandError('Kubernetes 어댑터는 디플로이먼트의 replicas 와 image 만 바꿀 수 있습니다');
    if ('replicas' in cmd.patch) {
      const n = Number(cmd.patch.replicas);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new UnsupportedCommandError(`replicas 는 0~100 정수여야 합니다(${cmd.patch.replicas})`);
    }
    if ('image' in cmd.patch && !IMAGE_RE.test(String(cmd.patch.image ?? ''))) throw new UnsupportedCommandError('이미지 이름이 올바르지 않습니다');
    return this.parseId(cmd);
  }

  describe(cmd: UpdateCommand): string {
    const { namespace, name } = this.checkCmd(cmd);
    const parts: string[] = [];
    if ('image' in cmd.patch) parts.push(`kubectl set image deployment/${name} -n ${namespace} ${this.containerOf.get(`${namespace}/${name}`) ?? '<첫 컨테이너>'}=${String(cmd.patch.image)}`);
    if ('replicas' in cmd.patch) parts.push(`kubectl scale deployment/${name} -n ${namespace} --replicas=${Number(cmd.patch.replicas)}`);
    return parts.join(' && ');
  }

  async execute(cmd: UpdateCommand): Promise<void> {
    const { namespace, name } = this.checkCmd(cmd);
    const p = `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
    const cur = await this.request('GET', p);
    if (cur.status === 404) throw new ConflictError('디플로이먼트가 더 이상 존재하지 않습니다');
    const obj = cur.json as K8sObject;
    const containers = ((obj.spec?.template as { spec?: { containers?: { name: string; image: string }[] } } | undefined)?.spec?.containers ?? []);
    // 낙관적 동시성: 미리보기 때의 값과 지금 값이 다르면 멈춘다
    if ('replicas' in cmd.before && Number(obj.spec?.replicas ?? 1) !== Number(cmd.before.replicas)) throw new ConflictError();
    if ('image' in cmd.before && (containers[0]?.image ?? null) !== cmd.before.image) throw new ConflictError();
    const spec: Record<string, unknown> = {};
    if ('replicas' in cmd.patch) spec.replicas = Number(cmd.patch.replicas);
    let type = 'application/merge-patch+json';
    if ('image' in cmd.patch) {
      if (!containers[0]) throw new UnsupportedCommandError('컨테이너가 없는 디플로이먼트입니다');
      // 전략적 병합: 컨테이너 목록을 이름으로 합친다(다른 컨테이너·설정은 그대로)
      spec.template = { spec: { containers: [{ name: containers[0].name, image: String(cmd.patch.image) }] } };
      type = 'application/strategic-merge-patch+json';
    }
    const r = await this.request('PATCH', p, { metadata: { resourceVersion: obj.metadata.resourceVersion }, spec }, type);
    if (r.status === 409) throw new ConflictError();
    if (r.status !== 200) throw new Error(`디플로이먼트 변경 실패(${r.status}) ${String((r.json as { message?: string })?.message ?? '').slice(0, 160)}`);
  }

  async close() {
    this.closed = true;
    for (const sub of this.subs) {
      sub.closed = true;
      for (const t of sub.timers) clearTimeout(t);
      for (const r of sub.reqs) r.destroy();
    }
    this.subs.clear();
  }
}
