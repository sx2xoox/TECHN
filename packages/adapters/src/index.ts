import { DockerAdapter, type DockerAdapterOptions } from './docker.ts';
import { HttpJsonAdapter, type HttpJsonAdapterOptions } from './http-json.ts';
import { PostgresAdapter, type PostgresAdapterOptions } from './postgres.ts';
import type { Adapter } from './types.ts';

export * from './types.ts';
export * from './infer.ts';
export * from './postgres.ts';
export * from './http-json.ts';
export * from './docker.ts';

export type AdapterConfig =
  | ({ type: 'postgres' } & PostgresAdapterOptions)
  | ({ type: 'http' } & HttpJsonAdapterOptions)
  | ({ type: 'docker' } & DockerAdapterOptions);

export function createAdapter(config: AdapterConfig): Adapter {
  switch (config.type) {
    case 'postgres':
      return new PostgresAdapter(config);
    case 'http':
      return new HttpJsonAdapter(config);
    case 'docker':
      return new DockerAdapter(config);
  }
}
