import { markSensitive, type CollectionSchema, type Expr, type FieldType, type SchemaConstraint, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import pg from 'pg';
import { inferRefs } from './infer.ts';
import { ConflictError, normalizeRow, quoteIdent, sqlLiteral, type Adapter } from './types.ts';

/** pg.Client, pg.Pool, PGlite 모두 만족하는 최소 인터페이스 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null; affectedRows?: number }>;
}

export interface PostgresAdapterOptions {
  connectionString?: string;
  queryable?: Queryable;
  schema?: string;
  tables?: string[];
  rowLimit?: number;
  system?: string;
  /**
   * 푸시 관측(선택, 대상 DB 에 트리거를 설치함):
   *  - 'listen': 문장 단위 트리거가 pg_notify → 별도 연결에서 LISTEN (PostgreSQL)
   *  - 'log'   : 트리거가 isomorph_change_log 에 기록 → feedMs 간격으로 아주 가볍게 확인
   *              (알림을 전달하지 않는 호환 DB·프록시에서도 동작)
   */
  changeFeed?: 'listen' | 'log';
  feedMs?: number;
}

export const FEED_TABLE = 'isomorph_change_log';
const FEED_CHANNEL = 'isomorph_changes';

function mapType(dataType: string, udt: string, enums: Map<string, string[]>): { type: FieldType; enumValues?: string[] } {
  const t = dataType.toLowerCase();
  if (['integer', 'bigint', 'smallint'].includes(t)) return { type: 'integer' };
  if (['numeric', 'real', 'double precision', 'decimal'].includes(t)) return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t.startsWith('timestamp') || t === 'date') return { type: 'timestamp' };
  if (t === 'json' || t === 'jsonb') return { type: 'json' };
  if (t === 'user-defined' && enums.has(udt)) return { type: 'string', enumValues: enums.get(udt) };
  return { type: 'string' };
}

const OP_MAP: Record<string, '>=' | '>' | '<=' | '<' | '==' | '!='> = { '>=': '>=', '>': '>', '<=': '<=', '<': '<', '=': '==', '<>': '!=' };

/**
 * `CHECK ((stock >= 0))`, `CHECK ((capacity > (0)::numeric))`, `CHECK ((kind <> 'x'::text))`,
 * `CHECK ((started_at <= ended_at))` 같은 단일 비교 CHECK 제약을 불변식 식으로 해석한다.
 * AND/OR 등 복합 조건은 해석하지 않는다(null).
 */
