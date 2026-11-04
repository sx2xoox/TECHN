import { evaluateInvariants, observe } from './invariants.ts';
import type { WorldGrammar } from './grammar.ts';
import type { SystemModel } from './model.ts';
import { findCollection, pkOf, type Pk, type Row, type Snapshot, type SystemSchema } from './schema.ts';
import type { WorldState } from './world.ts';

/**
 * 가설 시뮬레이터: 학습한 규칙(SystemModel)으로 "만약 ~라면?" 의 미래를 수백 번 굴린다.
 * 결과는 '예측'이지 사실이 아니다 — 화면과 결과에 항상 그렇게 표시한다.
 */

export type HypothesisChange =
  | { kind: 'rate'; collection: string; factor: number }
  | { kind: 'set'; collection: string; pk: Pk; patch: Row }
  | { kind: 'burst'; collection: string; refField: string; target: Pk; count: number; atMs: number; spreadMs: number }
  | { kind: 'transition'; collection: string; field: string; to: string; factor: number }
  | { kind: 'atomic'; target: string; field: string }
  | { kind: 'setAll'; collection: string; patch: Row };

export interface Hypothesis {
  id: string;
  title: string;
  description: string;
  horizonMs: number;
  changes: HypothesisChange[];
}

export interface LawOutcome {
  invariantId: string;
  title: string;
  /** 시간 지평 안에 한 번이라도 깨진 실행의 비율 */
  probability: number;
  /** 깨진 실행들에서 처음 깨진 시각의 중앙값 */
  medianFirstMs: number | null;
  /** 동시에 새로 깨진 행 수의 최댓값(실행 평균) */
  meanMaxCount: number;
  /** 시작 시점(가설 적용 직후)에 이미 깨져 있던 행 수 — 새 위반으로 세지 않는다 */
  preExisting: number;
}

export interface SimulationFrame {
  t: number;
  world: WorldState;
}

export interface SimulationResult {
  hypothesis: Hypothesis;
  runs: number;
  seed: number;
  horizonMs: number;
  laws: LawOutcome[];
  /** 원천 컬렉션별 시뮬레이션된 새 행 수(실행 평균) */
  arrivals: Record<string, number>;
  /** 대표 실행(위반 수가 중앙값인 실행)의 장면들 */
  frames: SimulationFrame[];
  representativeRun: number;
  durationMs: number;
}

export interface SimulateOptions {
  runs?: number;
  seed?: number;
  frameMs?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ev =
  | { at: number; type: 'arrival'; collection: string; forced?: { refField: string; target: Pk } }
  | { at: number; type: 'transition'; collection: string; pk: string; field: string; to: string }
  | { at: number; type: 'effect'; effectIdx: number; sourcePk: string; targetPk: string }
  | { at: number; type: 'replenish'; idx: number };

class Queue {
  private items: Ev[] = [];
  push(e: Ev) {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].at <= e.at) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, e);
  }
  peek() {
    return this.items[0];
  }
  pop() {
    return this.items.shift();
  }
}

const CREATED_RE = /^(created|inserted|opened|started|issued|recorded)(_at|_on|_time)?$/i;
const UPDATED_RE = /^(updated|modified|changed)(_at|_on|_time)?$/i;

