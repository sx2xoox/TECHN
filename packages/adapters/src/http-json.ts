import { markSensitive, pkOf, type Row, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { inferCollection, inferRefs } from './infer.ts';
import { ConflictError, normalizeRow, UnsupportedCommandError, type Adapter } from './types.ts';

export interface HttpCollectionConfig {
  name: string;
  path: string;
  primaryKey?: string;
  update?: { method?: 'PATCH' | 'PUT' | 'POST'; path: string };
}

export interface HttpJsonAdapterOptions {
  system: string;
  baseUrl: string;
  headers?: Record<string, string>;
  collections: HttpCollectionConfig[];
  fetchImpl?: typeof fetch;
}

function rowsOf(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  if (body && typeof body === 'object') {
    for (const k of ['data', 'items', 'results', 'rows', 'records']) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Row[];
    }
    return [body as Row];
  }
  return [];
}

/** 스키마 없는 REST/JSON 시스템: 표본으로 스키마를 추론하고 PATCH 로 쓴다. */
export class HttpJsonAdapter implements Adapter {
  readonly kind = 'http' as const;
  readonly system: string;
  private schema: SystemSchema | null = null;
  private fetch: typeof fetch;

  constructor(private opts: HttpJsonAdapterOptions) {
    this.system = opts.system;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  async connect() {}

  private url(path: string) {
    return new URL(path, this.opts.baseUrl).toString();
  }

  private async getRows(path: string): Promise<Row[]> {
    const res = await this.fetch(this.url(path), { headers: { accept: 'application/json', ...this.opts.headers } });
    // 오류 문구에는 경로만(쿼리의 api_key 같은 값은 넣지 않는다)
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} → ${res.status}`);
    return rowsOf(await res.json());
  }

  async introspect(): Promise<SystemSchema> {
    const collections = [];
    for (const c of this.opts.collections) collections.push(inferCollection(c.name, await this.getRows(c.path), c.primaryKey));
    this.schema = markSensitive({ system: this.system, source: 'http', collections: inferRefs(collections), constraints: [] });
    return this.schema;
  }

  async snapshot(_only?: string[]): Promise<Snapshot> {
    const schema = this.schema ?? (await this.introspect());
    const collections: Snapshot['collections'] = {};
    await Promise.all(
      this.opts.collections.map(async (c) => {
        collections[c.name] = (await this.getRows(c.path)).map((r) => normalizeRow(r, schema, c.name));
      }),
    );
    return { ts: Date.now(), collections };
  }

  private target(cmd: UpdateCommand) {
    const c = this.opts.collections.find((x) => x.name === cmd.collection);
    if (!c?.update) throw new UnsupportedCommandError(`${cmd.collection} 은(는) 쓰기 경로가 설정되지 않았습니다`);
    const id = String(cmd.pk);
    // encodeURIComponent 는 '.'·'..' 를 그대로 두므로, 그런 id 는 경로를 위로 올라가게 만든다(/items/.. → /)
    if (id === '' || id === '.' || id === '..') throw new UnsupportedCommandError(`이 id(${JSON.stringify(id)})로는 안전한 쓰기 경로를 만들 수 없습니다`);
    return { method: c.update.method ?? 'PATCH', path: c.update.path.replace(':id', encodeURIComponent(id)), config: c };
  }

  describe(cmd: UpdateCommand): string {
    const t = this.target(cmd);
    return `${t.method} ${t.path} ${JSON.stringify(cmd.patch)}`;
  }

  async execute(cmd: UpdateCommand): Promise<void> {
    const t = this.target(cmd);
    // HTTP 에는 조건부 갱신이 없으므로 직전 상태를 다시 읽어 확인한다
    const schema = this.schema ?? (await this.introspect());
    const col = schema.collections.find((c) => c.name === cmd.collection)!;
    const current = (await this.getRows(t.config.path)).map((r) => normalizeRow(r, schema, cmd.collection)).find((r) => String(pkOf(r, col)) === String(cmd.pk));
    if (!current) throw new ConflictError('대상이 더 이상 존재하지 않습니다');
    for (const [k, v] of Object.entries(cmd.before)) {
      if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v)) throw new ConflictError();
    }
    const res = await this.fetch(this.url(t.path), {
      method: t.method,
      headers: { 'content-type': 'application/json', ...this.opts.headers },
      body: JSON.stringify(cmd.patch),
    });
    if (res.status === 409 || res.status === 412) throw new ConflictError();
    // 상대 응답 본문은 짧게만(모든 접속에 보이는 행동 기록에 남기 때문)
    if (!res.ok) throw new Error(`${t.method} ${t.path.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  }

  async close() {}
}
