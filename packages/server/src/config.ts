import fs from 'node:fs';
import path from 'node:path';
import { parseGrammar, type AssetManifest, type WorldGrammar, type WriteMode } from '@isomorph/core';
import type { AdapterConfig } from '@isomorph/adapters';

export interface IsomorphConfig {
  adapter: AdapterConfig;
  compile?: { mode?: 'heuristic' | 'llm' | 'auto'; model?: string };
  /** 고정 문법 파일(있으면 컴파일 대신 사용, 그래도 검증은 한다) */
  grammarPath?: string;
  writeMode?: WriteMode;
  pollMs?: number;
  port?: number;
  host?: string;
  storePath?: string;
  numRuns?: number;
  assetsDir?: string;
  /** 운영자 토큰(없으면 ISOMORPH_TOKEN) */
  token?: string;
  /** 관람자 토큰(없으면 ISOMORPH_VIEWER_TOKEN) */
  viewerToken?: string;
  /** 사람들이 세계를 여는 주소(알림 링크의 앞부분). 없으면 ISOMORPH_PUBLIC_URL, 그것도 없으면 로컬 주소일 때만 그 주소 */
  publicUrl?: string;
  /**
   * 법칙이 깨지면 웹훅으로 알린다. 웹훅 주소는 비밀이므로 파일보다 ISOMORPH_NOTIFY_URL 환경변수를 권한다.
   * format: auto(주소로 판단) · slack · discord · json
   */
  notify?: { webhook?: string; format?: 'auto' | 'slack' | 'discord' | 'json'; minSeverity?: 'info' | 'warning' | 'critical'; batchMs?: number; cooldownMs?: number; resolved?: boolean };
}

export function loadConfig(file: string): IsomorphConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as IsomorphConfig;
  const base = path.dirname(path.resolve(file));
  const rel = (p?: string) => (p ? path.resolve(base, p) : undefined);
  const relOpt = (v: unknown) => (typeof v === 'string' && (v.startsWith('./') || v.startsWith('../')) ? rel(v) : v);
  // 직접 만든 모듈의 경로는 설정 파일 기준(여러 시스템 묶음 안에 있어도)
  const resolve = (a: AdapterConfig): AdapterConfig =>
    a.type === 'module'
      ? { ...a, path: rel(a.path)!, options: Object.fromEntries(Object.entries(a.options ?? {}).map(([k, v]) => [k, relOpt(v)])) }
      : a.type === 'composite'
        ? { ...a, parts: a.parts.map((p) => ({ ...p, adapter: resolve(p.adapter) })) }
        : a;
  const adapter = resolve(raw.adapter);
  return { ...raw, adapter, grammarPath: rel(raw.grammarPath), storePath: raw.storePath === ':memory:' ? raw.storePath : rel(raw.storePath), assetsDir: rel(raw.assetsDir) };
}

export function loadGrammar(file: string): WorldGrammar {
  const r = parseGrammar(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!r.ok) throw new Error(`문법 파일 구조 오류:\n${r.errors.join('\n')}`);
  return r.value;
}

export function loadAssets(dir?: string): AssetManifest | null {
  if (!dir) return null;
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as AssetManifest;
}

/**
 * 설정 파일 없이 대상 하나로 바로 연결할 때의 설정(읽기 전용·로컬 전용이 기본).
 *   postgres://… · postgresql://…   PostgreSQL
 *   http(s)://host/path [더 많은 경로…]   HTTP/JSON(같은 호스트의 목록 API 들)
 *   otel   OpenTelemetry 트레이스 수신(OTLP/HTTP JSON, 4318)
 *   docker   로컬 Docker 엔진
 */
type TargetOpts = { schema?: string; namespace?: string; port?: number; host?: string; write?: IsomorphConfig['writeMode']; context?: string; kubeconfig?: string };

const TARGETS_HELP = 'postgres://… · https://… · otel · docker · kubernetes · prometheus[=http://…:9090]';

