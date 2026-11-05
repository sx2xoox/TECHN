import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  attachStats,
  buildInspect,
  keyOf,
  buildLegend,
  diagnose,
  diffSnapshots,
  DynamicInvariantLearner,
  findCauses,
  findCollection,
  invertCommands,
  kindById,
  maskRow,
  observe,
  parseEntityId,
  pkOf,
  planAffordance,
  applyCommands,
  riskAllowed,
  verifyGrammar,
  chooseAnomaly,
  learnModel,
  sanitizeHypothesis,
  simulateAsync,
  suggestHypotheses,
  type Hypothesis,
  type SimulationResult,
  type SystemModel,
  type ActionRecord,
  type Affordance,
  type AffordanceOption,
  type AssetManifest,
  type DryRunMessage,
  type HelloMessage,
  type InspectField,
  type InspectMessage,
  type Snapshot,
  type SystemSchema,
  type TimelineMarker,
  type TimelineMessage,
  type UpdateCommand,
  type VerificationReport,
  type Violation,
  type WorldEntity,
  type WorldGrammar,
  type WorldState,
  type WriteMode,
} from '@isomorph/core';
import { compile, type CompileOptions, type CompileRound } from '@isomorph/compiler';
import { ConflictError, type Adapter } from '@isomorph/adapters';
import { EventStore } from './eventstore.ts';

/**
 * 화면(모든 접속)에 나가는 오류 문구에서 비밀을 지운다: URL 의 사용자·비밀번호, 쿼리 문자열(api_key 등).
 * 자세한 원문은 서버 로그(운영자 컴퓨터)에만 남긴다.
 */
