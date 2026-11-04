import { z } from 'zod';
import type { Row } from './schema.ts';

/**
 * 불변식(=세계의 물리 법칙)을 표현하는 작고 안전한 식 언어.
 * 임의 코드 실행 없이 JSON으로 저장·검증·LLM 생성이 가능하다.
 */
export type CmpOp = '>=' | '>' | '<=' | '<' | '==' | '!=';
export type Literal = number | string | boolean | null;

export type Expr =
  | { op: 'cmp'; field: string; cmp: CmpOp; value: Literal }
  | { op: 'cmpField'; field: string; cmp: CmpOp; other: string }
  | { op: 'notNull'; field: string }
  | { op: 'in'; field: string; values: Literal[] }
  | { op: 'refExists'; field: string; collection: string; target: string }
  | { op: 'unique'; field: string }
  | { op: 'and'; args: Expr[] }
  | { op: 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'implies'; if: Expr; then: Expr };

const CmpOpSchema = z.enum(['>=', '>', '<=', '<', '==', '!=']);
const LiteralSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ op: z.literal('cmp'), field: z.string(), cmp: CmpOpSchema, value: LiteralSchema }),
    z.object({ op: z.literal('cmpField'), field: z.string(), cmp: CmpOpSchema, other: z.string() }),
    z.object({ op: z.literal('notNull'), field: z.string() }),
    z.object({ op: z.literal('in'), field: z.string(), values: z.array(LiteralSchema) }),
    z.object({ op: z.literal('refExists'), field: z.string(), collection: z.string(), target: z.string() }),
    z.object({ op: z.literal('unique'), field: z.string() }),
    z.object({ op: z.literal('and'), args: z.array(ExprSchema) }),
    z.object({ op: z.literal('or'), args: z.array(ExprSchema) }),
    z.object({ op: z.literal('not'), arg: ExprSchema }),
    z.object({ op: z.literal('implies'), if: ExprSchema, then: ExprSchema }),
  ]),
);

/** 컬렉션 단위 판정(참조 존재, 유일성)에 필요한 문맥 */
export interface EvalContext {
  /** collection.field 의 값 집합 */
  valuesOf(collection: string, field: string): Set<string>;
  /** 현재 컬렉션에서 field 값별 등장 횟수 */
  countOf(field: string, value: unknown): number;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function toComparable(v: unknown): number | string | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string' && ISO_RE.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return String(v);
}

export function compare(a: unknown, op: CmpOp, b: unknown): boolean {
  const x = toComparable(a);
  const y = toComparable(b);
  if (op === '==') return x === y;
  if (op === '!=') return x !== y;
  // SQL CHECK 의미론: NULL 은 판정 불가 → 위반 아님
  if (x === null || y === null) return true;
  if (typeof x === 'number' && typeof y === 'number') {
    switch (op) {
      case '>=': return x >= y;
      case '>': return x > y;
      case '<=': return x <= y;
      case '<': return x < y;
    }
  }
  const c = String(x).localeCompare(String(y));
  switch (op) {
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
  }
}

export function keyOf(v: unknown): string {
  return typeof v === 'string' ? `s:${v}` : `j:${JSON.stringify(v)}`;
}

export function evalExpr(expr: Expr, row: Row, ctx: EvalContext): boolean {
  switch (expr.op) {
    case 'cmp':
      return compare(row[expr.field], expr.cmp, expr.value);
    case 'cmpField':
      return compare(row[expr.field], expr.cmp, row[expr.other]);
    case 'notNull':
      return row[expr.field] !== null && row[expr.field] !== undefined;
    case 'in': {
      const v = row[expr.field];
      if (v === null || v === undefined) return true;
      return expr.values.some((x) => x === v || String(x) === String(v));
    }
    case 'refExists': {
      const v = row[expr.field];
      if (v === null || v === undefined) return true;
      return ctx.valuesOf(expr.collection, expr.target).has(keyOf(v));
    }
    case 'unique': {
      const v = row[expr.field];
      if (v === null || v === undefined) return true;
      return ctx.countOf(expr.field, v) <= 1;
    }
    case 'and':
      return expr.args.every((a) => evalExpr(a, row, ctx));
    case 'or':
      return expr.args.some((a) => evalExpr(a, row, ctx));
    case 'not':
      return !evalExpr(expr.arg, row, ctx);
    case 'implies':
      return !evalExpr(expr.if, row, ctx) || evalExpr(expr.then, row, ctx);
  }
}

export function fieldsOfExpr(expr: Expr): string[] {
  switch (expr.op) {
    case 'cmp':
    case 'notNull':
    case 'in':
    case 'refExists':
    case 'unique':
      return [expr.field];
    case 'cmpField':
      return [expr.field, expr.other];
    case 'and':
    case 'or':
      return expr.args.flatMap(fieldsOfExpr);
    case 'not':
      return fieldsOfExpr(expr.arg);
    case 'implies':
      return [...fieldsOfExpr(expr.if), ...fieldsOfExpr(expr.then)];
  }
}

const CMP_KO: Record<CmpOp, string> = { '>=': '≥', '>': '>', '<=': '≤', '<': '<', '==': '=', '!=': '≠' };

export function describeExpr(expr: Expr): string {
  switch (expr.op) {
    case 'cmp':
      return `${expr.field} ${CMP_KO[expr.cmp]} ${JSON.stringify(expr.value)}`;
    case 'cmpField':
      return `${expr.field} ${CMP_KO[expr.cmp]} ${expr.other}`;
    case 'notNull':
      return `${expr.field} 는 비어 있으면 안 됨`;
    case 'in':
      return `${expr.field} ∈ {${expr.values.map((v) => JSON.stringify(v)).join(', ')}}`;
    case 'refExists':
      return `${expr.field} 가 가리키는 ${expr.collection}.${expr.target} 가 존재해야 함`;
    case 'unique':
      return `${expr.field} 는 유일해야 함`;
    case 'and':
      return expr.args.map(describeExpr).join(' 그리고 ');
    case 'or':
      return expr.args.map(describeExpr).join(' 또는 ');
    case 'not':
      return `아님(${describeExpr(expr.arg)})`;
    case 'implies':
      return `${describeExpr(expr.if)} 이면 ${describeExpr(expr.then)}`;
  }
}
