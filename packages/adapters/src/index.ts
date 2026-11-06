import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompositeAdapter, type CompositeLinkSpec } from './composite.ts';
import { DockerAdapter, type DockerAdapterOptions } from './docker.ts';
import { HttpJsonAdapter, type HttpJsonAdapterOptions } from './http-json.ts';
import { KubernetesAdapter, type KubernetesAdapterOptions } from './kubernetes.ts';
import { MetricsAdapter, PROMETHEUS_DEFAULTS, type MetricsAdapterOptions } from './metrics.ts';
import { OtelAdapter, type OtelAdapterOptions } from './otel.ts';
import { PostgresAdapter, type PostgresAdapterOptions } from './postgres.ts';
import type { Adapter } from './types.ts';

export * from './types.ts';
export * from './infer.ts';
export * from './postgres.ts';
export * from './http-json.ts';
export * from './docker.ts';
export * from './sdk.ts';
export * from './otel.ts';
export * from './otel-proto.ts';
export * from './kubernetes.ts';
export * from './composite.ts';

export type AdapterConfig =
  | ({ type: 'postgres' } & PostgresAdapterOptions)
  | ({ type: 'http' } & HttpJsonAdapterOptions)
  | ({ type: 'docker' } & DockerAdapterOptions)
  /** OpenTelemetry 트레이스 수신기(OTLP/HTTP JSON) */
  | ({ type: 'otel' } & OtelAdapterOptions)
  /** Kubernetes(kubeconfig 또는 server/token) */
  | ({ type: 'kubernetes' } & KubernetesAdapterOptions)
  /** 서비스 지표(Prometheus HTTP API): 지표마다 '평소보다 크게 오르면 안 됨' */
  | ({ type: 'prometheus' } & Omit<MetricsAdapterOptions, 'ignore' | 'now' | 'fetchImpl'> & { url: string })
  /** 직접 만든 어댑터 모듈: default export 가 (options) => Adapter (defineAdapter 사용 권장) */
  | { type: 'module'; path: string; options?: Record<string, unknown> }
  /** 여러 시스템을 한 세계로(이름 = 컬렉션 앞에 붙는 짧은 이름) */
  | { type: 'composite'; parts: { name: string; adapter: AdapterConfig }[]; links?: CompositeLinkSpec[]; autoLink?: boolean; system?: string };

export function createAdapter(config: AdapterConfig): Adapter {
  switch (config.type) {
    case 'module':
      throw new Error("module 어댑터는 loadAdapter() 로 불러오세요(비동기)");
    case 'postgres':
      return new PostgresAdapter(config);
    case 'http':
      return new HttpJsonAdapter(config);
    case 'docker':
      return new DockerAdapter(config);
    case 'otel':
      return new OtelAdapter(config);
    case 'kubernetes':
      return new KubernetesAdapter(config);
    case 'prometheus':
      return new MetricsAdapter({ system: 'prometheus', queries: PROMETHEUS_DEFAULTS, by: 'container', ...config });
    case 'composite':
      return new CompositeAdapter({ ...config, parts: config.parts.map((p) => ({ name: p.name, adapter: createAdapter(p.adapter) })) });
  }
}

/** 내장 어댑터 + 사용자 모듈 어댑터를 모두 만든다. path 는 baseDir 기준. */
export async function loadAdapter(config: AdapterConfig, baseDir = process.cwd()): Promise<Adapter> {
  if (config.type === 'composite') {
    const parts = await Promise.all(config.parts.map(async (p) => ({ name: p.name, adapter: await loadAdapter(p.adapter, baseDir) })));
    return new CompositeAdapter({ ...config, parts });
  }
  if (config.type !== 'module') return createAdapter(config);
  const mod = (await import(pathToFileURL(path.resolve(baseDir, config.path)).href)) as { default?: unknown; createAdapter?: unknown };
  const factory = mod.default ?? mod.createAdapter;
  const adapter = typeof factory === 'function' ? await (factory as (o: unknown) => Adapter | Promise<Adapter>)(config.options ?? {}) : factory;
  if (!adapter || typeof (adapter as Adapter).snapshot !== 'function') throw new Error(`${config.path} 는 어댑터를 내보내지 않습니다(default export 가 (options) => Adapter 여야 함)`);
  return adapter as Adapter;
}
export * from './metrics.ts';