export function redact(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/(https?:\/\/[^\s?#'"]+)\?[^\s#'"]*/gi, '$1?…')
    .slice(0, 300);
}

export interface RuntimeOptions {
  adapter: Adapter;
  /** 미리 만들어 둔 문법(없으면 컴파일) */
  grammar?: WorldGrammar;
  compile?: CompileOptions;
  writeMode?: WriteMode;
  pollMs?: number;
  storePath?: string;
  numRuns?: number;
  assets?: AssetManifest | null;
  log?: (msg: string) => void;
}

interface Plan {
  id: string;
  entityId: string;
  affordanceId: string;
  title: string;
  commands: UpdateCommand[];
  commandText: string[];
  preview: WorldEntity | null;
  expires: number;
  undoOf?: string;
  risk: Affordance['risk'];
  /** 상대 편집(delta)이면 충돌 때 최신 상태로 다시 계획할 수 있다 */
  relative: boolean;
}

/** 직전 변경 되돌리기의 드라이런 id(문법의 행동 id 와 겹치지 않는다) */
export const REVERT_ACTION = '__revert';

interface PendingVerification {
  actionId: string;
  commands: UpdateCommand[];
  executedAt: number;
}

export type RuntimeStatus = 'starting' | 'running' | 'refused' | 'error' | 'stopped';

/** 법칙 위반이 새로 시작되거나(start) 풀렸을 때(end) 내는 사건. 알림이 이것을 듣는다 */
export interface ViolationEvent {
  phase: 'start' | 'end';
  ts: number;
  violation: Violation;
  /** 세계에 그려진 개체(없으면 null: 행 제한 밖 등) */
  entityId: string | null;
  /** 시작한 뒤 첫 관측에서 이미 깨져 있던 것(새로 깨진 것이 아님) */
  initial: boolean;
}

/**
 * ISOMORPH 런타임: 어댑터 ↔ 렌즈 ↔ 세계.
 * 네트워크와 무관한 순수 로직이라 단독으로 테스트할 수 있다(WebSocket 서버는 이것을 감쌀 뿐).
 */
export class IsomorphRuntime extends EventEmitter {
  status: RuntimeStatus = 'starting';
  schema!: SystemSchema;
  grammar!: WorldGrammar;
  report!: VerificationReport;
  compileRounds: CompileRound[] = [];
  compileMode: 'heuristic' | 'llm' | 'manual' = 'manual';
  fallbackReason?: string;
  world: WorldState | null = null;
  lastSnapshot: Snapshot | null = null;
  error?: string;

  readonly store: EventStore;
  private adapter: Adapter;
  private learner!: DynamicInvariantLearner;
  private timer: NodeJS.Timeout | null = null;
  private plans = new Map<string, Plan>();
  private actions: ActionRecord[] = [];
  private pending: PendingVerification[] = [];
  private markers: TimelineMarker[] = [];
  private activeViolations = new Map<string, Violation>();
  private trackedOnce = false;
  private log: (msg: string) => void;
  readonly writeMode: WriteMode;
  readonly pollMs: number;

  constructor(private opts: RuntimeOptions) {
    super();
    this.adapter = opts.adapter;
    this.writeMode = opts.writeMode ?? 'read-only';
    this.pollMs = opts.pollMs ?? 500;
    this.store = new EventStore(opts.storePath ?? ':memory:');
    this.log = opts.log ?? (() => {});
  }

  /** 연결 → 스키마 → 컴파일 → 검증. 검증에 실패하면 세계를 열지 않는다. */
  async start(): Promise<RuntimeStatus> {
    try {
      await this.adapter.connect();
      const rawSchema = await this.adapter.introspect();
      const first = await this.adapter.snapshot();
      this.schema = attachStats(rawSchema, first);
      if (this.opts.grammar) {
        this.grammar = this.opts.grammar;
        this.report = verifyGrammar(this.grammar, this.schema, { numRuns: this.opts.numRuns });
        this.compileMode = 'manual';
      } else {
        const r = await compile(this.schema, { numRuns: this.opts.numRuns, ...this.opts.compile, onRound: (x) => this.log(`컴파일 ${x.round}회차(${x.source}): ${x.ok ? '통과' : `오류 ${x.errors}건`} · 충실도 ${x.score}`) });
        this.grammar = r.grammar;
        this.report = r.report;
        this.compileRounds = r.rounds;
        this.compileMode = r.mode;
        this.fallbackReason = r.fallbackReason;
      }
      if (!this.report.ok) {
        this.status = 'refused';
        this.log('렌즈 검증 실패 — 세계를 열지 않습니다');
        this.emit('status', this.status);
        return this.status;
      }
      this.learner = new DynamicInvariantLearner(this.schema);
      await this.resolveOutside(first);
      this.ingest(first);
      this.status = 'running';
      this.emit('status', this.status);
      this.schedule();
      await this.startFeed();
      return this.status;
    } catch (e) {
      this.status = 'error';
      this.log(`시작 실패: ${e instanceof Error ? e.message : e}`);
      this.error = redact(e instanceof Error ? e.message : String(e));
      this.log(`시작 실패: ${this.error}`);
      this.emit('status', this.status);
      return this.status;
    }
  }

  private schedule() {
    if (this.status !== 'running') return;
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), this.pollMs);
  }

  private inflight: Promise<WorldState | null> | null = null;
  private unwatch: (() => Promise<void>) | null = null;
  private feedDirty = new Set<string>();
  private feedTimer: NodeJS.Timeout | null = null;
  /** 변경 알림(푸시)으로 관측 중인가 */
  feedActive = false;

  /** 어댑터가 변경 알림을 지원하고 설정돼 있으면 켠다. 실패해도 폴링은 계속된다. */
  private async startFeed() {
    if (!this.adapter.watch) return;
    try {
      this.unwatch = await this.adapter.watch((cols) => this.onFeed(cols));
      if (this.unwatch) {
        this.feedActive = true;
        this.log('푸시 관측 켜짐: 변경이 생기면 즉시 다시 관측합니다(폴링은 안전망으로 유지)');
      }
    } catch (e) {
      this.log(`푸시 관측을 켜지 못해 폴링만 사용합니다: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 짧은 시간 안에 몰린 알림은 한 번의 부분 관측으로 합친다 */
  private onFeed(cols: string[]) {
    for (const c of cols) this.feedDirty.add(c);
    if (this.feedTimer || this.status !== 'running') return;
    this.feedTimer = setTimeout(async () => {
      this.feedTimer = null;
      const only = [...this.feedDirty].filter((c) => this.schema.collections.some((x) => x.name === c));
      this.feedDirty.clear();
      if (!only.length) return;
      if (this.inflight) await this.inflight.catch(() => null);
      if (!this.inflight) this.inflight = this.doTick(only).finally(() => (this.inflight = null));
    }, 10);
  }

  /** 한 번 관측: 스냅샷 → 이벤트 저장 → 세계 갱신 → 검증 대기 중인 행동 확인 (진행 중이면 그 결과를 공유) */
  tick(): Promise<WorldState | null> {
    if (!this.inflight) this.inflight = this.doTick().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** 지금 이후에 시작된 관측을 보장한다 */
  async refresh(): Promise<WorldState | null> {
    if (this.inflight) await this.inflight.catch(() => null);
    return this.tick();
  }

  private async doTick(only?: string[]): Promise<WorldState | null> {
    try {
      const started = Date.now();
      const part = await this.adapter.snapshot(only);
      // 부분 관측이면 나머지 컬렉션은 직전 상태를 그대로 쓴다
      const snap: Snapshot = only && this.lastSnapshot ? { ts: part.ts, collections: { ...this.lastSnapshot.collections, ...part.collections } } : part;
      await this.resolveOutside(snap);
      this.ingest(snap, started);
      return this.world;
    } catch (e) {
      this.log(`관측 실패: ${e instanceof Error ? e.message : e}`);
      this.emit('toast', { level: 'error', message: `시스템 관측 실패: ${redact(e instanceof Error ? e.message : String(e))}` });
      return this.world;
    }
  }

  /**
   * 관측 창(최근 N행) 밖의 행을 가리키는 참조를 '대상 없음' 으로 오판하지 않도록,
   * 창 안에서 대상이 안 보이는 참조 값만 어댑터에 물어 실제로 있는 것을 snap.outside 에 적는다.
   * 정말로 없는 대상(진짜 고아 행)은 그대로 법칙 위반으로 남는다.
   */
  private outsideCache = new Map<string, { at: number; known: Map<string, unknown> }>();
  private async resolveOutside(snap: Snapshot) {
    const lookup = this.adapter.lookup?.bind(this.adapter);
    delete snap.outside;
    if (!lookup || !this.grammar) return;
    const now = Date.now();
    const outside: Record<string, unknown[]> = {};
    for (const inv of this.grammar.invariants) {
      if (inv.status === 'dismissed' || inv.expr.op !== 'refExists') continue;
      const { collection: target, target: field } = inv.expr;
      const key = `${target}.${field}`;
      const inWindow = new Set((snap.collections[target] ?? []).map((r) => keyOf(r[field])));
      const missing = new Map<string, unknown>();
      for (const r of snap.collections[inv.collection] ?? []) {
        const v = r[inv.expr.field];
        if (v === null || v === undefined) continue;
        const k = keyOf(v);
        if (!inWindow.has(k)) missing.set(k, v);
      }
      if (!missing.size) continue;
      let cache = this.outsideCache.get(key);
      if (!cache || now - cache.at > 30_000) {
        cache = { at: now, known: new Map() };
        this.outsideCache.set(key, cache);
      }
      const known = cache.known;
      const ask = [...missing].filter(([k]) => !known.has(k)).slice(0, 5000);
      if (ask.length) {
        try {
          for (const v of await lookup(target, field, ask.map(([, v]) => v))) known.set(keyOf(v), v);
        } catch (e) {
          this.log(`참조 확인 실패(${key}): ${e instanceof Error ? e.message : e}`);
        }
      }
      const found = [...missing].filter(([k]) => known.has(k)).map(([, v]) => v);
      if (found.length) outside[key] = [...(outside[key] ?? []), ...found];
    }
    if (Object.keys(outside).length) snap.outside = outside;
  }

  /** 과거 시점 스냅샷에도 지금 알고 있는 '창 밖 참조' 를 붙인다(시간 여행에서 유령 오판 방지) */
  private withOutside(snap: Snapshot): Snapshot {
    return snap.outside || !this.lastSnapshot?.outside ? snap : { ...snap, outside: this.lastSnapshot.outside };
  }

  private ingest(snap: Snapshot, startedAt = 0) {
    const events = diffSnapshots(this.lastSnapshot, snap, this.schema);
    this.store.record(snap, events);
    this.lastSnapshot = snap;
    this.learner.observe(snap);
    const proposals = this.learner.propose(this.grammar.invariants);
    if (proposals.length) {
      for (const p of proposals) this.grammar.invariants.push({ ...p, anomaly: chooseAnomaly(p, this.grammar, this.schema) });
      this.log(`학습된 법칙 ${proposals.length}개 제안: ${proposals.map((p) => p.title).join(', ')}`);
      this.emit('grammar', this.grammar);
    }
    this.world = observe(snap, this.grammar, this.schema);
    this.trackMarkers(this.world);
    this.verifyPending(snap, startedAt);
    this.emit('world', this.world);
  }

  private trackMarkers(world: WorldState) {
    const now = new Map<string, Violation>();
    for (const v of world.violations) {
      const key = `${v.invariantId}:${String(v.pk)}`;
      now.set(key, v);
      if (!this.activeViolations.has(key)) {
        const ids = world.entities.filter((e) => e.source.collection === v.collection && String(e.source.pk) === String(v.pk)).map((e) => e.id);
        this.markers.push({ ts: world.ts, invariantId: v.invariantId, title: v.title, entityIds: ids });
        if (this.markers.length > 300) this.markers.shift();
        if (!v.proposed || v.severity === 'critical') this.emit('toast', { level: 'warning', message: `법칙 위반: ${v.title} (${v.collection} #${v.pk})` });
        this.emit('violation', { phase: 'start', ts: world.ts, violation: v, entityId: ids[0] ?? null, initial: !this.trackedOnce } satisfies ViolationEvent);
      }
    }
    for (const [key, v] of this.activeViolations) {
      if (now.has(key)) continue;
      const ids = world.entities.filter((e) => e.source.collection === v.collection && String(e.source.pk) === String(v.pk)).map((e) => e.id);
      this.emit('violation', { phase: 'end', ts: world.ts, violation: v, entityId: ids[0] ?? null, initial: false } satisfies ViolationEvent);
    }
    this.activeViolations = now;
    this.trackedOnce = true;
  }

  /** 실제 시스템에서 PutGet 확인: 실행한 편집이 다음 관측에 그대로 보이는가 */
  private verifyPending(snap: Snapshot, startedAt: number) {
    const still: PendingVerification[] = [];
    for (const p of this.pending) {
      // 실행 이전에 시작된 관측으로는 판정하지 않는다
      if (p.executedAt >= startedAt) {
        still.push(p);
        continue;
      }
      const action = this.actions.find((a) => a.id === p.actionId);
      if (!action) continue;
      let ok = true;
      for (const cmd of p.commands) {
        const col = findCollection(this.schema, cmd.collection);
        const row = col && (snap.collections[cmd.collection] ?? []).find((r) => String(pkOf(r, col)) === String(cmd.pk));
        if (!row || Object.entries(cmd.patch).some(([k, v]) => JSON.stringify(row[k] ?? null) !== JSON.stringify(v))) ok = false;
      }
      action.status = ok ? 'verified' : 'mismatch';
      action.verifiedAt = snap.ts;
      if (!ok) action.error = '관측된 값이 실행한 편집과 다릅니다(그 사이 다른 요청이 값을 바꿨을 수 있음)';
      this.emit('actions', this.actions);
    }
    this.pending = still;
  }

  hello(): HelloMessage {
    return {
      type: 'hello',
      system: this.grammar?.system ?? this.adapter.system,
      source: this.adapter.kind,
      grammar: this.grammar,
      legend: this.grammar && this.schema ? buildLegend(this.grammar, this.schema) : [],
      verification: this.report,
      writeMode: this.writeMode,
      assets: this.opts.assets ?? null,
      pollMs: this.pollMs,
      push: this.feedActive,
    };
  }

  timeline(): TimelineMessage {
    const r = this.store.range();
    return { type: 'timeline', start: r?.start ?? Date.now(), end: r?.end ?? Date.now(), markers: this.markers };
  }

  getActions(): ActionRecord[] {
    return this.actions;
  }

  /** 과거 시점의 세계 */
  seek(ts: number): WorldState | null {
    const snap = this.store.snapshotAt(ts, this.schema);
    return snap ? observe(this.withOutside(snap), this.grammar, this.schema) : null;
  }

  private snapshotFor(ts?: number): Snapshot | null {
    if (ts === undefined) return this.lastSnapshot;
    return this.store.snapshotAt(ts, this.schema);
  }

  inspect(entityIdValue: string, atTs?: number): InspectMessage {
    const snap = this.snapshotFor(atTs);
    if (!snap || !this.grammar) return { type: 'inspect', entityId: entityIdValue, entity: null, collection: '', pk: '', row: null, fields: [], violations: [], causes: [], diagnosis: null, affordances: [], related: [] };
    return buildInspect({ snapshot: this.withOutside(snap), grammar: this.grammar, schema: this.schema, events: this.store.eventsBetween(snap.ts - 10 * 60_000, snap.ts), entityId: entityIdValue, writeMode: this.writeMode, history: atTs !== undefined });
  }

  /** 드라이런: 아무것도 바꾸지 않고, 바뀔 미래의 장면을 계산한다. */
  dryRun(entityIdValue: string, affordanceId: string): DryRunMessage {
    if (affordanceId === REVERT_ACTION) return this.dryRunRevert(entityIdValue);
    const aff = this.grammar.affordances.find((a) => a.id === affordanceId);
    const base: DryRunMessage = { type: 'dryrun', planId: null, entityId: entityIdValue, affordanceId, title: aff?.title ?? affordanceId, commands: [], commandText: [], current: null, preview: null, risk: aff?.risk ?? 'high', allowed: false };
    const snap = this.lastSnapshot;
    if (!aff || !snap) return { ...base, error: '행동을 찾을 수 없습니다' };
    const current = observe(snap, this.grammar, this.schema).entities.find((e) => e.id === entityIdValue) ?? null;
    const plan = planAffordance(snap, this.grammar, this.schema, entityIdValue, affordanceId);
    if (!plan.ok) return { ...base, current, error: plan.error };
    let commandText: string[];
    try {
      commandText = plan.commands.map((c) => this.adapter.describe(c));
    } catch (e) {
      return { ...base, current, error: redact(e instanceof Error ? e.message : String(e)) };
    }
    const future = applyCommands(snap, plan.commands, this.schema);
    const preview = observe(future, this.grammar, this.schema).entities.find((e) => e.id === entityIdValue) ?? null;
    const allowed = riskAllowed(this.writeMode, aff.risk) && plan.commands.length > 0;
    const reason = !riskAllowed(this.writeMode, aff.risk) ? `쓰기 권한(${this.writeMode})으로는 위험도 ${aff.risk} 행동을 실행할 수 없습니다` : plan.commands.length === 0 ? '세계가 이미 그 상태입니다(바꿀 것이 없음)' : undefined;
    const id = randomUUID();
    if (allowed) this.plans.set(id, { id, entityId: entityIdValue, affordanceId, title: aff.title, commands: plan.commands, commandText, preview, expires: Date.now() + 60_000, risk: aff.risk, relative: aff.edits.every((ed) => ed.delta !== undefined) });
    return { ...base, planId: allowed ? id : null, commands: plan.commands, commandText, current, preview, allowed, ...(reason ? { reason } : {}) };
  }

  /**
   * 직전 변경 되돌리기: 위반 직전에 이 행이 받은 변경을 원래 값으로(살펴보기의 revert 안 그대로).
   * 위험도는 high: 시스템 설정을 과거 값으로 되돌리는 일이라 가장 넓은 쓰기 권한에서만 연다.
   */
  private dryRunRevert(entityIdValue: string): DryRunMessage {
    const base: DryRunMessage = { type: 'dryrun', planId: null, entityId: entityIdValue, affordanceId: REVERT_ACTION, title: '직전 변경 되돌리기', commands: [], commandText: [], current: null, preview: null, risk: 'high', allowed: false };
    const snap = this.lastSnapshot;
    const parsed = parseEntityId(entityIdValue);
    const kind = parsed && this.grammar ? kindById(this.grammar, parsed.kind) : undefined;
    const col = kind && findCollection(this.schema, kind.collection);
    if (!snap || !parsed || !kind || !col) return { ...base, error: '개체를 찾을 수 없습니다' };
    const world = observe(snap, this.grammar, this.schema);
    const current = world.entities.find((e) => e.id === entityIdValue) ?? null;
    const row = (snap.collections[kind.collection] ?? []).find((r) => String(pkOf(r, col)) === parsed.pk);
    const r = row ? this.inspect(entityIdValue).revert : undefined;
    if (!row || !r) return { ...base, current, error: '되돌릴 직전 변경이 없습니다(위반 전에 바뀐, 시스템이 쓰기를 받는 값이 없음)' };
    const cmd: UpdateCommand = {
      op: 'update',
      collection: kind.collection,
      pk: pkOf(row, col),
      patch: Object.fromEntries(r.changes.map((c) => [c.field, c.to])),
      before: Object.fromEntries(r.changes.map((c) => [c.field, c.now])),
    };
    let commandText: string[];
    try {
      commandText = [this.adapter.describe(cmd)];
    } catch (e) {
      return { ...base, current, error: redact(e instanceof Error ? e.message : String(e)) };
    }
    const preview = observe(applyCommands(snap, [cmd], this.schema), this.grammar, this.schema).entities.find((e) => e.id === entityIdValue) ?? null;
    const title = `직전 변경 되돌리기: ${r.changes.map((c) => c.field).join(', ')}`;
    const allowed = riskAllowed(this.writeMode, 'high');
    const id = randomUUID();
    if (allowed) this.plans.set(id, { id, entityId: entityIdValue, affordanceId: REVERT_ACTION, title, commands: [cmd], commandText, preview, expires: Date.now() + 60_000, risk: 'high', relative: false });
    return { ...base, title, planId: allowed ? id : null, commands: [cmd], commandText, current, preview, allowed, ...(allowed ? {} : { reason: `쓰기 권한(${this.writeMode})으로는 위험도 high 행동을 실행할 수 없습니다(--write high)` }) };
  }

  cancel(planId: string) {
    this.plans.delete(planId);
  }

  private async executeAll(commands: UpdateCommand[]) {
    for (const c of commands) await this.adapter.execute(c);
  }

  /** 승인 → 실행. 충돌 시 상대 편집(delta)은 최신 상태 기준으로 1회 재계획. */
  async approve(planId: string): Promise<ActionRecord> {
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (!plan) throw new Error('미리보기가 만료됐거나 존재하지 않습니다. 다시 미리보기 하세요.');
    if (plan.expires < Date.now()) throw new Error('미리보기가 만료됐습니다(60초). 다시 미리보기 하세요.');
    if (!riskAllowed(this.writeMode, plan.risk)) throw new Error('쓰기 권한이 없습니다');
    const record: ActionRecord = { id: randomUUID(), ts: Date.now(), title: plan.title, entityId: plan.entityId, affordanceId: plan.affordanceId, commands: plan.commands, commandText: plan.commandText, status: 'applied', ...(plan.undoOf ? { undoOf: plan.undoOf } : {}) };
    try {
      await this.executeAll(plan.commands);
    } catch (e) {
      if (e instanceof ConflictError && plan.relative) {
        await this.refresh();
        const again = planAffordance(this.lastSnapshot!, this.grammar, this.schema, plan.entityId, plan.affordanceId);
        if (!again.ok) throw new Error(again.error);
        await this.executeAll(again.commands);
        record.commands = again.commands;
        record.commandText = again.commands.map((c) => this.adapter.describe(c));
        record.error = '동시 변경을 감지해 최신 상태 기준으로 다시 계획한 뒤 실행했습니다';
      } else {
        record.status = 'failed';
        record.error = redact(e instanceof Error ? e.message : String(e));
        this.actions.unshift(record);
        this.emit('actions', this.actions);
        return record;
      }
    }
    this.actions.unshift(record);
    if (this.actions.length > 50) this.actions.pop();
    this.pending.push({ actionId: record.id, commands: record.commands, executedAt: Date.now() });
    this.log(`행동 실행: ${record.title} → ${record.commandText.join(' ; ')}`);
    this.emit('actions', this.actions);
    void this.tick();
    return record;
  }

  /** 되돌리기: 절대 편집은 역명령, 상대 편집은 반대 방향 delta */
  async undo(actionId: string): Promise<ActionRecord> {
    const action = this.actions.find((a) => a.id === actionId);
    if (!action) throw new Error('행동을 찾을 수 없습니다');
    if (action.status === 'undone' || action.status === 'failed') throw new Error('되돌릴 수 없는 상태입니다');
    await this.refresh();
    const snap = this.lastSnapshot!;
    const aff = this.grammar.affordances.find((a) => a.id === action.affordanceId);
    const deltaEdits = !!aff && aff.edits.every((ed) => ed.delta !== undefined);
    let commands: UpdateCommand[];
    if (deltaEdits) {
      commands = action.commands.map((c) => {
        const col = findCollection(this.schema, c.collection)!;
        const row = (snap.collections[c.collection] ?? []).find((r) => String(pkOf(r, col)) === String(c.pk))!;
        const patch: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        for (const k of Object.keys(c.patch)) {
          const diff = Number(c.patch[k]) - Number(c.before[k]);
          patch[k] = Number(row[k]) - diff;
          before[k] = row[k];
        }
        return { op: 'update', collection: c.collection, pk: c.pk, patch, before };
      });
    } else {
      commands = invertCommands(action.commands);
    }
    const record: ActionRecord = { id: randomUUID(), ts: Date.now(), title: `되돌리기: ${action.title}`, entityId: action.entityId, commands, commandText: commands.map((c) => this.adapter.describe(c)), status: 'applied', undoOf: action.id };
    try {
      await this.executeAll(commands);
      action.status = 'undone';
      this.pending.push({ actionId: record.id, commands, executedAt: Date.now() });
    } catch (e) {
      record.status = 'failed';
      record.error = e instanceof ConflictError ? '그 사이 값이 바뀌어 안전하게 되돌릴 수 없습니다' : redact(e instanceof Error ? e.message : String(e));
    }
    this.actions.unshift(record);
    this.emit('actions', this.actions);
    void this.tick();
    return record;
  }

  private modelCache: { at: number; model: SystemModel } | null = null;

  /** 가설 실험실: 이벤트 기록에서 시스템 동역학을 배우고 의미 있는 가설을 제안한다 */
  lab(): { model: SystemModel; hypotheses: Hypothesis[] } {
    const range = this.store.range();
    if (!range || !this.lastSnapshot) throw new Error('아직 관측 기록이 없습니다');
    if (!this.modelCache || range.end - this.modelCache.at > 5000) {
      const initial = this.store.snapshotAt(range.start, this.schema)!;
      this.modelCache = { at: range.end, model: learnModel(initial, this.store.eventsBetween(range.start, range.end), this.schema) };
    }
    const entities = this.world?.entities ?? [];
    const labelOf = (collection: string, pk: string | number) => entities.find((e) => e.source.collection === collection && String(e.source.pk) === String(pk))?.label ?? `${collection} #${pk}`;
    return { model: this.modelCache.model, hypotheses: suggestHypotheses(this.modelCache.model, this.lastSnapshot, this.schema, labelOf) };
  }

  /** 현재 상태에서 가설을 시뮬레이션한다(예측이며 실제 시스템은 바꾸지 않는다) */
  async simulate(input: Hypothesis, onProgress?: (done: number, total: number) => void): Promise<SimulationResult> {
    const { model } = this.lab();
    const h = sanitizeHypothesis(input, this.schema);
    const frameMs = Math.max(250, Math.round(h.horizonMs / 80));
    return simulateAsync(this.lastSnapshot!, model, h, this.grammar, this.schema, { runs: 80, frameMs, onProgress });
  }

  setInvariantStatus(id: string, status: 'confirmed' | 'dismissed') {
    const inv = this.grammar.invariants.find((i) => i.id === id);
    if (!inv) throw new Error('법칙을 찾을 수 없습니다');
    inv.status = status;
    if (status === 'confirmed') inv.source = inv.source === 'dynamic' || inv.source === 'heuristic' || inv.source === 'llm' ? inv.source : 'user';
    if (this.lastSnapshot) {
      this.world = observe(this.lastSnapshot, this.grammar, this.schema);
      this.emit('world', this.world);
    }
    this.emit('grammar', this.grammar);
  }

  async stop() {
    this.status = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.feedTimer) clearTimeout(this.feedTimer);
    await this.unwatch?.().catch(() => {});
    this.unwatch = null;
    await this.adapter.close();
    this.store.close();
  }
}
