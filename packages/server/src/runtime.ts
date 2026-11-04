import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  attachStats,
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
  type ActionRecord,
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
  type WorldEntity,
  type WorldGrammar,
  type WorldState,
  type WriteMode,
} from '@isomorph/core';
import { compile, type CompileOptions, type CompileRound } from '@isomorph/compiler';
import { ConflictError, type Adapter } from '@isomorph/adapters';
import { EventStore } from './eventstore.ts';

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
}

interface PendingVerification {
  actionId: string;
  commands: UpdateCommand[];
  executedAt: number;
}

export type RuntimeStatus = 'starting' | 'running' | 'refused' | 'error' | 'stopped';

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
  private activeViolations = new Set<string>();
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
      this.ingest(first);
      this.status = 'running';
      this.emit('status', this.status);
      this.schedule();
      return this.status;
    } catch (e) {
      this.status = 'error';
      this.error = e instanceof Error ? e.message : String(e);
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

  private async doTick(): Promise<WorldState | null> {
    try {
      const started = Date.now();
      const snap = await this.adapter.snapshot();
      this.ingest(snap, started);
      return this.world;
    } catch (e) {
      this.log(`관측 실패: ${e instanceof Error ? e.message : e}`);
      this.emit('toast', { level: 'error', message: `시스템 관측 실패: ${e instanceof Error ? e.message : e}` });
      return this.world;
    }
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
    const now = new Set<string>();
    for (const v of world.violations) {
      const key = `${v.invariantId}:${String(v.pk)}`;
      now.add(key);
      if (!this.activeViolations.has(key)) {
        const ids = world.entities.filter((e) => e.source.collection === v.collection && String(e.source.pk) === String(v.pk)).map((e) => e.id);
        this.markers.push({ ts: world.ts, invariantId: v.invariantId, title: v.title, entityIds: ids });
        if (this.markers.length > 300) this.markers.shift();
        if (!v.proposed || v.severity === 'critical') this.emit('toast', { level: 'warning', message: `법칙 위반: ${v.title} (${v.collection} #${v.pk})` });
      }
    }
    this.activeViolations = now;
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
    return snap ? observe(snap, this.grammar, this.schema) : null;
  }

  private snapshotFor(ts?: number): Snapshot | null {
    if (ts === undefined) return this.lastSnapshot;
    return this.store.snapshotAt(ts, this.schema);
  }

  inspect(entityIdValue: string, atTs?: number): InspectMessage {
    const snap = this.snapshotFor(atTs);
    const parsed = parseEntityId(entityIdValue);
    const kind = parsed ? kindById(this.grammar, parsed.kind) : undefined;
    const empty: InspectMessage = { type: 'inspect', entityId: entityIdValue, entity: null, collection: kind?.collection ?? '', pk: parsed?.pk ?? '', row: null, fields: [], violations: [], causes: [], diagnosis: null, affordances: [] };
    if (!snap || !kind || !parsed) return empty;
    const col = findCollection(this.schema, kind.collection)!;
    const world = observe(snap, this.grammar, this.schema);
    const entity = world.entities.find((e) => e.id === entityIdValue) ?? null;
    const row = (snap.collections[kind.collection] ?? []).find((r) => String(pkOf(r, col)) === parsed.pk) ?? null;
    const masked = row ? maskRow(row, col) : null;
    const fields: InspectField[] = col.fields.map((f) => {
      const b = kind.channels.find((x) => x.field === f.name);
      const role: InspectField['role'] =
        f.name === col.primaryKey ? 'pk'
          : f.name === kind.labelField ? 'label'
            : kind.route?.from === f.name || kind.route?.to === f.name ? 'route'
              : kind.recency?.field === f.name ? 'recency'
                : kind.hidden.includes(f.name) ? 'hidden' : undefined;
      return {
        name: f.name,
        type: f.type,
        value: masked ? masked[f.name] ?? null : null,
        ...(b ? { channel: b.channel, visual: entity?.visual[b.channel] ?? null } : {}),
        ...(role ? { role } : {}),
        ...(f.sensitive ? { sensitive: true } : {}),
      };
    });
    const violations = world.violations.filter((v) => v.collection === kind.collection && String(v.pk) === parsed.pk);
    const events = this.store.eventsBetween(snap.ts - 10 * 60_000, snap.ts);
    const sevRank = { critical: 0, warning: 1, info: 2 } as const;
    const top = [...violations].sort((a, b) => sevRank[a.severity] - sevRank[b.severity])[0];
    const topInv = top ? this.grammar.invariants.find((i) => i.id === top.invariantId) : undefined;
    const causes = top ? findCauses(top, events, this.schema, 20_000, row ?? undefined, topInv) : [];
    const diagnosis = top ? diagnose(top, topInv, causes) : null;
    const affordances: AffordanceOption[] = this.grammar.affordances
      .filter((a) => a.entityKind === kind.id)
      .map((a) => {
        const allowed = atTs === undefined && riskAllowed(this.writeMode, a.risk);
        const reason = atTs !== undefined ? '과거 시점에서는 행동할 수 없습니다' : !riskAllowed(this.writeMode, a.risk) ? `쓰기 권한(${this.writeMode})이 위험도 ${a.risk} 행동을 허용하지 않습니다` : undefined;
        return { id: a.id, title: a.title, description: a.description, risk: a.risk, allowed, ...(reason ? { reason } : {}) };
      });
    return { type: 'inspect', entityId: entityIdValue, entity, collection: kind.collection, pk: parsed.pk, row: masked, fields, violations, causes, diagnosis, affordances };
  }

  /** 드라이런: 아무것도 바꾸지 않고, 바뀔 미래의 장면을 계산한다. */
  dryRun(entityIdValue: string, affordanceId: string): DryRunMessage {
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
      return { ...base, current, error: e instanceof Error ? e.message : String(e) };
    }
    const future = applyCommands(snap, plan.commands, this.schema);
    const preview = observe(future, this.grammar, this.schema).entities.find((e) => e.id === entityIdValue) ?? null;
    const allowed = riskAllowed(this.writeMode, aff.risk) && plan.commands.length > 0;
    const reason = !riskAllowed(this.writeMode, aff.risk) ? `쓰기 권한(${this.writeMode})으로는 위험도 ${aff.risk} 행동을 실행할 수 없습니다` : plan.commands.length === 0 ? '세계가 이미 그 상태입니다(바꿀 것이 없음)' : undefined;
    const id = randomUUID();
    if (allowed) this.plans.set(id, { id, entityId: entityIdValue, affordanceId, title: aff.title, commands: plan.commands, commandText, preview, expires: Date.now() + 60_000 });
    return { ...base, planId: allowed ? id : null, commands: plan.commands, commandText, current, preview, allowed, ...(reason ? { reason } : {}) };
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
    const aff = this.grammar.affordances.find((a) => a.id === plan.affordanceId)!;
    if (!riskAllowed(this.writeMode, aff.risk)) throw new Error('쓰기 권한이 없습니다');
    const record: ActionRecord = { id: randomUUID(), ts: Date.now(), title: plan.title, entityId: plan.entityId, affordanceId: plan.affordanceId, commands: plan.commands, commandText: plan.commandText, status: 'applied', ...(plan.undoOf ? { undoOf: plan.undoOf } : {}) };
    try {
      await this.executeAll(plan.commands);
    } catch (e) {
      const relative = aff.edits.every((ed) => ed.delta !== undefined);
      if (e instanceof ConflictError && relative) {
        await this.refresh();
        const again = planAffordance(this.lastSnapshot!, this.grammar, this.schema, plan.entityId, plan.affordanceId);
        if (!again.ok) throw new Error(again.error);
        await this.executeAll(again.commands);
        record.commands = again.commands;
        record.commandText = again.commands.map((c) => this.adapter.describe(c));
        record.error = '동시 변경을 감지해 최신 상태 기준으로 다시 계획한 뒤 실행했습니다';
      } else {
        record.status = 'failed';
        record.error = e instanceof Error ? e.message : String(e);
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
      record.error = e instanceof ConflictError ? '그 사이 값이 바뀌어 안전하게 되돌릴 수 없습니다' : e instanceof Error ? e.message : String(e);
    }
    this.actions.unshift(record);
    this.emit('actions', this.actions);
    void this.tick();
    return record;
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
    await this.adapter.close();
    this.store.close();
  }
}
