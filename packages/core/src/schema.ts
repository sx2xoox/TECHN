import type { Expr } from './expr.ts';

/** 시스템 쪽(실제 소프트웨어)의 데이터 모델. 어댑터가 introspection으로 만들어 낸다. */
export type FieldType = 'integer' | 'number' | 'string' | 'boolean' | 'timestamp' | 'json';

export interface FieldRef {
  collection: string;
  field: string;
  /** 다른 시스템을 가리키는 연결(여러 시스템을 한 세계로 묶을 때 생긴다) */
  crossSystem?: boolean;
}

export interface FieldStats {
  min?: number;
  max?: number;
  distinct?: number;
  samples?: unknown[];
}

export interface FieldSchema {
  name: string;
  type: FieldType;
  nullable: boolean;
  /** 외래키(혹은 이름으로 추론한 참조) */
  ref?: FieldRef;
  /** DB enum 혹은 관측된 저카디널리티 값 목록 */
  enumValues?: string[];
  unique?: boolean;
  /** 비밀번호·이메일 등: 세계에 절대 그려지지 않고, 인스펙터에서도 마스킹된다 */
  sensitive?: boolean;
  /** 참조가 DB 제약으로 강제되는지(true) 이름 추론인지(false) */
  refEnforced?: boolean;
  /** 시스템(어댑터)이 이 필드로의 쓰기를 받지 않는다: 보이기만 하고, 세계에서 바꾸는 행동은 만들지 않는다 */
  readOnly?: boolean;
  /**
   * 다른 시스템에서도 같은 것을 가리키는 이름 체계(예: 'service' — OpenTelemetry 의 service.name 과 Kubernetes 디플로이먼트 이름).
   * 여러 시스템을 한 세계로 묶을 때 같은 joinKey 끼리 자동으로 연결한다.
   */
  joinKey?: string;
  stats?: FieldStats;
}

export interface CollectionSchema {
  name: string;
  primaryKey: string;
  fields: FieldSchema[];
  rowCountHint?: number;
  description?: string;
  /** 여러 시스템을 한 세계로 묶었을 때 이 컬렉션이 속한 시스템의 짧은 이름(db·otel·k8s …) */
  system?: string;
}

/** DB CHECK 제약처럼 시스템이 스스로 선언한 규칙 */
export interface SchemaConstraint {
  collection: string;
  expr: Expr;
  description: string;
  enforced: boolean;
}

export interface SystemSchema {
  system: string;
  source: 'postgres' | 'http' | 'docker' | 'custom';
  collections: CollectionSchema[];
  constraints: SchemaConstraint[];
}

export type Pk = string | number;
export type Row = Record<string, unknown>;

/** 한 시점의 시스템 상태 */
export interface Snapshot {
  ts: number;
  collections: Record<string, Row[]>;
  /**
   * 관측 창(최근 N행) 밖에 실제로 존재함이 확인된 참조 값. 키는 `${collection}.${field}`.
   * 창 밖에 있을 뿐인 행을 '가리키는 대상이 없는 행'(유령)으로 잘못 그리지 않기 위해 쓴다.
   */
  outside?: Record<string, unknown[]>;
}

export function findCollection(schema: SystemSchema, name: string): CollectionSchema | undefined {
  return schema.collections.find((c) => c.name === name);
}

export function findField(schema: SystemSchema, collection: string, field: string): FieldSchema | undefined {
  return findCollection(schema, collection)?.fields.find((f) => f.name === field);
}

export function pkOf(row: Row, collection: CollectionSchema): Pk {
  const v = row[collection.primaryKey];
  return typeof v === 'number' ? v : String(v);
}

const SENSITIVE_RE = /(pass(word)?|passwd|secret|token|api_?key|ssn|card_?number|cvv|email|phone|mobile|address|birth)/i;

/** 이름 규칙으로 민감 필드를 표시한다. 어댑터 introspection 직후 호출. */
export function markSensitive(schema: SystemSchema): SystemSchema {
  return {
    ...schema,
    collections: schema.collections.map((c) => ({
      ...c,
      fields: c.fields.map((f) => (SENSITIVE_RE.test(f.name) ? { ...f, sensitive: true } : f)),
    })),
  };
}

/** writable('collection.field') 에 없는 필드는 모두 읽기 전용으로 표시한다(쓰기 경로가 좁은 어댑터용) */
export function readOnlyExcept(schema: SystemSchema, writable: string[]): SystemSchema {
  const ok = new Set(writable);
  return {
    ...schema,
    collections: schema.collections.map((c) => ({ ...c, fields: c.fields.map((f) => (ok.has(`${c.name}.${f.name}`) ? f : { ...f, readOnly: true })) })),
  };
}

const LOW_CARDINALITY = 8;

/** 샘플 행들로부터 필드 통계를 채운다(컴파일러의 판단 근거). */
export function attachStats(schema: SystemSchema, snapshot: Snapshot): SystemSchema {
  return {
    ...schema,
    collections: schema.collections.map((c) => {
      const rows = snapshot.collections[c.name] ?? [];
      return {
        ...c,
        rowCountHint: rows.length,
        fields: c.fields.map((f) => {
          const values = rows.map((r) => r[f.name]).filter((v) => v !== null && v !== undefined);
          const stats: FieldStats = { distinct: new Set(values.map((v) => JSON.stringify(v))).size };
          // 민감 필드는 개수만 센다: 표본 값·범위·enum 을 만들지 않는다(통계는 LLM 프롬프트·공유본으로도 나가므로)
          if (f.sensitive) return { ...f, stats };
          const nums = values.filter((v): v is number => typeof v === 'number');
          if (nums.length) {
            stats.min = Math.min(...nums);
            stats.max = Math.max(...nums);
          }
          stats.samples = values.slice(0, 5);
          let enumValues = f.enumValues;
          if (!enumValues && f.type === 'string' && values.length >= 3 && (stats.distinct ?? 0) <= LOW_CARDINALITY) {
            const distinct = [...new Set(values.map(String))];
            // 값이 반복될 때만 enum으로 간주(이름·이메일 같은 고유값 제외)
            if (distinct.length < values.length) enumValues = distinct.sort();
          }
          return { ...f, stats, ...(enumValues ? { enumValues } : {}) };
        }),
      };
    }),
  };
}
