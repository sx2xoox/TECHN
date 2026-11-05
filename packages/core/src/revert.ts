import type { ChangeEvent } from './diff.ts';
import { evalExpr, fieldsOfExpr, type EvalContext } from './expr.ts';
import type { Invariant } from './grammar.ts';
import type { Row, SystemSchema } from './schema.ts';
import type { Violation } from './world.ts';

/**
 * 직전 변경 되돌리기: 많은 장애는 '무언가를 바꾼 직후' 에 시작된다(배포한 이미지, 설정 값…).
 * 위반이 시작되기 전 일정 시간 안에 이 행이 받은 마지막 변경을 찾아, 그 변경을 되돌리는 안을 만든다.
 *  - 시스템이 쓰기를 받는 필드만(읽기 전용·민감·기본키·'문제가 비롯된 곳' 참조·json 은 제외)
 *  - 법칙이 직접 보는 필드는 제외: 증상(재고 수, 준비된 수)을 덮는 것이 아니라 원인이 된 변경을 되돌린다
 *  - 그 뒤로 다시 바뀐 필드는 제외(되돌리면 남의 변경을 덮어쓴다)
 * 실행은 다른 행동과 똑같이 드라이런 → 승인 → 실행 → 관측으로 확인 → 되돌리기를 거친다.
 */
export interface RevertProposal {
  /** 되돌릴 변경이 일어난 시각 */
  at: number;
  changes: { field: string; now: unknown; to: unknown }[];
}

const ROW_LOCAL = new Set(['cmp', 'cmpField', 'in', 'notNull', 'and', 'or', 'not', 'implies']);
const NO_CTX: EvalContext = { valuesOf: () => new Set(), countOf: () => 0 };

export function findRevert(v: Violation, events: ChangeEvent[], schema: SystemSchema, inv: Invariant | undefined, rowNow: Row, windowMs = 30 * 60_000): RevertProposal | null {
  const col = schema.collections.find((c) => c.name === v.collection);
  if (!col || !inv || !ROW_LOCAL.has(inv.expr.op)) return null;
  const lawFields = new Set(fieldsOfExpr(inv.expr));
  // 시각·버전 같은 장부 필드는 '변경' 이 아니라 기록이다: 되돌리지 않는다(낙관적 잠금 카운터를 되감으면 오히려 위험)
  const BOOKKEEPING = /^(created|updated|modified|changed|inserted|deleted)(_at|_on|_time|_by)?$|(^|_)(version|revision|lock|etag|xmin|row_version|seq)$/i;
  const writable = new Set(
    col.fields
      .filter((f) => !f.readOnly && !f.sensitive && f.name !== col.primaryKey && !lawFields.has(f.name) && !f.ref?.blame && f.type !== 'json' && f.type !== 'timestamp' && !BOOKKEEPING.test(f.name))
      .map((f) => f.name),
  );
  if (!writable.size) return null;
  const self = events.filter((e) => e.collection === v.collection && String(e.pk) === String(v.pk)).sort((a, b) => a.ts - b.ts);
  // 위반이 시작된 순간(지키던 → 어김)
  let onset: number | undefined;
  for (const e of self) {
    const afterOk = e.after ? evalExpr(inv.expr, e.after, NO_CTX) : true;
    const beforeOk = e.before ? evalExpr(inv.expr, e.before, NO_CTX) : true;
    if (!afterOk && beforeOk) onset = e.ts;
  }
  if (onset === undefined) return null; // 관측을 시작하기 전부터 깨져 있었다면 무엇이 먼저였는지 모른다
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const candidates = self.filter((e) => e.kind === 'update' && e.before && e.after && e.ts <= onset! && e.ts >= onset! - windowMs && [...writable].some((f) => !same(e.before![f], e.after![f])));
  const last = candidates.at(-1);
  if (!last) return null;
  const changes = [...writable]
    .filter((f) => !same(last.before![f], last.after![f]) && same(rowNow[f], last.after![f]))
    .map((f) => ({ field: f, now: rowNow[f], to: last.before![f] }));
  return changes.length ? { at: last.ts, changes } : null;
}
