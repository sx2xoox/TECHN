import * as fc from 'fast-check';
import { snapshotArbitrary } from './arbitrary.ts';
import { fieldsOfExpr } from './expr.ts';
import {
  CHANNELS,
  COLOR_NAMES,
  isBoolean,
  isCategorical,
  isEditableBinding,
  isQuant,
  PALETTE,
  parseGrammar,
  type Binding,
  type CategoricalBinding,
  type ColorName,
  type EntityKind,
  type WorldGrammar,
} from './grammar.ts';
import { closestPair, MIN_DISTINGUISHABLE_DE, VISION_KO, type Vision } from './color.ts';
import { evaluateInvariants } from './invariants.ts';
import { applyCommands, planAffordance, project, put } from './lens.ts';
import { findCollection, findField, type Snapshot, type SystemSchema } from './schema.ts';
import type { VisualValue, WorldEntity } from './world.ts';

/**
 * Verified Lens — 대응이 틀리면 세계가 열리지 않는다.
 * 1) 정적 검사: 타입 호환, 단사성, 개인정보, 커버리지
 * 2) 속성 기반 검사(fast-check): 결정성, GetPut, PutGet, 국소성, 행동(affordance) 법칙
 */

export type IssueLevel = 'error' | 'warning' | 'info';

export interface VerificationIssue {
  level: IssueLevel;
  code: string;
  message: string;
  kind?: string;
  channel?: string;
  counterexample?: string;
}

export interface CheckResult {
  name: string;
  title: string;
  passed: boolean;
  runs: number;
}

export interface KindFidelity {
  kind: string;
  title: string;
  fields: number;
  bound: number;
  hidden: number;
  unaccounted: string[];
}

export interface FidelityReport {
  /** 0~100 */
  score: number;
  lawPassRate: number;
  injectivity: number;
  accounted: number;
  visualCoverage: number;
  perKind: KindFidelity[];
}

/** 색깔 채널의 접근성: 색각 이상(적·녹·청)에서도 색이 갈리거나, 값마다 다른 모양이 있으면 통과 */
export function tintAccessibility(b: CategoricalBinding): { ok: boolean; byColor: boolean; byGlyph: boolean; vision?: Vision; a?: ColorName; b?: ColorName; de?: number } {
  const colors = [...new Set([...Object.values(b.map), b.fallback])];
  let worst: { vision: Vision; a: ColorName; b: ColorName; de: number } | null = null;
  for (const v of ['protan', 'deutan', 'tritan'] as Vision[]) {
    const p = closestPair(colors, v);
    if (p && (!worst || p.de < worst.de)) worst = { vision: v, ...p };
  }
  const byColor = !worst || worst.de >= MIN_DISTINGUISHABLE_DE;
  const gs = Object.keys(b.map).map((v) => b.glyphs?.[v]);
  const byGlyph = gs.length > 0 && gs.every(Boolean) && new Set(gs).size === gs.length;
  return { ok: byColor || byGlyph, byColor, byGlyph, ...(worst ?? {}) };
}

export interface VerificationReport {
  ok: boolean;
  issues: VerificationIssue[];
  checks: CheckResult[];
  fidelity: FidelityReport;
  totalRuns: number;
  durationMs: number;
  seed: number;
}

export interface VerifyOptions {
  numRuns?: number;
  seed?: number;
  maxRows?: number;
}

/* ───────────────────────────── 정적 검사 ───────────────────────────── */

function dupes(ids: string[]): string[] {
  const seen = new Set<string>();
  const d = new Set<string>();
  for (const id of ids) (seen.has(id) ? d : seen).add(id);
  return [...d];
}

function injective(b: Binding): boolean {
  if (isCategorical(b)) {
    const colors = Object.values(b.map);
    return new Set(colors).size === colors.length && !colors.includes(b.fallback);
  }
  if (isBoolean(b) && b.when) {
    if (b.writeTrue !== undefined && !b.when.some((w) => w === b.writeTrue)) return false;
    if (b.writeFalse !== undefined && b.when.some((w) => w === b.writeFalse)) return false;
  }
  return true;
}

