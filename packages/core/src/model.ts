import type { ChangeEvent } from './diff.ts';
import { maskRow } from './legend.ts';
import { findCollection, pkOf, type CollectionSchema, type Pk, type Row, type Snapshot, type SystemSchema } from './schema.ts';

/**
 * 시스템 동역학 학습: 이벤트 기록만 보고 "이 시스템은 어떻게 움직이는가"를 사람이 읽을 수 있는 규칙으로 뽑는다.
 *   - 발생률(rate): 어떤 컬렉션에 새 행이 얼마나 자주 생기는가, 어디를 가리키는가
 *   - 상태 전이(transition): pending → paid 가 몇 %, 얼마 뒤에
 *   - 효과(effect): 주문이 paid 가 되면 대상 재고 −1
 *   - 관문(gate): 대상 재고가 0 이하일 때 생긴 주문은 failed
 *   - 보충(replenish): 재고는 가끔 바깥에서 채워진다(설명되지 않는 증가)
 * 모든 규칙은 관측 건수와 함께 나오며, 시뮬레이터는 이 규칙만으로 미래를 굴린다.
 */

export interface LearnedRate {
  collection: string;
  perMinute: number;
  samples: number;
  /** 참조 필드별 대상 분포(대상 pk → 비율) */
  targets: Record<string, Record<string, number>>;
  /** 새 행의 본보기(타임스탬프·상태는 시뮬레이터가 채운다) */
  template: Row;
}

export interface LearnedTransition {
  collection: string;
  field: string;
  from: string;
  to: string;
  prob: number;
  dwellMs: number;
  samples: number;
}

export interface LearnedEffect {
  source: string;
  refField: string;
  target: string;
  field: string;
  delta: number;
  /** 원천 행이 이 상태가 될 때 효과가 일어난다(없으면 lagMs 뒤) */
  onStatus?: { field: string; value: string };
  lagMs: number;
  samples: number;
}

export interface LearnedGate {
  source: string;
  refField: string;
  target: string;
  field: string;
  /** 대상 값이 이 조건이면 */
  when: { op: '<=' | '=='; value: number | boolean };
  /** 원천 행의 결과가 이것이 된다(효과 없음) */
  outcome: { field: string; value: string };
  prob: number;
  samples: number;
}

export interface LearnedReplenish {
  target: string;
  field: string;
  perMinute: number;
  meanDelta: number;
  /** 보충이 일어났던 직전 값 범위 */
  between: [number, number];
  samples: number;
}

export interface SystemModel {
  learnedFrom: { events: number; spanMs: number; start: number; end: number };
  rates: LearnedRate[];
  initialStatus: { collection: string; field: string; value: string }[];
  transitions: LearnedTransition[];
  effects: LearnedEffect[];
  gates: LearnedGate[];
  replenish: LearnedReplenish[];
  /** 시뮬레이션하지 않는(현재 값을 유지하는) 필드 */
  frozen: string[];
  /** 사람이 읽는 규칙 설명 */
  rules: string[];
}

const CREATED_RE = /^(created|inserted|opened|started|issued|recorded)(_at|_on|_time)?$/i;
const UPDATED_RE = /^(updated|modified|changed)(_at|_on|_time)?$/i;

