import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, KubernetesAdapter, loadKubeconfig, UnsupportedCommandError } from '../src/index.ts';
import { startFakeKube, type FakeKube } from './fake-kube.ts';

/** 실제 API 모양의 가짜 서버로: 연결(kubeconfig·토큰), 읽기, 연결 관계, watch, 규모 조정(낙관적 동시성) */
let kube: FakeKube;
let a: KubernetesAdapter;
let dir: string;

beforeAll(async () => {
  kube = await startFakeKube();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-kube-'));
  // kubectl config view --raw -o json 과 같은 모양
  const kubeconfig = { apiVersion: 'v1', kind: 'Config', 'current-context': 'fake', contexts: [{ name: 'fake', context: { cluster: 'c', user: 'u' } }], clusters: [{ name: 'c', cluster: { server: kube.url } }], users: [{ name: 'u', user: { token: kube.token } }] };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(kubeconfig));
  a = new KubernetesAdapter({ kubeconfig: path.join(dir, 'config.json') });
  await a.connect();
});

afterAll(async () => {
  await a?.close();
  await kube?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Kubernetes adapter (fake API with real response shapes)', () => {
  it('reads an ordinary YAML kubeconfig (no kubectl needed) and picks the asked context', async () => {
    fs.writeFileSync(path.join(dir, 'ca.pem'), 'not-a-real-ca');
    const yaml = [
      'apiVersion: v1',
      'kind: Config',
      'current-context: dev',
      'clusters:',
      '- name: dev-cluster',
      '  cluster:',
      `    server: ${kube.url}/`,
      '- name: prod-cluster',
      '  cluster:',
      '    server: https://prod.example.com:6443',
      '    certificate-authority: ca.pem', // kubeconfig 가 있는 폴더 기준 상대 경로
      'contexts:',
      '- name: dev',
      '  context: {cluster: dev-cluster, user: dev-user}',
      '- name: prod',
      '  context: {cluster: prod-cluster, user: prod-user}',
      'users:',
      '- name: dev-user',
      `  user: {token: ${kube.token}}`,
      '- name: prod-user',
      '  user: {token: other}',
    ].join('\n');
    const file = path.join(dir, 'config');
    fs.writeFileSync(file, yaml);
    const b = new KubernetesAdapter({ kubeconfig: file });
    await b.connect();
    expect((await b.snapshot(['deployments'])).collections.deployments.length).toBeGreaterThan(0);
    const prod = loadKubeconfig({ kubeconfig: file, context: 'prod' });
    expect(prod).toMatchObject({ server: 'https://prod.example.com:6443', token: 'other' });
    expect(String(prod.ca)).toBe('not-a-real-ca');
    expect(() => loadKubeconfig({ kubeconfig: file, context: 'nope' })).toThrow(/컨텍스트 nope/);
  });

  it('gets its token from an exec auth plugin (as EKS/GKE/AKS do), once, and refreshes it before it expires', async () => {
    const count = path.join(dir, 'exec-count');
    const plugin = `require('fs').appendFileSync(${JSON.stringify(count)}, 'x'); const info = JSON.parse(process.env.KUBERNETES_EXEC_INFO); console.log(JSON.stringify({ apiVersion: info.apiVersion, kind: 'ExecCredential', status: { token: process.env.FAKE_TOKEN, expirationTimestamp: new Date(Date.now() + Number(process.env.TTL_MS)).toISOString() } }))`;
    const write = (ttl: number) => {
      fs.rmSync(count, { force: true });
      const cfg = { 'current-context': 'c', contexts: [{ name: 'c', context: { cluster: 'k', user: 'u' } }], clusters: [{ name: 'k', cluster: { server: kube.url } }], users: [{ name: 'u', user: { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: process.execPath, args: ['-e', plugin], env: [{ name: 'FAKE_TOKEN', value: kube.token }, { name: 'TTL_MS', value: String(ttl) }] } } }] };
      fs.writeFileSync(path.join(dir, 'exec.json'), JSON.stringify(cfg));
      return new KubernetesAdapter({ kubeconfig: path.join(dir, 'exec.json') });
    };
    const longLived = write(3600_000);
    await longLived.connect();
    await longLived.snapshot();
    expect(fs.readFileSync(count, 'utf8')).toHaveLength(1); // 연결과 읽기 다섯 번에 플러그인은 한 번
    const shortLived = write(30_000); // 1분 안에 만료 → 요청마다 새로 받는다
    await shortLived.connect();
    await shortLived.snapshot(['nodes']);
    expect(fs.readFileSync(count, 'utf8').length).toBeGreaterThan(1);
  });

  it('refuses to connect without the right credentials', async () => {
    await expect(new KubernetesAdapter({ server: kube.url, token: 'wrong' }).connect()).rejects.toThrow(/401/);
  });

  it('reads nodes, deployments, pods and events and links them', async () => {
    const s = await a.snapshot();
    const byId = (rows: Record<string, unknown>[]) => Object.fromEntries(rows.map((r) => [String(r.id), r]));
    const nodes = byId(s.collections.nodes);
    expect(nodes['kind-control-plane']).toMatchObject({ ready: true, unschedulable: false, pods: 4 });
    expect(nodes['kind-worker']).toMatchObject({ ready: false, unschedulable: true, pods: 0 });
    const deps = byId(s.collections.deployments);
    expect(deps['default/web']).toMatchObject({ name: 'web', namespace: 'default', replicas: 2, ready_replicas: 2, status: 'available' });
    expect(deps['shop/api']).toMatchObject({ replicas: 3, ready_replicas: 1, status: 'progressing' });
    expect(deps['shop/worker']).toMatchObject({ replicas: 1, ready_replicas: 0, status: 'degraded' });
    // 파드 → ReplicaSet(이름-해시) → 디플로이먼트, 그리고 노드
    expect(s.collections.pods).toHaveLength(6);
    expect(s.collections.pods.filter((p) => p.deployment_id === 'shop/api')).toHaveLength(3);
    expect(s.collections.pods.filter((p) => p.node_id === null && p.phase === 'Pending')).toHaveLength(2);
    expect(s.collections.pods.find((p) => p.deployment_id === 'shop/worker')).toMatchObject({ restarts: 7, ready: false });
    const ev = s.collections.events.find((e) => e.reason === 'BackOff')!;
    expect(ev.type).toBe('Warning');
    expect(s.collections.pods.some((p) => p.id === ev.pod_id)).toBe(true);
    // 지워진 파드의 이벤트: 잇지 않고(대상 없음 거짓 경보 방지) 원래 대상은 글자로 남긴다
    expect(s.collections.events.find((e) => e.reason === 'Killing')).toMatchObject({ pod_id: null, object: 'Pod default/web-5f7c9d8b6-gone1' });
  });

  it('declares the desired-vs-actual promises Kubernetes cannot enforce itself', async () => {
    const schema = await a.introspect();
    expect(schema.constraints.every((c) => !c.enforced)).toBe(true);
    expect(schema.constraints.map((c) => c.collection).sort()).toEqual(['deployments', 'nodes', 'pods', 'pods']);
  });

  it('reads one namespace only when asked', async () => {
    const b = new KubernetesAdapter({ server: kube.url, token: kube.token, namespace: 'shop' });
    await b.connect();
    const s = await b.snapshot();
    expect(s.collections.deployments.map((d) => d.id).sort()).toEqual(['shop/api', 'shop/worker']);
    expect(s.collections.pods.every((p) => p.namespace === 'shop')).toBe(true);
  });

  it('scales with a merge-patch that carries the resourceVersion precondition', async () => {
    const cmd = { op: 'update' as const, collection: 'deployments', pk: 'default/web', patch: { replicas: 4 }, before: { replicas: 2 } };
    expect(a.describe(cmd)).toBe('kubectl scale deployment/web -n default --replicas=4');
    await a.execute(cmd);
    const p = kube.patches.at(-1)!;
    expect(p.contentType).toBe('application/merge-patch+json');
    expect(p.body).toMatchObject({ metadata: { resourceVersion: expect.any(String) }, spec: { replicas: 4 } });
    expect(kube.podsOf('default/web')).toBe(4);
    expect((await a.snapshot(['deployments'])).collections.deployments.find((d) => d.id === 'default/web')!.ready_replicas).toBe(4);
  });

  it('stops instead of overwriting when someone else changed it after the preview', async () => {
    kube.scaleBehindBack('default/web', 5); // 미리보기는 4 를 봤다
    const n = kube.patches.length;
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: 'default/web', patch: { replicas: 6 }, before: { replicas: 4 } })).rejects.toBeInstanceOf(ConflictError);
    expect(kube.patches.length).toBe(n); // 아예 보내지 않았다
    expect(kube.podsOf('default/web')).toBe(5);
  });

  it('refuses anything but replicas, bad ids and absurd sizes', async () => {
    await expect(a.execute({ op: 'update' as const, collection: 'pods', pk: 'default/x', patch: { phase: 'Running' }, before: {} })).rejects.toBeInstanceOf(UnsupportedCommandError);
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: 'default/web', patch: { name: 'x' }, before: {} })).rejects.toBeInstanceOf(UnsupportedCommandError);
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: '../../api/v1/secrets', patch: { replicas: 1 }, before: { replicas: 5 } })).rejects.toThrow(/잘못된/);
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: 'default/web', patch: { replicas: 10_000 }, before: { replicas: 5 } })).rejects.toThrow(/0~100/);
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: 'default/web', patch: { replicas: -1 }, before: { replicas: 5 } })).rejects.toThrow(/0~100/);
    await expect(a.execute({ op: 'update' as const, collection: 'deployments', pk: 'default/gone', patch: { replicas: 1 }, before: { replicas: 1 } })).rejects.toBeInstanceOf(ConflictError);
  });

  it('pushes changes through the watch API', async () => {
    const seen: string[][] = [];
    const stop = await a.watch((c) => seen.push(c));
    await new Promise((r) => setTimeout(r, 200));
    kube.scaleBehindBack('shop/api', 1);
    for (let i = 0; i < 50 && !seen.some((c) => c.includes('deployments')); i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen.flat()).toEqual(expect.arrayContaining(['deployments', 'pods']));
    await stop();
  });

  it('keeps each watch subscription independent', async () => {
    const one: string[][] = [];
    const two: string[][] = [];
    const stopOne = await a.watch((c) => one.push(c));
    const stopTwo = await a.watch((c) => two.push(c));
    await new Promise((r) => setTimeout(r, 200));
    await stopOne(); // 하나를 끊어도 다른 구독은 살아 있다
    kube.scaleBehindBack('shop/api', 2);
    for (let i = 0; i < 50 && !two.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(two.flat()).toContain('deployments');
    expect(one).toHaveLength(0);
    await stopTwo();
  });
});
