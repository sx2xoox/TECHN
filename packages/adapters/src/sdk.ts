import { markSensitive, readOnlyExcept, type Row, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { inferCollection, inferRefs } from './infer.ts';
import { normalizeRow, UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * 어댑터 SDK — 어떤 시스템이든 "행들을 읽는 함수" 하나만 있으면 세계로 열 수 있다.
 *
 *   export default (options) => defineAdapter({
 *     system: 'my-system',
 *     collections: [{ name: 'jobs', primaryKey: 'id' }],
 *     async read() { return { jobs: await fetchJobs() } },
 *   })
 *
 * 스키마를 주지 않으면 첫 표본에서 타입·참조(xxx_id)·민감 필드를 추론한다.
 * write 가 없으면 읽기 전용, watch 가 있으면 변경 즉시 관측(푸시)한다.
 */
export interface AdapterSpec {
  system: string;
  collections?: { name: string; primaryKey?: string }[];
  /** 명시적 스키마(제약·enum·참조를 정확히 알 때) */
  schema?: SystemSchema | (() => Promise<SystemSchema>);
  connect?(): Promise<void>;
  /** only 가 주어지면 그 컬렉션만 읽어도 된다 */
  read(only?: string[]): Promise<Record<string, Row[]>>;
  write?(cmd: UpdateCommand): Promise<void>;
  describe?(cmd: UpdateCommand): string;
  watch?(onChange: (collections: string[]) => void): Promise<(() => Promise<void>) | null>;
  /** 일부만 읽는 시스템이라면: values 중 실제로 존재하는 값만 돌려준다(창 밖 참조를 유령으로 오판하지 않게) */
  lookup?(collection: string, field: string, values: unknown[]): Promise<unknown[]>;
  close?(): Promise<void>;
}

export function defineAdapter(spec: AdapterSpec): Adapter {
  let schema: SystemSchema | null = null;
  const introspect = async (): Promise<SystemSchema> => {
    if (spec.schema) {
      const s = typeof spec.schema === 'function' ? await spec.schema() : spec.schema;
      schema = markSensitive({ ...s, source: 'custom' });
      if (!spec.write) schema = readOnlyExcept(schema, []);
      return schema;
    }
    const rows = await spec.read();
    const names = spec.collections?.map((c) => c.name) ?? Object.keys(rows);
    const cols = names.map((n) => inferCollection(n, rows[n] ?? [], spec.collections?.find((c) => c.name === n)?.primaryKey));
    schema = markSensitive({ system: spec.system, source: 'custom', collections: inferRefs(cols), constraints: [] });
    if (!spec.write) schema = readOnlyExcept(schema, []);
    return schema;
  };
  return {
    kind: 'custom',
    system: spec.system,
    async connect() {
      await spec.connect?.();
    },
    introspect,
    async snapshot(only?: string[]): Promise<Snapshot> {
      const s = schema ?? (await introspect());
      const rows = await spec.read(only);
      const collections: Snapshot['collections'] = {};
      for (const c of s.collections) {
        if (only && !only.includes(c.name)) continue;
        collections[c.name] = (rows[c.name] ?? []).map((r) => normalizeRow(r, s, c.name));
      }
      return { ts: Date.now(), collections };
    },
    async execute(cmd) {
      if (!spec.write) throw new UnsupportedCommandError(`${spec.system} 어댑터는 읽기 전용입니다`);
      await spec.write(cmd);
    },
    describe(cmd) {
      return spec.describe ? spec.describe(cmd) : `${cmd.collection}#${cmd.pk} ← ${JSON.stringify(cmd.patch)}`;
    },
    ...(spec.watch ? { watch: spec.watch.bind(spec) } : {}),
    ...(spec.lookup ? { lookup: spec.lookup.bind(spec) } : {}),
    async close() {
      await spec.close?.();
    },
  };
}