export function staticChecks(g: WorldGrammar, schema: SystemSchema): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const err = (code: string, message: string, extra: Partial<VerificationIssue> = {}) => issues.push({ level: 'error', code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<VerificationIssue> = {}) => issues.push({ level: 'warning', code, message, ...extra });

  for (const [what, ids] of [
    ['종류', g.kinds.map((k) => k.id)],
    ['지역', g.regions.map((r) => r.id)],
    ['불변식', g.invariants.map((i) => i.id)],
    ['행동', g.affordances.map((a) => a.id)],
  ] as const) {
    for (const d of dupes([...ids])) err('DUPLICATE_ID', `${what} id 중복: ${d}`);
  }
  for (const k of g.kinds) {
    if (k.id.includes(':')) err('BAD_ID', `종류 id 에 ':' 를 쓸 수 없습니다: ${k.id}`, { kind: k.id });
  }

  for (const k of g.kinds) {
    const at = { kind: k.id };
    if (!g.regions.some((r) => r.id === k.region)) err('UNKNOWN_REGION', `${k.title}: 지역 ${k.region} 이 없습니다`, at);
    const col = findCollection(schema, k.collection);
    if (!col) {
      err('UNKNOWN_COLLECTION', `${k.title}: 컬렉션 ${k.collection} 이 없습니다`, at);
      continue;
    }
    const field = (name: string) => col.fields.find((f) => f.name === name);
    const seenChannels = new Set<string>();
    for (const b of k.channels) {
      const ex = { kind: k.id, channel: b.channel };
      if (seenChannels.has(b.channel)) err('DUPLICATE_CHANNEL', `${k.title}: ${b.channel} 채널이 두 번 쓰였습니다`, ex);
      seenChannels.add(b.channel);
      const f = field(b.field);
      if (!f) {
        err('UNKNOWN_FIELD', `${k.title}: 필드 ${b.field} 가 없습니다`, ex);
        continue;
      }
      if (f.sensitive) err('PRIVACY_LEAK', `${k.title}: 민감 필드 ${b.field} 를 세계에 그릴 수 없습니다`, ex);
      if (f.readOnly && isEditableBinding(b)) err('WRITE_UNSUPPORTED', `${k.title}: 시스템이 ${b.field} 쓰기를 받지 않는데 ${b.channel} 가 편집 가능하게 열려 있습니다`, ex);
      if (isQuant(b)) {
        if (f.type !== 'integer' && f.type !== 'number') err('TYPE_MISMATCH', `${k.title}: ${CHANNELS[b.channel].ko}(${b.channel})는 수치 필드가 필요한데 ${b.field} 는 ${f.type} 입니다`, ex);
        if (!(b.scale.domain[0] < b.scale.domain[1])) err('DEGENERATE_SCALE', `${k.title}: ${b.field} 의 domain 은 [작은 값, 큰 값] 이어야 합니다`, ex);
        if (b.scale.range[0] === b.scale.range[1]) err('DEGENERATE_SCALE', `${k.title}: ${b.field} 의 range 가 한 점으로 붕괴합니다(값 차이가 안 보임)`, ex);
      } else if (isCategorical(b)) {
        if (f.type === 'number' || f.type === 'json' || f.type === 'timestamp') warn('TYPE_MISMATCH', `${k.title}: 색깔(tint)은 범주형 필드에 적합한데 ${b.field} 는 ${f.type} 입니다`, ex);
        const colors = Object.values(b.map);
        for (const c of colors) if (!COLOR_NAMES.includes(c)) err('UNKNOWN_COLOR', `${k.title}: 팔레트에 없는 색 ${c}`, ex);
        if (new Set(colors).size !== colors.length) err('NON_INJECTIVE', `${k.title}: ${b.field} 의 서로 다른 값이 같은 색으로 그려집니다(구분 불가)`, ex);
        if (colors.includes(b.fallback)) err('FALLBACK_COLLISION', `${k.title}: 미지의 값(fallback ${b.fallback})이 알려진 값과 같은 색입니다`, ex);
        for (const v of f.enumValues ?? []) if (!(v in b.map)) warn('UNMAPPED_VALUE', `${k.title}: ${b.field}=${v} 는 대응 색이 없어 ${b.fallback} 로 보입니다`, ex);
        if (b.glyphs) {
          const gs = Object.keys(b.map).map((v) => b.glyphs![v]);
          if (gs.some((g) => !g)) warn('GLYPH_MISSING', `${k.title}: ${b.field} 의 일부 값에 모양(글리프)이 없습니다`, ex);
          else if (new Set(gs).size !== gs.length) err('NON_INJECTIVE', `${k.title}: ${b.field} 의 서로 다른 값이 같은 모양으로 그려집니다`, ex);
        }
        // 접근성 법칙: 색각 이상에서도 값이 갈리는가(색으로든 모양으로든)
        const a11y = tintAccessibility(b);
        if (!a11y.ok) warn('CVD_CONFUSABLE', `${k.title}: ${VISION_KO[a11y.vision!]}에서 ${b.field} 의 ${PALETTE[a11y.a!].ko}·${PALETTE[a11y.b!].ko} 이 거의 같아 보입니다(ΔE ${a11y.de!.toFixed(1)}). 값마다 모양(글리프)을 달아 주세요`, ex);
      } else if (isBoolean(b)) {
        if (!b.when && f.type !== 'boolean') err('TYPE_MISMATCH', `${k.title}: ${b.channel} 는 boolean 필드 또는 when 목록이 필요합니다(${b.field}: ${f.type})`, ex);
        if (b.when && isEditableBinding(b)) {
          if (b.writeTrue === undefined || b.writeFalse === undefined) err('WRITE_UNDEFINED', `${k.title}: 편집 가능한 ${b.channel} 에 writeTrue/writeFalse 가 필요합니다`, ex);
          if (!injective(b)) err('WRITE_INCONSISTENT', `${k.title}: writeTrue 는 when 안에, writeFalse 는 when 밖에 있어야 합니다`, ex);
        }
      }
    }
    if (k.labelField) {
      const f = field(k.labelField);
      if (!f) err('UNKNOWN_FIELD', `${k.title}: 이름 필드 ${k.labelField} 가 없습니다`, at);
      else if (f.sensitive) err('PRIVACY_LEAK', `${k.title}: 민감 필드 ${k.labelField} 를 이름표로 쓸 수 없습니다`, at);
    }
    for (const role of ['from', 'to'] as const) {
      const r = k.route?.[role];
      if (!r) continue;
      const f = field(r);
      if (!f) err('UNKNOWN_FIELD', `${k.title}: 경로 필드 ${r} 가 없습니다`, at);
      else if (!f.ref) err('ROUTE_NOT_REF', `${k.title}: 경로 필드 ${r} 는 참조 필드여야 합니다`, at);
      else if (!g.kinds.some((kk) => kk.collection === f.ref!.collection && kk.archetype !== 'npc')) {
        warn('ROUTE_TARGET_NOT_RENDERED', `${k.title}: ${r} 가 가리키는 ${f.ref.collection} 은 세계에 건물로 없습니다`, at);
      }
    }
    if (k.recency) {
      const f = field(k.recency.field);
      if (!f) err('UNKNOWN_FIELD', `${k.title}: 최근성 필드 ${k.recency.field} 가 없습니다`, at);
      else if (f.type !== 'timestamp') err('TYPE_MISMATCH', `${k.title}: 최근성 필드 ${k.recency.field} 는 timestamp 여야 합니다`, at);
    }
    for (const fname of k.filter ? fieldsOfExpr(k.filter) : []) if (!field(fname)) err('UNKNOWN_FIELD', `${k.title}: 필터 필드 ${fname} 가 없습니다`, at);
    for (const h of k.hidden) if (!field(h)) warn('UNKNOWN_HIDDEN', `${k.title}: 숨김 목록의 ${h} 는 존재하지 않습니다`, at);
    for (const f of col.fields) {
      if (f.name === col.primaryKey) continue;
      if (!accountedFields(k).has(f.name)) warn('UNACCOUNTED_FIELD', `${k.title}: ${f.name} 는 그려지지도, 숨김 선언되지도 않았습니다`, at);
    }
  }

  for (const inv of g.invariants) {
    const col = findCollection(schema, inv.collection);
    if (!col) {
      err('UNKNOWN_COLLECTION', `불변식 ${inv.id}: 컬렉션 ${inv.collection} 이 없습니다`);
      continue;
    }
    for (const f of fieldsOfExpr(inv.expr)) if (!findField(schema, inv.collection, f)) err('UNKNOWN_FIELD', `불변식 ${inv.id}: 필드 ${f} 가 없습니다`);
  }

  for (const a of g.affordances) {
    const k = g.kinds.find((kk) => kk.id === a.entityKind);
    if (!k) {
      err('UNKNOWN_KIND', `행동 ${a.title}: 종류 ${a.entityKind} 가 없습니다`);
      continue;
    }
    for (const e of a.edits) {
      const b = k.channels.find((bb) => bb.channel === e.channel);
      if (!b) err('AFFORDANCE_UNBOUND', `행동 ${a.title}: ${k.title}에는 ${e.channel} 채널이 없습니다`, { kind: k.id });
      else if (!isEditableBinding(b)) err('AFFORDANCE_READONLY', `행동 ${a.title}: ${e.channel}(${b.field}) 는 읽기 전용입니다`, { kind: k.id });
      if (e.value === undefined && e.delta === undefined) err('AFFORDANCE_EMPTY', `행동 ${a.title}: value 또는 delta 가 필요합니다`);
      if (e.channel === 'lit' && e.value !== undefined && typeof e.value !== 'boolean') err('AFFORDANCE_TYPE', `행동 ${a.title}: 불빛 값은 true/false 여야 합니다`);
      if (e.channel === 'tint' && b && isCategorical(b) && e.value !== undefined && !Object.values(b.map).includes(e.value as never)) {
        err('AFFORDANCE_TYPE', `행동 ${a.title}: 색 ${String(e.value)} 은 ${b.field} 의 어떤 값과도 대응하지 않습니다`);
      }
      if (e.channel === 'stack' && e.delta !== undefined && !Number.isInteger(e.delta)) err('AFFORDANCE_TYPE', `행동 ${a.title}: 상자 수 변화는 정수여야 합니다`);
    }
  }
  return issues;
}