function sampleWeighted(weights: Record<string, number>, rnd: () => number, exists: (k: string) => boolean): string | null {
  const entries = Object.entries(weights).filter(([k]) => exists(k));
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (!entries.length || total <= 0) return null;
  let x = rnd() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

function expSample(ratePerMs: number, rnd: () => number) {
  return -Math.log(1 - rnd()) / ratePerMs;
}

function jitter(ms: number, rnd: () => number) {
  return Math.max(1, ms * (0.7 + rnd() * 0.6));
}

interface RunOutput {
  violations: Map<string, { first: number; maxCount: number }>;
  preExisting: Map<string, number>;
  arrivals: Record<string, number>;
  frames: SimulationFrame[];
  totalViolations: number;
}

function runOnce(base: Snapshot, model: SystemModel, h: Hypothesis, grammar: WorldGrammar, schema: SystemSchema, seed: number, frameMs: number, record: boolean): RunOutput {
  const rnd = mulberry32(seed);
  const t0 = base.ts;
  const iso = (t: number) => new Date(t0 + t).toISOString();
  // 상태 복사
  const tables = new Map<string, Map<string, Row>>();
  for (const c of schema.collections) tables.set(c.name, new Map((base.collections[c.name] ?? []).map((r) => [String(pkOf(r, c)), { ...r }])));
  const maxPk = new Map<string, number>();
  for (const c of schema.collections) {
    const nums = [...tables.get(c.name)!.keys()].map(Number).filter((n) => Number.isFinite(n));
    maxPk.set(c.name, nums.length ? Math.max(...nums) : 0);
  }

  // 가설 적용(t=0)
  const rateFactor = new Map<string, number>();
  const transFactor = new Map<string, number>();
  const atomic = new Set<string>();
  for (const ch of h.changes) {
    if (ch.kind === 'rate') rateFactor.set(ch.collection, (rateFactor.get(ch.collection) ?? 1) * ch.factor);
    if (ch.kind === 'transition') transFactor.set(`${ch.collection}.${ch.field}->${ch.to}`, ch.factor);
    if (ch.kind === 'atomic') atomic.add(`${ch.target}.${ch.field}`);
    if (ch.kind === 'set') {
      const row = tables.get(ch.collection)?.get(String(ch.pk));
      if (row) Object.assign(row, ch.patch);
    }
    if (ch.kind === 'setAll') for (const row of tables.get(ch.collection)?.values() ?? []) Object.assign(row, ch.patch);
  }

  const q = new Queue();
  const arrivals: Record<string, number> = {};
  for (const r of model.rates) {
    const rate = (r.perMinute * (rateFactor.get(r.collection) ?? 1)) / 60_000;
    if (rate > 0) q.push({ at: expSample(rate, rnd), type: 'arrival', collection: r.collection });
  }
  for (const ch of h.changes) {
    if (ch.kind !== 'burst') continue;
    for (let k = 0; k < ch.count; k++) q.push({ at: ch.atMs + (ch.count > 1 ? (k / (ch.count - 1)) * ch.spreadMs : 0), type: 'arrival', collection: ch.collection, forced: { refField: ch.refField, target: ch.target } });
  }
  model.replenish.forEach((rp, idx) => {
    if (rp.perMinute > 0) q.push({ at: expSample(rp.perMinute / 60_000, rnd), type: 'replenish', idx });
  });

  const setStatus = (collection: string, pk: string, field: string, value: string, t: number) => {
    const row = tables.get(collection)?.get(pk);
    if (!row) return;
    row[field] = value;
    for (const k of Object.keys(row)) if (UPDATED_RE.test(k)) row[k] = iso(t);
    // 이 상태가 되면 일어나는 효과
    model.effects.forEach((e, effectIdx) => {
      if (e.source !== collection || !e.onStatus || e.onStatus.field !== field || e.onStatus.value !== value) return;
      const target = row[e.refField];
      if (target === null || target === undefined) return;
      q.push({ at: t, type: 'effect', effectIdx, sourcePk: pk, targetPk: String(target) });
    });
    // 다음 전이 예약
    scheduleTransitions(collection, pk, field, value, t);
  };

  const scheduleTransitions = (collection: string, pk: string, field: string, from: string, t: number) => {
    const outs = model.transitions.filter((tr) => tr.collection === collection && tr.field === field && tr.from === from);
    if (!outs.length) return;
    const weights = outs.map((o) => o.prob * (transFactor.get(`${collection}.${field}->${o.to}`) ?? 1));
    const stay = Math.max(0, 1 - outs.reduce((a, o) => a + o.prob, 0));
    const total = weights.reduce((a, b) => a + b, 0) + stay;
    let x = rnd() * total;
    for (let k = 0; k < outs.length; k++) {
      x -= weights[k];
      if (x <= 0) {
        q.push({ at: t + jitter(outs[k].dwellMs, rnd), type: 'transition', collection, pk, field, to: outs[k].to });
        return;
      }
    }
  };

  const gateHit = (collection: string, row: Row, onlyField?: string) => {
    for (const g of model.gates) {
      if (g.source !== collection) continue;
      if (onlyField && `${g.target}.${g.field}` !== onlyField) continue;
      if (!onlyField && atomic.has(`${g.target}.${g.field}`)) continue; // 원자적 수정: 확인은 효과 시점에
      const target = tables.get(g.target)?.get(String(row[g.refField]));
      if (!target) continue;
      const v = target[g.field];
      const hit = g.when.op === '<=' ? typeof v === 'number' && v <= Number(g.when.value) : v === g.when.value;
      if (hit && rnd() < g.prob) return g;
    }
    return null;
  };

  const frames: SimulationFrame[] = [];
  const violations = new Map<string, { first: number; maxCount: number }>();
  const preExisting = new Map<string, number>();
  const initialKeys = new Set<string>();
  let totalViolations = 0;
  const sample = (t: number) => {
    const snap: Snapshot = { ts: t0 + t, collections: Object.fromEntries([...tables].map(([k, m]) => [k, [...m.values()].map((r) => ({ ...r }))])), ...(base.outside ? { outside: base.outside } : {}) };
    const vs = evaluateInvariants(snap, grammar, schema);
    if (t === 0) {
      // 시작 시점에 이미 깨져 있던 것은 이 가설의 결과가 아니다
      for (const v of vs) {
        initialKeys.add(`${v.invariantId}:${String(v.pk)}`);
        preExisting.set(v.invariantId, (preExisting.get(v.invariantId) ?? 0) + 1);
      }
      if (record) frames.push({ t, world: observe(snap, grammar, schema) });
      return;
    }
    const counts = new Map<string, number>();
    for (const v of vs) {
      if (initialKeys.has(`${v.invariantId}:${String(v.pk)}`)) continue;
      counts.set(v.invariantId, (counts.get(v.invariantId) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      const cur = violations.get(id);
      if (!cur) violations.set(id, { first: t, maxCount: n });
      else cur.maxCount = Math.max(cur.maxCount, n);
      totalViolations += n;
    }
    if (record) frames.push({ t, world: observe(snap, grammar, schema) });
  };

  let nextFrame = 0;
  for (;;) {
    const e = q.peek();
    const nextAt = e ? e.at : Infinity;
    while (nextFrame <= h.horizonMs && nextFrame <= nextAt) {
      sample(nextFrame);
      nextFrame += frameMs;
    }
    if (!e || e.at > h.horizonMs) break;
    q.pop();
    const t = e.at;
    if (e.type === 'arrival') {
      const rate = model.rates.find((r) => r.collection === e.collection);
      const col = findCollection(schema, e.collection);
      if (rate && col) {
        if (!e.forced) {
          const r = (rate.perMinute * (rateFactor.get(e.collection) ?? 1)) / 60_000;
          if (r > 0) q.push({ at: t + expSample(r, rnd), type: 'arrival', collection: e.collection });
        }
        const row: Row = { ...rate.template };
        const id = (maxPk.get(e.collection) ?? 0) + 1;
        maxPk.set(e.collection, id);
        row[col.primaryKey] = id;
        for (const f of col.fields) {
          if (f.type === 'timestamp') row[f.name] = iso(t);
          if (!f.ref) continue;
          if (e.forced && e.forced.refField === f.name) row[f.name] = e.forced.target;
          else {
            const pick = sampleWeighted(rate.targets[f.name] ?? {}, rnd, (k) => !!tables.get(f.ref!.collection)?.has(k));
            if (pick !== null) row[f.name] = typeof row[f.name] === 'number' || /^\d+$/.test(pick) ? Number(pick) : pick;
          }
        }
        tables.get(e.collection)!.set(String(id), row);
        arrivals[e.collection] = (arrivals[e.collection] ?? 0) + 1;
        const g = gateHit(e.collection, row);
        const init = model.initialStatus.find((s) => s.collection === e.collection);
        if (g) {
          row[g.outcome.field] = g.outcome.value;
        } else if (init) {
          row[init.field] = init.value;
          setStatus(e.collection, String(id), init.field, init.value, t);
        }
        // 상태와 무관한 효과(지연 후)
        model.effects.forEach((ef, effectIdx) => {
          if (ef.source !== e.collection || ef.onStatus || g) return;
          const target = row[ef.refField];
          if (target !== null && target !== undefined) q.push({ at: t + jitter(ef.lagMs, rnd), type: 'effect', effectIdx, sourcePk: String(id), targetPk: String(target) });
        });
      }
    } else if (e.type === 'transition') {
      const row = tables.get(e.collection)?.get(e.pk);
      if (row) setStatus(e.collection, e.pk, e.field, e.to, t);
    } else if (e.type === 'effect') {
      const ef = model.effects[e.effectIdx];
      const target = tables.get(ef.target)?.get(e.targetPk);
      const source = tables.get(ef.source)?.get(e.sourcePk);
      if (target && typeof target[ef.field] === 'number') {
        if (atomic.has(`${ef.target}.${ef.field}`) && (target[ef.field] as number) + ef.delta < 0) {
          // 원자적 확인-차감: 모자라면 차감하지 않고 원천 행을 관문 결과로
          const g = model.gates.find((gg) => gg.source === ef.source && gg.target === ef.target && gg.field === ef.field);
          if (g && source) source[g.outcome.field] = g.outcome.value;
        } else {
          target[ef.field] = (target[ef.field] as number) + ef.delta;
        }
      }
    } else if (e.type === 'replenish') {
      const rp = model.replenish[e.idx];
      q.push({ at: t + expSample(rp.perMinute / 60_000, rnd), type: 'replenish', idx: e.idx });
      const rows = [...(tables.get(rp.target)?.values() ?? [])].filter((r) => typeof r[rp.field] === 'number' && (r[rp.field] as number) >= rp.between[0] && (r[rp.field] as number) <= rp.between[1]);
      if (rows.length) {
        const row = rows[Math.floor(rnd() * rows.length)];
        row[rp.field] = (row[rp.field] as number) + Math.max(1, Math.round(rp.meanDelta * (0.5 + rnd())));
      }
    }
  }
  return { violations, preExisting, arrivals, frames, totalViolations };
}

function summarize(outs: RunOutput[], repRun: RunOutput, rep: number, h: Hypothesis, grammar: WorldGrammar, runs: number, seed: number, started: number): SimulationResult {
  const laws: LawOutcome[] = grammar.invariants
    .filter((i) => i.status !== 'dismissed')
    .map((inv) => {
      const hits = outs.map((o) => o.violations.get(inv.id)).filter((x): x is { first: number; maxCount: number } => !!x);
      const firsts = hits.map((x) => x.first).sort((a, b) => a - b);
      return {
        invariantId: inv.id,
        title: inv.title,
        probability: hits.length / runs,
        medianFirstMs: firsts.length ? firsts[Math.floor(firsts.length / 2)] : null,
        meanMaxCount: hits.length ? hits.reduce((a, x) => a + x.maxCount, 0) / runs : 0,
        preExisting: outs[0]?.preExisting.get(inv.id) ?? 0,
      };
    });
  const arrivals: Record<string, number> = {};
  for (const o of outs) for (const [k, v] of Object.entries(o.arrivals)) arrivals[k] = (arrivals[k] ?? 0) + v / runs;
  return { hypothesis: h, runs, seed, horizonMs: h.horizonMs, laws, arrivals, frames: repRun.frames, representativeRun: rep, durationMs: Date.now() - started };
}

function pickRepresentative(outs: RunOutput[]) {
  // 대표 실행: 위반 총량이 중앙값인 실행
  const order = outs.map((o, i) => [o.totalViolations, i] as const).sort((a, b) => a[0] - b[0]);
  return order[Math.floor(order.length / 2)][1];
}

export function simulate(base: Snapshot, model: SystemModel, h: Hypothesis, grammar: WorldGrammar, schema: SystemSchema, opts: SimulateOptions = {}): SimulationResult {
  const started = Date.now();
  const runs = opts.runs ?? 80;
  const seed = opts.seed ?? 20261104;
  const frameMs = opts.frameMs ?? 500;
  const outs: RunOutput[] = [];
  for (let r = 0; r < runs; r++) outs.push(runOnce(base, model, h, grammar, schema, seed + r * 7919, frameMs, false));
  const rep = pickRepresentative(outs);
  const repRun = runOnce(base, model, h, grammar, schema, seed + rep * 7919, frameMs, true);
  return summarize(outs, repRun, rep, h, grammar, runs, seed, started);
}

/** 서버용: 실행 사이마다 이벤트 루프에 양보해 실시간 관측을 막지 않는다. 결과는 simulate() 와 같다. */
export async function simulateAsync(base: Snapshot, model: SystemModel, h: Hypothesis, grammar: WorldGrammar, schema: SystemSchema, opts: SimulateOptions & { onProgress?: (done: number, total: number) => void } = {}): Promise<SimulationResult> {
  const started = Date.now();
  const runs = opts.runs ?? 80;
  const seed = opts.seed ?? 20261104;
  const frameMs = opts.frameMs ?? 500;
  const outs: RunOutput[] = [];
  for (let r = 0; r < runs; r++) {
    outs.push(runOnce(base, model, h, grammar, schema, seed + r * 7919, frameMs, false));
    if (r % 4 === 3) {
      opts.onProgress?.(r + 1, runs);
      await new Promise((res) => setImmediate(res));
    }
  }
  const rep = pickRepresentative(outs);
  const repRun = runOnce(base, model, h, grammar, schema, seed + rep * 7919, frameMs, true);
  return summarize(outs, repRun, rep, h, grammar, runs, seed, started);
}

/** 외부(클라이언트)에서 온 가설을 안전한 범위로 제한한다. */
export function sanitizeHypothesis(input: Hypothesis, schema: SystemSchema): Hypothesis {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
  const cols = new Set(schema.collections.map((c) => c.name));
  const changes = (input.changes ?? []).slice(0, 20).filter((c) => {
    const col = 'collection' in c ? c.collection : 'target' in c ? (c as { target: string }).target : '';
    return cols.has(col);
  }).map((c): HypothesisChange => {
    switch (c.kind) {
      case 'rate':
        return { ...c, factor: clamp(c.factor, 0, 20) };
      case 'transition':
        return { ...c, factor: clamp(c.factor, 0, 20) };
      case 'burst':
        return { ...c, count: Math.round(clamp(c.count, 1, 50)), atMs: clamp(c.atMs, 0, 120_000), spreadMs: clamp(c.spreadMs, 0, 10_000) };
      default:
        return c;
    }
  });
  return { id: String(input.id ?? 'custom').slice(0, 80), title: String(input.title ?? '사용자 가설').slice(0, 80), description: String(input.description ?? '').slice(0, 300), horizonMs: clamp(input.horizonMs, 1000, 120_000), changes };
}

/** 학습한 규칙과 현재 상태에서 의미 있는 가설을 자동으로 제안한다. */
export function suggestHypotheses(model: SystemModel, base: Snapshot, schema: SystemSchema, labelOf: (collection: string, pk: Pk) => string = (c, pk) => `${c} #${pk}`): Hypothesis[] {
  const out: Hypothesis[] = [{ id: 'baseline', title: '지금 이대로', description: '아무것도 바꾸지 않고 학습한 규칙대로 60초를 굴립니다(비교 기준).', horizonMs: 60_000, changes: [] }];
  for (const r of model.rates) {
    if (!model.effects.some((e) => e.source === r.collection) && !model.transitions.some((t) => t.collection === r.collection)) continue;
    out.push({ id: `traffic3_${r.collection}`, title: `${r.collection} 3배 폭증`, description: `${r.collection} 가 지금보다 3배 자주 생긴다면? (분당 ${r.perMinute.toFixed(0)} → ${(r.perMinute * 3).toFixed(0)})`, horizonMs: 60_000, changes: [{ kind: 'rate', collection: r.collection, factor: 3 }] });
  }
  for (const ef of model.effects) {
    if (ef.delta >= 0) continue;
    const rate = model.rates.find((r) => r.collection === ef.source);
    const weights = rate?.targets[ef.refField] ?? {};
    const col = findCollection(schema, ef.target);
    const rows = base.collections[ef.target] ?? [];
    const popular = Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([k]) => k).find((k) => rows.some((r) => col && String(pkOf(r, col)) === k)) ?? (rows[0] && col ? String(pkOf(rows[0], col)) : null);
    if (!popular || !col) continue;
    const pk: Pk = /^\d+$/.test(popular) ? Number(popular) : popular;
    const label = labelOf(ef.target, pk);
    const flash: HypothesisChange[] = [
      { kind: 'set', collection: ef.target, pk, patch: { [ef.field]: 2 * Math.abs(ef.delta) } },
      { kind: 'burst', collection: ef.source, refField: ef.refField, target: pk, count: 4, atMs: 2000, spreadMs: 30 },
    ];
    out.push({ id: `flash_${ef.target}_${popular}`, title: `반짝 세일: ${label}`, description: `${label} 의 ${ef.field} 를 ${2 * Math.abs(ef.delta)} 로 두고 2초 뒤 요청 4건이 30ms 안에 동시에 들어온다면?`, horizonMs: 20_000, changes: flash });
    if (model.gates.some((g) => g.target === ef.target && g.field === ef.field)) {
      out.push({ id: `flash_fixed_${ef.target}_${popular}`, title: `반짝 세일 + 버그 수정 가정`, description: `같은 반짝 세일에서, 확인과 차감을 하나의 원자적 조건부 갱신으로 바꿨다고 가정하면?`, horizonMs: 20_000, changes: [...flash, { kind: 'atomic', target: ef.target, field: ef.field }] });
    }
  }
  for (const tr of model.transitions) {
    if (!/(fail|error|reject|declin|dead|lost)/i.test(tr.to)) continue;
    out.push({ id: `fail3_${tr.collection}_${tr.to}`, title: `${tr.to} 3배`, description: `${tr.collection}.${tr.field} 가 ${tr.to} 가 될 확률이 3배라면? (지금 ${Math.round(tr.prob * 100)}%)`, horizonMs: 60_000, changes: [{ kind: 'transition', collection: tr.collection, field: tr.field, to: tr.to, factor: 3 }] });
  }
  for (const g of model.gates) {
    if (g.when.op !== '==' || g.when.value !== false) continue;
    out.push({ id: `stopall_${g.target}_${g.field}`, title: `${g.target} 전부 ${g.field}=false`, description: `모든 ${g.target} 의 ${g.field} 를 끄면(예: 전체 판매 중지) 어떻게 될까?`, horizonMs: 30_000, changes: [{ kind: 'setAll', collection: g.target, patch: { [g.field]: false } }] });
  }
  return out;
}