function timeOf(row: Row | null, re: RegExp, fallback: number): number {
  if (!row) return fallback;
  for (const [k, v] of Object.entries(row)) {
    if (!re.test(k)) continue;
    const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const key = (v: unknown) => String(v);

function enumFields(c: CollectionSchema) {
  return c.fields.filter((f) => f.type === 'string' && !f.ref && (f.enumValues?.length ?? 0) > 1 && f.name !== c.primaryKey);
}

interface InsertRec {
  collection: string;
  pk: string;
  at: number;
  row: Row;
  /** 삽입 순간 참조 대상들의 상태(관문 학습용) */
  targetState: Record<string, Row | undefined>;
  statusPath: { field: string; value: string; at: number }[];
}

export function learnModel(initial: Snapshot, events: ChangeEvent[], schema: SystemSchema): SystemModel {
  const evs = [...events].sort((a, b) => a.ts - b.ts);
  const start = initial.ts;
  const end = evs.length ? evs[evs.length - 1].ts : start;
  const spanMs = Math.max(1, end - start);

  // 실행 중 상태(직전 틱 기준)
  const state = new Map<string, Map<string, Row>>();
  for (const c of schema.collections) state.set(c.name, new Map((initial.collections[c.name] ?? []).map((r) => [key(pkOf(r, c)), r])));

  const inserts = new Map<string, InsertRec>(); // `${col}:${pk}`
  const insertsByTarget = new Map<string, InsertRec[]>(); // `${R}.${f}->${T}:${pk}`
  const numericChanges: { target: string; field: string; pk: string; delta: number; before: number; ts: number }[] = [];

  // 틱 단위로 묶어서 처리: 같은 틱의 삽입은 '직전 틱' 상태를 본다
  let i = 0;
  while (i < evs.length) {
    const ts = evs[i].ts;
    const tick: ChangeEvent[] = [];
    while (i < evs.length && evs[i].ts === ts) tick.push(evs[i++]);
    for (const e of tick) {
      const col = findCollection(schema, e.collection);
      if (!col) continue;
      if (e.kind === 'insert' && e.after) {
        const targetState: Record<string, Row | undefined> = {};
        for (const f of col.fields) {
          if (!f.ref || e.after[f.name] === null || e.after[f.name] === undefined) continue;
          targetState[f.name] = state.get(f.ref.collection)?.get(key(e.after[f.name]));
        }
        const rec: InsertRec = { collection: col.name, pk: key(e.pk), at: timeOf(e.after, CREATED_RE, ts), row: e.after, targetState, statusPath: [] };
        for (const ef of enumFields(col)) if (e.after[ef.name] !== null && e.after[ef.name] !== undefined) rec.statusPath.push({ field: ef.name, value: key(e.after[ef.name]), at: rec.at });
        inserts.set(`${col.name}:${rec.pk}`, rec);
        for (const f of col.fields) {
          if (!f.ref || e.after[f.name] === null || e.after[f.name] === undefined) continue;
          const k = `${col.name}.${f.name}->${f.ref.collection}:${key(e.after[f.name])}`;
          const list = insertsByTarget.get(k) ?? [];
          list.push(rec);
          insertsByTarget.set(k, list);
        }
      } else if (e.kind === 'update' && e.before && e.after) {
        const rec = inserts.get(`${col.name}:${key(e.pk)}`);
        if (rec) {
          for (const ef of enumFields(col)) {
            if (key(e.before[ef.name]) !== key(e.after[ef.name]) && e.after[ef.name] !== null) {
              rec.statusPath.push({ field: ef.name, value: key(e.after[ef.name]), at: timeOf(e.after, UPDATED_RE, ts) });
            }
          }
        }
        for (const f of col.fields) {
          if ((f.type !== 'integer' && f.type !== 'number') || f.ref || f.name === col.primaryKey) continue;
          const b = e.before[f.name];
          const a = e.after[f.name];
          if (typeof b === 'number' && typeof a === 'number' && a !== b) numericChanges.push({ target: col.name, field: f.name, pk: key(e.pk), delta: a - b, before: b, ts });
        }
      }
    }
    // 틱 적용
    for (const e of tick) {
      const m = state.get(e.collection);
      if (!m) continue;
      if (e.kind === 'delete') m.delete(key(e.pk));
      else if (e.after) m.set(key(e.pk), e.after);
    }
  }

  const rules: string[] = [];
  const all = [...inserts.values()];

  // 0) 동시 폭주 감지: 같은 대상을 100ms 안에 3건 이상 가리키는 삽입 묶음은 '사건'이지 평소 흐름이 아니다
  const burstRecs = new Set<InsertRec>();
  for (const [, list] of insertsByTarget) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    for (let a = 0; a < sorted.length; a++) {
      let b = a;
      while (b + 1 < sorted.length && sorted[b + 1].at - sorted[a].at <= 100) b++;
      if (b - a + 1 >= 3) for (let k = a; k <= b; k++) burstRecs.add(sorted[k]);
    }
  }

  // 1) 발생률(폭주 제외)
  const rates: LearnedRate[] = [];
  for (const c of schema.collections) {
    const recs = all.filter((r) => r.collection === c.name && !burstRecs.has(r));
    const bursts = all.filter((r) => r.collection === c.name && burstRecs.has(r)).length;
    if (recs.length < 3) continue;
    const targets: LearnedRate['targets'] = {};
    for (const f of c.fields) {
      if (!f.ref) continue;
      const counts: Record<string, number> = {};
      for (const r of recs) if (r.row[f.name] !== null && r.row[f.name] !== undefined) counts[key(r.row[f.name])] = (counts[key(r.row[f.name])] ?? 0) + 1;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total) targets[f.name] = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]));
    }
    const perMinute = (recs.length / spanMs) * 60_000;
    // 본뜰 행(template)은 클라이언트로도 가므로 민감 필드를 가린다(시뮬레이션에는 실제 값이 필요 없다)
    rates.push({ collection: c.name, perMinute, samples: recs.length, targets, template: maskRow(recs[recs.length - 1].row, c) });
    rules.push(`${c.name}: 분당 약 ${perMinute.toFixed(1)}건 새로 생김 (관측 ${recs.length}건${bursts ? `, 동시 폭주 ${bursts}건은 평소 흐름에서 제외` : ''})`);
  }

  // 2) 관문: 삽입 순간 대상 상태에 따라 최종 결과가 갈리는가
  //    여러 관문이 겹치면(예: 판매 중지된 '재고 0' 상품) 다른 관문이 이미 설명하는 행은 근거에서 뺀다(explain-away).
  const finalOf = (r: InsertRec, field: string) => [...r.statusPath].reverse().find((p) => p.field === field)?.value;
  interface GateCand {
    gate: LearnedGate;
    recs: InsertRec[];
    cond: (r: InsertRec) => boolean | undefined;
  }
  const cands: GateCand[] = [];
  for (const c of schema.collections) {
    const recs = all.filter((r) => r.collection === c.name);
    if (recs.length < 5) continue;
    for (const ef of enumFields(c)) {
      for (const f of c.fields) {
        if (!f.ref) continue;
        const target = findCollection(schema, f.ref.collection);
        if (!target) continue;
        for (const tf of target.fields) {
          if (tf.name === target.primaryKey || tf.ref) continue;
          const isNum = tf.type === 'integer' || tf.type === 'number';
          const isBool = tf.type === 'boolean';
          if (!isNum && !isBool) continue;
          const cond = (r: InsertRec) => {
            const v = r.targetState[f.name]?.[tf.name];
            if (isNum) return typeof v === 'number' ? v <= 0 : undefined;
            return typeof v === 'boolean' ? v === false : undefined;
          };
          const yes = recs.filter((r) => cond(r) === true);
          const outcomes = new Set(yes.map((r) => finalOf(r, ef.name)).filter((x): x is string => !!x));
          for (const value of outcomes) {
            const gate: LearnedGate = { source: c.name, refField: f.name, target: target.name, field: tf.name, when: isNum ? { op: '<=', value: 0 } : { op: '==', value: false }, outcome: { field: ef.name, value }, prob: 0, samples: 0 };
            cands.push({ gate, recs, cond });
          }
        }
      }
    }
  }
  const sameCond = (a: LearnedGate, b: LearnedGate) => a.source === b.source && a.refField === b.refField && a.target === b.target && a.field === b.field;
  /** 다른(결과가 다른) 관문이 이 행의 결과를 이미 설명하는가 */
  const explainedBy = (r: InsertRec, me: GateCand, others: GateCand[]) =>
    others.some((o) => o !== me && !sameCond(o.gate, me.gate) && o.gate.outcome.value !== me.gate.outcome.value && o.gate.source === r.collection && o.cond(r) === true && finalOf(r, o.gate.outcome.field) === o.gate.outcome.value);
  const stats = (cand: GateCand, others: GateCand[]) => {
    const kept = cand.recs.filter((r) => !explainedBy(r, cand, others));
    const yes = kept.filter((r) => cand.cond(r) === true);
    const no = kept.filter((r) => cand.cond(r) === false);
    const hit = (r: InsertRec) => finalOf(r, cand.gate.outcome.field) === cand.gate.outcome.value;
    return { yes: yes.length, no: no.length, pYes: yes.length ? yes.filter(hit).length / yes.length : 0, pNo: no.length ? no.filter(hit).length / no.length : 1, excluded: cand.recs.length - kept.length };
  };
  const strong = (st: ReturnType<typeof stats>) => st.yes >= 2 && st.no >= 3 && st.pYes >= 0.7 && st.pNo <= 0.3;
  const accepted: GateCand[] = [];
  for (let round = 0; round < 4; round++) {
    const fresh = cands.filter((cd) => !accepted.includes(cd) && strong(stats(cd, accepted)));
    if (!fresh.length) break;
    accepted.push(...fresh);
  }
  // 겹치는 행에서 실제로 이긴 관문을 앞에 둔다(시뮬레이터는 앞의 관문부터 적용)
  const wins = (a: GateCand, b: GateCand) =>
    a.recs.filter((r) => r.collection === b.gate.source && a.cond(r) === true && b.cond(r) === true && finalOf(r, a.gate.outcome.field) === a.gate.outcome.value).length;
  accepted.sort((a, b) => (a.gate.source === b.gate.source ? wins(b, a) - wins(a, b) : 0));
  const gates: LearnedGate[] = [];
  for (const cd of accepted) {
    const st = stats(cd, accepted);
    if (!strong(st)) continue;
    const g = { ...cd.gate, prob: st.pYes, samples: st.yes };
    gates.push(g);
    rules.push(`${g.target}.${g.field} ${g.when.op === '<=' ? '≤ 0' : '= false'} 일 때 생긴 ${g.source} 는 ${g.outcome.field}=${g.outcome.value} (관측 ${st.yes}건 중 ${pct(st.pYes)}, 아닐 때는 ${pct(st.pNo)}${st.excluded ? ` · 다른 규칙으로 설명되는 ${st.excluded}건 제외` : ''})`);
  }
  const gatedOut = (r: InsertRec) =>
    gates.some((g) => {
      if (g.source !== r.collection) return false;
      const v = r.targetState[g.refField]?.[g.field];
      const hit = g.when.op === '<=' ? typeof v === 'number' && v <= Number(g.when.value) : v === g.when.value;
      return hit && finalOf(r, g.outcome.field) === g.outcome.value;
    });

  // 3) 초기 상태와 상태 전이(관문에 걸린 행은 제외)
  const initialStatus: SystemModel['initialStatus'] = [];
  const transitions: LearnedTransition[] = [];
  for (const c of schema.collections) {
    const recs = all.filter((r) => r.collection === c.name && !gatedOut(r));
    if (recs.length < 3) continue;
    for (const ef of enumFields(c)) {
      const starts: Record<string, number> = {};
      for (const r of recs) {
        const s0 = r.statusPath.find((p) => p.field === ef.name)?.value;
        if (s0) starts[s0] = (starts[s0] ?? 0) + 1;
      }
      const init = Object.entries(starts).sort((a, b) => b[1] - a[1])[0];
      if (!init) continue;
      initialStatus.push({ collection: c.name, field: ef.name, value: init[0] });
      const pairs = new Map<string, number[]>();
      const entered = new Map<string, number>();
      for (const r of recs) {
        const path = r.statusPath.filter((p) => p.field === ef.name);
        for (let k = 0; k < path.length; k++) {
          entered.set(path[k].value, (entered.get(path[k].value) ?? 0) + 1);
          if (k + 1 < path.length) {
            const id = `${path[k].value}→${path[k + 1].value}`;
            const list = pairs.get(id) ?? [];
            list.push(Math.max(0, path[k + 1].at - path[k].at));
            pairs.set(id, list);
          }
        }
      }
      for (const [id, dwell] of pairs) {
        const [from, to] = id.split('→');
        const n = entered.get(from) ?? dwell.length;
        const prob = dwell.length / n;
        if (dwell.length < 2) continue;
        transitions.push({ collection: c.name, field: ef.name, from, to, prob, dwellMs: median(dwell), samples: dwell.length });
      }
      const outs = transitions.filter((t) => t.collection === c.name && t.field === ef.name);
      if (outs.length) {
        rules.push(`${c.name}.${ef.name}: 새 행은 ${init[0]} 로 시작 → ${outs.map((t) => `${t.to} ${pct(t.prob)} (약 ${Math.round(t.dwellMs)}ms 뒤)`).join(', ')}`);
      }
    }
  }

  // 4) 효과: 대상 수치 변화를 원천 행의 상태 전이에 짝지음(같은 틱의 여러 감소는 배수로 처리)
  const effects: LearnedEffect[] = [];
  const explained = new Set<number>();
  for (const c of schema.collections) {
    for (const f of c.fields) {
      if (!f.ref) continue;
      const target = findCollection(schema, f.ref.collection);
      if (!target) continue;
      for (const tf of target.fields) {
        if ((tf.type !== 'integer' && tf.type !== 'number') || tf.ref || tf.name === target.primaryKey) continue;
        const changes = numericChanges.map((ch, idx) => ({ ...ch, idx })).filter((ch) => ch.target === target.name && ch.field === tf.name && ch.delta < 0);
        if (changes.length < 3) continue;
        // 단위 효과 = 원천 후보가 하나뿐인 변화들의 |Δ| 중앙값
        const consumed = new Set<InsertRec>();
        const candidatesFor = (ch: (typeof changes)[number]) =>
          (insertsByTarget.get(`${c.name}.${f.name}->${target.name}:${ch.pk}`) ?? []).filter((r) => r.at <= ch.ts + 50 && ch.ts - r.at <= 15_000 && !consumed.has(r) && !gatedOut(r));
        const singles = changes.filter((ch) => candidatesFor(ch).length === 1).map((ch) => Math.abs(ch.delta));
        const unit = median(singles.length ? singles : changes.map((ch) => Math.abs(ch.delta))) || 1;
        const lags: number[] = [];
        const statusAtEffect: Record<string, number> = {};
        let paired = 0;
        for (const ch of changes) {
          const cands = candidatesFor(ch).sort((a, b) => a.at - b.at);
          const k = Math.max(1, Math.round(Math.abs(ch.delta) / unit));
          const take = cands.slice(0, k);
          if (!take.length) continue;
          explained.add(ch.idx);
          for (const r of take) {
            consumed.add(r);
            paired++;
            lags.push(Math.max(0, ch.ts - r.at));
            // 효과 직후 원천 행이 된 상태(가장 가까운 상태 전이)
            const after = r.statusPath.filter((p) => p.at <= ch.ts + 50).at(-1);
            if (after) statusAtEffect[`${after.field}=${after.value}`] = (statusAtEffect[`${after.field}=${after.value}`] ?? 0) + 1;
          }
        }
        if (paired < 3) continue;
        const top = Object.entries(statusAtEffect).sort((a, b) => b[1] - a[1])[0];
        const init = initialStatus.find((s) => s.collection === c.name);
        let onStatus: LearnedEffect['onStatus'];
        if (top && top[1] / paired >= 0.6) {
          const [field, value] = top[0].split('=');
          if (!init || init.value !== value) onStatus = { field, value };
        }
        effects.push({ source: c.name, refField: f.name, target: target.name, field: tf.name, delta: -unit, onStatus, lagMs: median(lags), samples: paired });
        rules.push(`${c.name} 가 ${onStatus ? `${onStatus.field}=${onStatus.value} 가 되면` : `생기고 약 ${Math.round(median(lags))}ms 뒤`} ${target.name}.${tf.name} −${unit} (관측 ${paired}건)`);
      }
    }
  }

  // 5) 설명되지 않는 증가 = 바깥에서의 보충
  const replenish: LearnedReplenish[] = [];
  const groups = new Map<string, typeof numericChanges>();
  numericChanges.forEach((ch, idx) => {
    if (ch.delta <= 0 || explained.has(idx)) return;
    if (!effects.some((e) => e.target === ch.target && e.field === ch.field)) return;
    const k = `${ch.target}.${ch.field}`;
    groups.set(k, [...(groups.get(k) ?? []), ch]);
  });
  for (const [k, chs] of groups) {
    if (chs.length < 2) continue;
    const [target, field] = k.split('.');
    const befores = chs.map((c) => c.before);
    const r: LearnedReplenish = { target, field, perMinute: (chs.length / spanMs) * 60_000, meanDelta: chs.reduce((a, c) => a + c.delta, 0) / chs.length, between: [Math.min(...befores), Math.max(...befores)], samples: chs.length };
    replenish.push(r);
    rules.push(`${target}.${field} 는 바깥에서 보충됨: 분당 ${r.perMinute.toFixed(1)}회, 평균 +${r.meanDelta.toFixed(1)} (값이 ${r.between[0]}~${r.between[1]} 일 때)`);
  }

  // 6) 시뮬레이션하지 않는 값
  const modeled = new Set([...effects.map((e) => `${e.target}.${e.field}`), ...rates.map((r) => r.collection)]);
  const frozen: string[] = [];
  for (const ch of numericChanges) {
    const k = `${ch.target}.${ch.field}`;
    if (!modeled.has(k) && !modeled.has(ch.target) && !frozen.includes(k)) frozen.push(k);
  }
  if (frozen.length) rules.push(`규칙을 찾지 못해 현재 값으로 고정: ${frozen.join(', ')}`);
  if (!rates.length) rules.push('학습할 기록이 부족합니다(새 행이 생기는 컬렉션을 1분 이상 관측해야 합니다)');

  return { learnedFrom: { events: evs.length, spanMs, start, end }, rates, initialStatus, transitions, effects, gates, replenish, frozen, rules };
}