function accountedFields(k: EntityKind): Set<string> {
  const s = new Set<string>([...k.channels.map((b) => b.field), ...k.hidden]);
  if (k.labelField) s.add(k.labelField);
  if (k.route?.from) s.add(k.route.from);
  if (k.route?.to) s.add(k.route.to);
  if (k.recency) s.add(k.recency.field);
  if (k.filter) for (const f of fieldsOfExpr(k.filter)) s.add(f);
  return s;
}

/* ───────────────────────────── 속성 기반 검사 ───────────────────────────── */

class LawViolation extends Error {}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function visualsById(entities: WorldEntity[]): Map<string, string> {
  return new Map(entities.map((e) => [e.id, JSON.stringify([e.visual, e.links])]));
}

function targetArb(b: Binding): fc.Arbitrary<VisualValue> | null {
  if (isQuant(b) && b.channel === 'stack') {
    const [r0, r1] = b.scale.range;
    return fc.integer({ min: Math.ceil(Math.min(r0, r1)), max: Math.floor(Math.max(r0, r1)) });
  }
  if (isCategorical(b)) {
    const colors = [...new Set(Object.values(b.map))];
    return colors.length ? fc.constantFrom<VisualValue>(...colors) : null;
  }
  if (isBoolean(b)) return fc.boolean();
  return null;
}

