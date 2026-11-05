import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DockerAdapter, type DockerAdapterOptions } from './docker.ts';
import { HttpJsonAdapter, type HttpJsonAdapterOptions } from './http-json.ts';
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

export type AdapterConfig =
  | ({ type: 'postgres' } & PostgresAdapterOptions)
  | ({ type: 'http' } & HttpJsonAdapterOptions)
  | ({ type: 'docker' } & DockerAdapterOptions)
  /** OpenTelemetry 트레이스 수신기(OTLP/HTTP JSON) */
  | ({ type: 'otel' } & OtelAdapterOptions)
  /** 직접 만든 어댑터 모듈: default export 가 (options) => Adapter (defineAdapter 사용 권장) */
  | { type: 'module'; path: string; options?: Record<string, unknown> };

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
  }
}

/** 내장 어댑터 + 사용자 모듈 어댑터를 모두 만든다. path 는 baseDir 기준. */
export async function loadAdapter(config: AdapterConfig, baseDir = process.cwd()): Promise<Adapter> {
  if (config.type !== 'module') return createAdapter(config);
  const mod = (await import(pathToFileURL(path.resolve(baseDir, config.path)).href)) as { default?: unknown; createAdapter?: unknown };
  const factory = mod.default ?? mod.createAdapter;
  const adapter = typeof factory === 'function' ? await (factory as (o: unknown) => Adapter | Promise<Adapter>)(config.options ?? {}) : factory;
  if (!adapter || typeof (adapter as Adapter).snapshot !== 'function') throw new Error(`${config.path} 는 어댑터를 내보내지 않습니다(default export 가 (options) => Adapter 여야 함)`);
  return adapter as Adapter;
}
