import type { CauseEvent, Diagnosis } from './diagnose.ts';
import type { SystemModel } from './model.ts';
import type { Hypothesis, SimulationResult } from './simulate.ts';
import type { Affordance, ChannelName, WorldGrammar } from './grammar.ts';
import type { LegendEntry } from './legend.ts';
import type { UpdateCommand } from './lens.ts';
import type { FieldType, Pk, Row } from './schema.ts';
import type { VerificationReport } from './verify.ts';
import type { VisualValue, Violation, WorldEntity, WorldState } from './world.ts';

/** 서버 ↔ 클라이언트 WebSocket 프로토콜 */

export type WriteMode = 'read-only' | 'low' | 'medium' | 'high';
export const RISK_ORDER = { 'read-only': 0, low: 1, medium: 2, high: 3 } as const;

export function riskAllowed(mode: WriteMode, risk: Affordance['risk']): boolean {
  return RISK_ORDER[mode] >= RISK_ORDER[risk];
}

export interface AssetEntry {
  file: string;
  prompt: string;
  width: number;
  height: number;
  source: 'pixellab' | 'procedural';
  hash: string;
}

export interface AssetManifest {
  version: 1;
  style: string;
  generatedAt: string;
  assets: Record<string, AssetEntry>;
}

export interface HelloMessage {
  type: 'hello';
  system: string;
  source: string;
  grammar: WorldGrammar;
  legend: LegendEntry[];
  verification: VerificationReport;
  writeMode: WriteMode;
  assets: AssetManifest | null;
  pollMs: number;
  /** 이 접속의 권한(보기 전용이면 행동 버튼이 잠긴다) */
  role?: 'operator' | 'viewer';
  /** 변경 알림으로 즉시 관측 중인가 */
  push?: boolean;
}

export interface WorldMessage {
  type: 'world';
  mode: 'live' | 'history';
  world: WorldState;
}

export interface TimelineMarker {
  ts: number;
  invariantId: string;
  title: string;
  entityIds: string[];
}

export interface TimelineMessage {
  type: 'timeline';
  start: number;
  end: number;
  markers: TimelineMarker[];
}

export interface InspectField {
  name: string;
  type: FieldType;
  value: unknown;
  channel?: ChannelName;
  visual?: VisualValue;
  role?: 'pk' | 'label' | 'route' | 'recency' | 'filter' | 'hidden';
  sensitive?: boolean;
}

export interface AffordanceOption {
  id: string;
  title: string;
  description: string;
  risk: Affordance['risk'];
  allowed: boolean;
  reason?: string;
}

export interface InspectMessage {
  type: 'inspect';
  entityId: string;
  entity: WorldEntity | null;
  collection: string;
  pk: Pk;
  row: Row | null;
  fields: InspectField[];
  violations: Violation[];
  causes: CauseEvent[];
  diagnosis: Diagnosis | null;
  affordances: AffordanceOption[];
}

export interface DryRunMessage {
  type: 'dryrun';
  planId: string | null;
  entityId: string;
  affordanceId: string;
  title: string;
  commands: UpdateCommand[];
  commandText: string[];
  current: WorldEntity | null;
  preview: WorldEntity | null;
  risk: Affordance['risk'];
  allowed: boolean;
  reason?: string;
  error?: string;
}

export interface ActionRecord {
  id: string;
  ts: number;
  title: string;
  entityId: string;
  affordanceId?: string;
  commands: UpdateCommand[];
  commandText: string[];
  status: 'applied' | 'verified' | 'mismatch' | 'failed' | 'undone';
  error?: string;
  verifiedAt?: number;
  undoOf?: string;
}

export interface ActionsMessage {
  type: 'actions';
  actions: ActionRecord[];
}

export interface GrammarMessage {
  type: 'grammar';
  grammar: WorldGrammar;
  legend: LegendEntry[];
}

export interface ToastMessage {
  type: 'toast';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

/** 가설 실험실: 학습한 규칙 + 제안 가설 */
export interface LabMessage {
  type: 'lab';
  model: SystemModel;
  hypotheses: Hypothesis[];
}

export interface SimulationProgressMessage {
  type: 'simulation-progress';
  hypothesisId: string;
  done: number;
  total: number;
}

export interface SimulationMessage {
  type: 'simulation';
  result: SimulationResult;
}

export type ServerMessage =
  | LabMessage
  | SimulationProgressMessage
  | SimulationMessage
  | HelloMessage
  | WorldMessage
  | TimelineMessage
  | InspectMessage
  | DryRunMessage
  | ActionsMessage
  | GrammarMessage
  | ToastMessage;

export type ClientMessage =
  | { type: 'inspect'; entityId: string }
  | { type: 'dryrun'; entityId: string; affordanceId: string }
  | { type: 'approve'; planId: string }
  | { type: 'cancel'; planId: string }
  | { type: 'undo'; actionId: string }
  | { type: 'seek'; ts: number }
  | { type: 'live' }
  | { type: 'invariant'; id: string; status: 'confirmed' | 'dismissed' }
  | { type: 'lab' }
  | { type: 'simulate'; hypothesis: Hypothesis };
