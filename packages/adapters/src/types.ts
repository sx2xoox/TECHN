import type { Row, Snapshot, SystemSchema, UpdateCommand } from '@isomorph/core';

/** 실제 시스템과 ISOMORPH 사이의 유일한 통로. 읽기(introspect/snapshot)와 쓰기(execute)를 분리한다. */
export interface Adapter {
  readonly kind: 'postgres' | 'http' | 'docker';
  readonly system: string;
  connect(): Promise<void>;
  introspect(): Promise<SystemSchema>;
  snapshot(): Promise<Snapshot>;
  /** 명령 실행. 변경 전 값(before)이 현재와 다르면 ConflictError (낙관적 동시성) */
  execute(cmd: UpdateCommand): Promise<void>;
  /** 드라이런 화면에 보여줄 사람이 읽을 수 있는 명령 (SQL·HTTP) */
  describe(cmd: UpdateCommand): string;
  close(): Promise<void>;
}

export class ConflictError extends Error {
  constructor(message = '미리보기 이후 상태가 바뀌었습니다. 다시 미리보기 하세요.') {
    super(message);
  }
}

export class UnsupportedCommandError extends Error {}

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** 어댑터 공통: 값을 JSON 으로 안전하게(날짜→ISO, bigint/numeric 문자열→숫자) */
export function normalizeRow(row: Row, schema: SystemSchema, collection: string): Row {
  const col = schema.collections.find((c) => c.name === collection);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const f = col?.fields.find((x) => x.name === k);
    out[k] = normalizeValue(v, f?.type);
  }
  return out;
}

export function normalizeValue(v: unknown, type?: string): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if ((type === 'integer' || type === 'number') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (type === 'timestamp' && typeof v === 'string' && ISO_RE.test(v)) {
    const t = Date.parse(v.replace(' ', 'T'));
    return Number.isNaN(t) ? v : new Date(t).toISOString();
  }
  if (type === 'timestamp' && typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (type === 'boolean' && typeof v === 'string') return v === 'true' || v === 't';
  if (v instanceof Uint8Array) return '<binary>';
  return v;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