/** 대상 하나(또는 같은 호스트의 HTTP 경로 묶음) → 어댑터 설정과 짧은 이름 */
function adapterFor(group: string[], opts: TargetOpts): { name: string; adapter: AdapterConfig } {
  const [target] = group;
  if (/^postgres(ql)?:\/\//i.test(target)) {
    const system = decodeURIComponent(new URL(target).pathname.replace(/^\//, '')) || 'postgres';
    return { name: 'db', adapter: { type: 'postgres', connectionString: target, system, ...(opts.schema ? { schema: opts.schema } : {}) } };
  }
  if (/^https?:\/\//i.test(target)) {
    const urls = group.map((t) => new URL(t));
    return {
      name: 'api',
      adapter: {
        type: 'http',
        system: urls[0].hostname,
        baseUrl: urls[0].origin,
        collections: urls.map((u) => ({ name: u.pathname.split('/').filter(Boolean).at(-1) ?? 'items', path: `${u.pathname}${u.search}` })),
      },
    };
  }
  if (target === 'otel') {
    // 수신기도 같은 주소에서 듣는다(컨테이너에서는 0.0.0.0)
    return { name: 'otel', adapter: { type: 'otel', port: 4318, ...(opts.host ? { host: opts.host } : {}), ...(process.env.ISOMORPH_OTLP_TOKEN ? { token: process.env.ISOMORPH_OTLP_TOKEN } : {}) } };
  }
  if (target === 'docker') return { name: 'docker', adapter: { type: 'docker' } };
  // prometheus 또는 prometheus=http://주소:9090 (기본 http://127.0.0.1:9090)
  if (target === 'prometheus' || target.startsWith('prometheus=')) return { name: 'metrics', adapter: { type: 'prometheus', url: target.includes('=') ? target.slice(target.indexOf('=') + 1) : 'http://127.0.0.1:9090' } };
  if (target === 'kubernetes' || target === 'k8s') {
    const ns = opts.namespace ?? opts.schema;
    return { name: 'k8s', adapter: { type: 'kubernetes', ...(ns ? { namespace: ns } : {}), ...(opts.context ? { context: opts.context } : {}), ...(opts.kubeconfig ? { kubeconfig: opts.kubeconfig } : {}) } };
  }
  throw new Error(`알 수 없는 대상: ${target} (${TARGETS_HELP})`);
}

/**
 * 명령줄 대상 → 설정. 종류가 다른 대상을 여러 개 주면 한 세계로 묶는다(시스템 사이 연결은 자동으로 찾는다).
 *   connect postgres://…/shop otel kubernetes
 */
export function configFromTarget(targets: string[], opts: TargetOpts = {}): IsomorphConfig {
  if (!targets.length) throw new Error(`연결할 대상을 주세요: ${TARGETS_HELP}`);
  // 같은 호스트의 HTTP 경로는 하나로 묶는다
  const groups: string[][] = [];
  for (const t of targets) {
    const origin = /^https?:\/\//i.test(t) ? new URL(t).origin : null;
    const g = origin ? groups.find((x) => /^https?:\/\//i.test(x[0]) && new URL(x[0]).origin === origin) : undefined;
    if (g) g.push(t);
    else groups.push([t]);
  }
  const parts = groups.map((g) => adapterFor(g, opts));
  let adapter: AdapterConfig;
  if (parts.length === 1) adapter = parts[0].adapter;
  else {
    const seen = new Map<string, number>();
    adapter = {
      type: 'composite',
      parts: parts.map((p) => {
        const n = (seen.get(p.name) ?? 0) + 1;
        seen.set(p.name, n);
        return { name: n === 1 ? p.name : `${p.name}${n}`, adapter: p.adapter };
      }),
    };
  }
  return {
    adapter,
    compile: { mode: 'auto' },
    writeMode: opts.write ?? 'read-only',
    port: opts.port ?? 4000,
    host: opts.host ?? '127.0.0.1',
    pollMs: 2000,
  };
}
