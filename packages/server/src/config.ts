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
}

export function loadConfig(file: string): IsomorphConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as IsomorphConfig;
  const base = path.dirname(path.resolve(file));
  const rel = (p?: string) => (p ? path.resolve(base, p) : undefined);
  const relOpt = (v: unknown) => (typeof v === 'string' && (v.startsWith('./') || v.startsWith('../')) ? rel(v) : v);
  const adapter =
    raw.adapter.type === 'module'
      ? { ...raw.adapter, path: rel(raw.adapter.path)!, options: Object.fromEntries(Object.entries(raw.adapter.options ?? {}).map(([k, v]) => [k, relOpt(v)])) }
      : raw.adapter;
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
export function configFromTarget(targets: string[], opts: { schema?: string; port?: number; host?: string; write?: IsomorphConfig['writeMode'] } = {}): IsomorphConfig {
  const [target] = targets;
  if (!target) throw new Error('연결할 대상을 주세요: postgres://… · https://… · otel · docker');
  let adapter: AdapterConfig;
  if (/^postgres(ql)?:\/\//i.test(target)) {
    const system = decodeURIComponent(new URL(target).pathname.replace(/^\//, '')) || 'postgres';
    adapter = { type: 'postgres', connectionString: target, system, ...(opts.schema ? { schema: opts.schema } : {}) };
  } else if (/^https?:\/\//i.test(target)) {
    const urls = targets.map((t) => new URL(t));
    const origin = urls[0].origin;
    if (urls.some((u) => u.origin !== origin)) throw new Error('HTTP 대상은 모두 같은 호스트여야 합니다');
    adapter = {
      type: 'http',
      system: urls[0].hostname,
      baseUrl: origin,
      collections: urls.map((u) => ({ name: u.pathname.split('/').filter(Boolean).at(-1) ?? 'items', path: `${u.pathname}${u.search}` })),
    };
  } else if (target === 'otel') {
    // 수신기도 같은 주소에서 듣는다(컨테이너에서는 0.0.0.0)
    adapter = { type: 'otel', port: 4318, ...(opts.host ? { host: opts.host } : {}), ...(process.env.ISOMORPH_OTLP_TOKEN ? { token: process.env.ISOMORPH_OTLP_TOKEN } : {}) };
  } else if (target === 'docker') {
    adapter = { type: 'docker' };
  } else {
    throw new Error(`알 수 없는 대상: ${target} (postgres://… · https://… · otel · docker)`);
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