function summarize(s: Snapshot, collection?: string): string {
  const cols = collection ? { [collection]: s.collections[collection] } : s.collections;
  const text = JSON.stringify(cols);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function verifyGrammar(input: unknown, schema: SystemSchema, opts: VerifyOptions = {}): VerificationReport {
  const started = Date.now();
  const seed = opts.seed ?? 42;
  const numRuns = opts.numRuns ?? 150;
  const parsed = parseGrammar(input);
  const emptyFidelity: FidelityReport = { score: 0, lawPassRate: 0, injectivity: 0, accounted: 0, visualCoverage: 0, perKind: [] };
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.errors.map((m) => ({ level: 'error' as const, code: 'SCHEMA', message: `문법 구조 오류 — ${m}` })),
      checks: [],
      fidelity: emptyFidelity,
      totalRuns: 0,
      durationMs: Date.now() - started,
      seed,
    };
  }
  const g = parsed.value;
  const issues = staticChecks(g, schema);
  const checks: CheckResult[] = [];
  const structural = issues.some((i) => i.level === 'error' && ['UNKNOWN_COLLECTION', 'UNKNOWN_FIELD', 'DUPLICATE_ID', 'UNKNOWN_REGION', 'TYPE_MISMATCH'].includes(i.code));
  let totalRuns = 0;

  const snapArb = snapshotArbitrary(schema, { maxRows: opts.maxRows ?? 5 });
  const run = (name: string, title: string, prop: fc.IProperty<any>, kind?: string, channel?: string, collection?: string) => {
    const r = fc.check(prop, { numRuns, seed });
    totalRuns += r.numRuns;
    checks.push({ name, title, passed: !r.failed, runs: r.numRuns });
    if (r.failed) {
      const e = r.errorInstance;
      const message = e instanceof Error ? e.message : String(e);
      const snap = r.counterexample?.[0] as Snapshot | undefined;
      issues.push({
        level: 'error',
        code: name.split(':')[0],
        message: `${title} 실패 — ${message}`,
        kind,
        channel,
        counterexample: snap ? summarize(snap, collection) : undefined,
      });
    }
  };

  if (!structural) {
    run('DETERMINISM', '결정성: 같은 시스템 상태는 항상 같은 세계', fc.property(snapArb, (s) => {
      if (!same(project(s, g, schema), project(s, g, schema))) throw new LawViolation('같은 입력에서 서로 다른 세계가 나왔습니다');
      evaluateInvariants(s, g, schema); // 어떤 상태에서도 법칙 평가가 실패하지 않아야 함
      return true;
    }));

    run('GETPUT', 'GetPut: 세계를 그대로 두면 시스템도 바뀌지 않음', fc.property(snapArb, (s) => {
      for (const e of project(s, g, schema)) {
        const k = g.kinds.find((kk) => kk.id === e.kind)!;
        for (const b of k.channels.filter(isEditableBinding)) {
          const r = put(s, g, schema, { entityId: e.id, edits: [{ channel: b.channel as 'stack' | 'tint' | 'lit', value: e.visual[b.channel] ?? null }] });
          if (!r.ok) throw new LawViolation(`${e.id}.${b.channel}: 현재 값으로의 put 이 실패 — ${r.error}`);
          if (r.commands.length) throw new LawViolation(`${e.id}.${b.channel}: 아무것도 안 바꿨는데 명령 ${JSON.stringify(r.commands[0].patch)} 이 생성됨`);
        }
      }
      return true;
    }));

    for (const k of g.kinds) {
      for (const b of k.channels.filter(isEditableBinding)) {
        const tArb = targetArb(b);
        if (!tArb) continue;
        const col = k.collection;
        run(`PUTGET:${k.id}.${b.channel}`, `PutGet: ${k.title}의 ${CHANNELS[b.channel].ko}(${b.field}) 편집이 그대로 보임`,
          fc.property(snapArb, fc.nat(), tArb, (s, pick, target) => {
            const ents = project(s, g, schema).filter((e) => e.kind === k.id);
            if (!ents.length) return true;
            const e = ents[pick % ents.length];
            const r = put(s, g, schema, { entityId: e.id, edits: [{ channel: b.channel as 'stack' | 'tint' | 'lit', value: target }] });
            if (!r.ok) throw new LawViolation(`${e.id}: 목표 ${JSON.stringify(target)} 로 put 실패 — ${r.error}`);
            const s2 = applyCommands(s, r.commands, schema);
            const after = project(s2, g, schema);
            const e2 = after.find((x) => x.id === e.id);
            if (!e2) throw new LawViolation(`${e.id}: 편집 후 엔티티가 세계에서 사라짐(필터/최근성 조건이 편집 필드에 의존)`);
            if (!same(e2.visual[b.channel], target)) {
              const patch = r.commands[0]?.patch;
              throw new LawViolation(`${e.id}: 목표 ${JSON.stringify(target)} 였지만 실제 ${JSON.stringify(e2.visual[b.channel])} (${b.field} ← ${JSON.stringify(patch?.[b.field])}, 양자화로 되돌릴 수 없음)`);
            }
            const before = visualsById(project(s, g, schema).filter((x) => x.id !== e.id));
            for (const x of after) {
              if (x.id === e.id) continue;
              if (before.get(x.id) !== JSON.stringify([x.visual, x.links])) throw new LawViolation(`국소성 위반: ${e.id} 편집이 ${x.id} 를 바꿈`);
            }
            return true;
          }), k.id, b.channel, col);
      }
    }

    for (const a of g.affordances) {
      const k = g.kinds.find((kk) => kk.id === a.entityKind);
      if (!k) continue;
      run(`AFFORDANCE:${a.id}`, `행동 법칙: '${a.title}' 결과가 세계에 정확히 반영됨`, fc.property(snapArb, fc.nat(), (s, pick) => {
        const ents = project(s, g, schema).filter((e) => e.kind === k.id);
        if (!ents.length) return true;
        const e = ents[pick % ents.length];
        const hasNullDelta = a.edits.some((ed) => ed.delta !== undefined && typeof e.visual[ed.channel] !== 'number');
        const r = planAffordance(s, g, schema, e.id, a.id);
        if (!r.ok) {
          if (hasNullDelta) return true; // 값이 비어 있으면 상대 편집은 거절이 맞다
          throw new LawViolation(`${e.id}: 실행 계획 실패 — ${r.error}`);
        }
        const s2 = applyCommands(s, r.commands, schema);
        const e2 = project(s2, g, schema).find((x) => x.id === e.id);
        if (!e2) throw new LawViolation(`${e.id}: 행동 후 엔티티가 사라짐`);
        for (const ed of a.edits) {
          const expected = ed.value !== undefined ? ed.value : (e.visual[ed.channel] as number) + (ed.delta ?? 0);
          if (!same(e2.visual[ed.channel], expected)) throw new LawViolation(`${e.id}: ${ed.channel} 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(e2.visual[ed.channel])}`);
        }
        if (a.edits.every((ed) => ed.value !== undefined)) {
          const again = planAffordance(s2, g, schema, e.id, a.id);
          if (!again.ok || again.commands.length) throw new LawViolation(`${e.id}: 같은 행동을 두 번 하면 아무 일도 없어야 함(멱등성)`);
        }
        return true;
      }), k.id, undefined, k.collection);
    }
  }

  // 충실도(Fidelity) 점수
  const perKind: KindFidelity[] = [];
  let fields = 0;
  let bound = 0;
  let unaccountedTotal = 0;
  let injTotal = 0;
  let injOk = 0;
  for (const k of g.kinds) {
    const col = findCollection(schema, k.collection);
    if (!col) continue;
    const names = col.fields.filter((f) => f.name !== col.primaryKey).map((f) => f.name);
    const boundSet = new Set<string>([...k.channels.map((b) => b.field)]);
    if (k.labelField) boundSet.add(k.labelField);
    if (k.route?.from) boundSet.add(k.route.from);
    if (k.route?.to) boundSet.add(k.route.to);
    const acc = accountedFields(k);
    const unaccounted = names.filter((n) => !acc.has(n));
    const hidden = names.filter((n) => k.hidden.includes(n)).length;
    perKind.push({ kind: k.id, title: k.title, fields: names.length, bound: names.filter((n) => boundSet.has(n)).length, hidden, unaccounted });
    fields += names.length;
    bound += names.filter((n) => boundSet.has(n)).length;
    unaccountedTotal += unaccounted.length;
    for (const b of k.channels) {
      if (isCategorical(b) || isBoolean(b)) {
        injTotal++;
        if (injective(b)) injOk++;
      }
    }
  }
  const lawPassRate = checks.length ? checks.filter((c) => c.passed).length / checks.length : 0;
  const injectivity = injTotal ? injOk / injTotal : 1;
  const accounted = fields ? (fields - unaccountedTotal) / fields : 1;
  const visualCoverage = fields ? bound / fields : 1;
  const score = Math.round(100 * (0.5 * lawPassRate + 0.25 * injectivity + 0.25 * accounted));

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    checks,
    fidelity: { score, lawPassRate, injectivity, accounted, visualCoverage, perKind },
    totalRuns,
    durationMs: Date.now() - started,
    seed,
  };
}

export function formatReport(r: VerificationReport): string {
  const lines = [
    `렌즈 검증 ${r.ok ? '통과 ✅' : '실패 ❌'} — 충실도 ${r.fidelity.score}/100, 검사 ${r.checks.length}종 · ${r.totalRuns}회 (${r.durationMs}ms, seed ${r.seed})`,
  ];
  for (const c of r.checks) lines.push(`  ${c.passed ? '✓' : '✗'} ${c.title} (${c.runs}회)`);
  for (const i of r.issues) {
    lines.push(`  [${i.level}] ${i.code}: ${i.message}`);
    if (i.counterexample) lines.push(`      반례: ${i.counterexample}`);
  }
  return lines.join('\n');
}