export function parseCheck(def: string): Expr | null {
  const s = def
    .trim()
    .replace(/::[a-z_][a-z0-9_ ]*(\[\])?/gi, '') // 타입 캐스트 제거
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^CHECK "?([a-zA-Z_][\w]*)"? ?(>=|<=|<>|!=|>|<|=) ?('(?:[^']|'')*'|-?\d+(?:\.\d+)?|"?[a-zA-Z_][\w]*"?)$/i.exec(s);
  if (!m) return null;
  const cmp = OP_MAP[m[2] === '!=' ? '<>' : m[2]];
  const rhs = m[3];
  if (rhs.startsWith("'")) return { op: 'cmp', field: m[1], cmp, value: rhs.slice(1, -1).replace(/''/g, "'") };
  if (/^-?\d/.test(rhs)) return { op: 'cmp', field: m[1], cmp, value: Number(rhs) };
  const lower = rhs.replace(/"/g, '').toLowerCase();
  if (lower === 'true' || lower === 'false') return { op: 'cmp', field: m[1], cmp, value: lower === 'true' };
  if (lower === 'null') return null;
  return { op: 'cmpField', field: m[1], cmp, other: rhs.replace(/"/g, '') };
}

export class PostgresAdapter implements Adapter {
  readonly kind = 'postgres' as const;
  readonly system: string;
  private db: Queryable | null;
  private client: pg.Client | null = null;
  private schemaName: string;
  private cached: SystemSchema | null = null;

  constructor(private opts: PostgresAdapterOptions) {
    this.db = opts.queryable ?? null;
    this.schemaName = opts.schema ?? 'public';
    this.system = opts.system ?? 'postgres';
  }

  async connect() {
    if (this.db) return;
    this.client = new pg.Client({ connectionString: this.opts.connectionString });
    await this.client.connect();
    this.db = this.client;
  }

  private q() {
    if (!this.db) throw new Error('PostgresAdapter: connect() 를 먼저 호출하세요');
    return this.db;
  }

  async introspect(): Promise<SystemSchema> {
    const db = this.q();
    const s = this.schemaName;
    const enumRows = (await db.query(
      `select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace where n.nspname = $1 order by t.typname, e.enumsortorder`,
      [s],
    )).rows;
    const enums = new Map<string, string[]>();
    for (const r of enumRows) enums.set(String(r.typname), [...(enums.get(String(r.typname)) ?? []), String(r.enumlabel)]);

    const cols = (await db.query(
      `select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
         from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = $1 and t.table_type = 'BASE TABLE'
        order by c.table_name, c.ordinal_position`,
      [s],
    )).rows;
    const keys = (await db.query(
      `select tc.table_name, tc.constraint_type, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
         left join information_schema.constraint_column_usage ccu
           on tc.constraint_type = 'FOREIGN KEY' and tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
        where tc.table_schema = $1 and tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')`,
      [s],
    )).rows;
    const checks = (await db.query(
      `select rel.relname as table_name, pg_get_constraintdef(con.oid) as def
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace nsp on nsp.oid = rel.relnamespace
        where nsp.nspname = $1 and con.contype = 'c'`,
      [s],
    )).rows;

    const tables = new Map<string, CollectionSchema>();
    for (const r of cols) {
      const table = String(r.table_name);
      if (this.opts.tables && !this.opts.tables.includes(table)) continue;
      if (table.startsWith('isomorph_')) continue; // ISOMORPH 자신의 보조 테이블은 세계에 그리지 않는다
      const c = tables.get(table) ?? { name: table, primaryKey: '', fields: [] };
      const { type, enumValues } = mapType(String(r.data_type), String(r.udt_name), enums);
      c.fields.push({ name: String(r.column_name), type, nullable: r.is_nullable === 'YES', ...(enumValues ? { enumValues } : {}) });
      tables.set(table, c);
    }
    for (const k of keys) {
      const c = tables.get(String(k.table_name));
      if (!c) continue;
      const f = c.fields.find((x) => x.name === k.column_name);
      if (!f) continue;
      if (k.constraint_type === 'PRIMARY KEY' && !c.primaryKey) c.primaryKey = f.name;
      if (k.constraint_type === 'UNIQUE') f.unique = true;
      if (k.constraint_type === 'FOREIGN KEY' && k.ref_table) {
        f.ref = { collection: String(k.ref_table), field: String(k.ref_column) };
        f.refEnforced = true;
      }
    }
    for (const c of tables.values()) if (!c.primaryKey) c.primaryKey = c.fields.find((f) => f.name === 'id')?.name ?? c.fields[0]?.name ?? 'id';

    const constraints: SchemaConstraint[] = [];
    for (const ch of checks) {
      const expr = parseCheck(String(ch.def));
      if (!expr || !tables.has(String(ch.table_name))) continue;
      constraints.push({ collection: String(ch.table_name), expr, description: String(ch.def), enforced: true });
    }
    const schema = markSensitive({
      system: this.system,
      source: 'postgres',
      collections: inferRefs([...tables.values()]),
      constraints,
    });
    this.cached = schema;
    return schema;
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    const db = this.q();
    const schema = this.cached ?? (await this.introspect());
    const limit = this.opts.rowLimit ?? 500;
    const collections: Snapshot['collections'] = {};
    for (const c of schema.collections) {
      if (only && !only.includes(c.name)) continue;
      const res = await db.query(`select * from ${quoteIdent(this.schemaName)}.${quoteIdent(c.name)} order by ${quoteIdent(c.primaryKey)} desc limit ${Number(limit)}`);
      collections[c.name] = res.rows.reverse().map((r) => normalizeRow(r, schema, c.name));
    }
    return { ts: Date.now(), collections };
  }

  private validate(cmd: UpdateCommand) {
    const col = this.cached?.collections.find((c) => c.name === cmd.collection);
    if (!col) throw new Error(`알 수 없는 테이블: ${cmd.collection}`);
    for (const k of [...Object.keys(cmd.patch), ...Object.keys(cmd.before)]) {
      if (!col.fields.some((f) => f.name === k)) throw new Error(`알 수 없는 컬럼: ${cmd.collection}.${k}`);
    }
    return col;
  }

  describe(cmd: UpdateCommand): string {
    const col = this.validate(cmd);
    const sets = Object.entries(cmd.patch).map(([k, v]) => `${quoteIdent(k)} = ${sqlLiteral(v)}`).join(', ');
    const guards = Object.entries(cmd.before).map(([k, v]) => ` AND ${quoteIdent(k)} IS NOT DISTINCT FROM ${sqlLiteral(v)}`).join('');
    return `UPDATE ${quoteIdent(cmd.collection)} SET ${sets} WHERE ${quoteIdent(col.primaryKey)} = ${sqlLiteral(cmd.pk)}${guards};`;
  }

  async execute(cmd: UpdateCommand): Promise<void> {
    const col = this.validate(cmd);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const sets = Object.entries(cmd.patch).map(([k, v]) => `${quoteIdent(k)} = ${p(v)}`).join(', ');
    const where = [`${quoteIdent(col.primaryKey)} = ${p(cmd.pk)}`, ...Object.entries(cmd.before).map(([k, v]) => `${quoteIdent(k)} IS NOT DISTINCT FROM ${p(v)}`)];
    const res = await this.q().query(`update ${quoteIdent(this.schemaName)}.${quoteIdent(cmd.collection)} set ${sets} where ${where.join(' and ')}`, params);
    const n = res.rowCount ?? res.affectedRows ?? 0;
    if (n !== 1) throw new ConflictError();
  }

  private feedSql(mode: 'listen' | 'log') {
    const sc = quoteIdent(this.schemaName);
    const fn = `${sc}.${quoteIdent(`isomorph_feed_${mode}`)}`;
    const body = mode === 'listen'
      ? `perform pg_notify('${FEED_CHANNEL}', TG_TABLE_NAME);`
      : `insert into ${sc}.${quoteIdent(FEED_TABLE)} (tbl) values (TG_TABLE_NAME);`;
    return { sc, fn, body };
  }

  /** 문장 단위(FOR EACH STATEMENT) 트리거 설치 — 행마다가 아니라 문장마다 한 번이라 부담이 작다 */
  async installFeed(mode: 'listen' | 'log'): Promise<void> {
    const db = this.q();
    const schema = this.cached ?? (await this.introspect());
    const { sc, fn, body } = this.feedSql(mode);
    if (mode === 'log') {
      await db.query(`create table if not exists ${sc}.${quoteIdent(FEED_TABLE)} (id bigserial primary key, tbl text not null, at timestamptz not null default clock_timestamp())`);
    }
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $$ begin ${body} return null; end $$`);
    for (const c of schema.collections) {
      const t = `${sc}.${quoteIdent(c.name)}`;
      await db.query(`drop trigger if exists isomorph_feed on ${t}`);
      await db.query(`create trigger isomorph_feed after insert or update or delete on ${t} for each statement execute function ${fn}()`);
    }
  }

  /** 설치한 트리거·함수·로그 테이블을 모두 제거한다 */
  async uninstallFeed(): Promise<void> {
    const db = this.q();
    const schema = this.cached ?? (await this.introspect());
    const sc = quoteIdent(this.schemaName);
    for (const c of schema.collections) await db.query(`drop trigger if exists isomorph_feed on ${sc}.${quoteIdent(c.name)}`);
    await db.query(`drop function if exists ${sc}.isomorph_feed_listen()`);
    await db.query(`drop function if exists ${sc}.isomorph_feed_log()`);
    await db.query(`drop table if exists ${sc}.${quoteIdent(FEED_TABLE)}`);
  }

  async watch(onChange: (collections: string[]) => void): Promise<(() => Promise<void>) | null> {
    const mode = this.opts.changeFeed;
    if (!mode) return null;
    await this.installFeed(mode);
    if (mode === 'listen') {
      if (!this.opts.connectionString) throw new Error("changeFeed 'listen' 에는 connectionString 이 필요합니다");
      const listener = new pg.Client({ connectionString: this.opts.connectionString });
      await listener.connect();
      listener.on('notification', (m) => m.payload && onChange([m.payload]));
      await listener.query(`listen ${FEED_CHANNEL}`);
      return async () => {
        await listener.end().catch(() => {});
      };
    }
    // 'log' 모드: 마지막으로 본 id 이후의 변경만 확인
    const db = this.q();
    const table = `${quoteIdent(this.schemaName)}.${quoteIdent(FEED_TABLE)}`;
    let last = Number((await db.query(`select coalesce(max(id), 0) as id from ${table}`)).rows[0].id);
    let stopped = false;
    let busy = false;
    let sincePrune = 0;
    const timer = setInterval(async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const rows = (await db.query(`select id, tbl from ${table} where id > $1 order by id limit 2000`, [last])).rows;
        if (rows.length) {
          last = Number(rows[rows.length - 1].id);
          onChange([...new Set(rows.map((r) => String(r.tbl)))]);
        }
        if ((sincePrune += 1) > 200) {
          sincePrune = 0;
          await db.query(`delete from ${table} where at < now() - interval '10 minutes'`);
        }
      } catch {
        /* 다음 주기에 다시 */
      } finally {
        busy = false;
      }
    }, this.opts.feedMs ?? 50);
    return async () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async close() {
    await this.client?.end();
    this.client = null;
    if (!this.opts.queryable) this.db = null;
  }
}
