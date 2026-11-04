import { evalExpr } from './expr.ts';
import {
  CHANNELS,
  entityId,
  isBoolean,
  isCategorical,
  isEditableBinding,
  isQuant,
  isText,
  kindById,
  parseEntityId,
  type Binding,
  type BooleanBinding,
  type CategoricalBinding,
  type ChannelEdit,
  type ChannelName,
  type EntityKind,
  type QuantBinding,
  type TextBinding,
  type WorldGrammar,
} from './grammar.ts';
import { buildContextFactory } from './context.ts';
import { findCollection, findField, pkOf, type FieldSchema, type Pk, type Row, type Snapshot, type SystemSchema } from './schema.ts';
import type { VisualValue, WorldEntity, WorldLink } from './world.ts';

/* ───────────────────────── 채널 인코딩(get) / 디코딩(put) ───────────────────────── */

export interface Encoded {
  visual: VisualValue;
  outOfRange: boolean;
}

function linear(b: QuantBinding, v: number): number {
  const [d0, d1] = b.scale.domain;
  const [r0, r1] = b.scale.range;
  return r0 + ((v - d0) * (r1 - r0)) / (d1 - d0);
}

function truthyOf(b: BooleanBinding, v: unknown): boolean {
  if (b.when) return b.when.some((x) => x === v || (v !== null && v !== undefined && String(x) === String(v)));
  return v === true || v === 'true' || v === 1;
}

function formatText(b: TextBinding, v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  switch (b.format) {
    case 'number':
      s = typeof v === 'number' ? v.toLocaleString('ko-KR') : String(v);
      break;
    case 'currency':
      s = typeof v === 'number' ? `₩${Math.round(v).toLocaleString('ko-KR')}` : String(v);
      break;
    case 'percent':
      s = typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : String(v);
      break;
    default:
      s = String(v);
  }
  return `${b.prefix ?? ''}${s}${b.suffix ?? ''}`;
}

export function encodeChannel(b: Binding, v: unknown): Encoded {
  if (isQuant(b)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return { visual: null, outOfRange: false };
    const lo = Math.min(...b.scale.domain);
    const hi = Math.max(...b.scale.domain);
    const raw = linear(b, v);
    const visual = CHANNELS[b.channel].integer ? Math.round(raw) : Number(raw.toFixed(4));
    return { visual, outOfRange: v < lo || v > hi };
  }
  if (isCategorical(b)) {
    const key = v === null || v === undefined ? 'null' : String(v);
    return { visual: b.map[key] ?? b.fallback, outOfRange: !(key in b.map) };
  }
  if (isBoolean(b)) {
    const t = truthyOf(b, v);
    return { visual: b.invert ? !t : t, outOfRange: false };
  }
  return { visual: formatText(b as TextBinding, v), outOfRange: false };
}

export type Decoded = { ok: true; value: unknown } | { ok: false; error: string };

function castKey(key: string, field: FieldSchema | undefined): unknown {
  if (key === 'null') return null;
  if (!field) return key;
  if (field.type === 'integer' || field.type === 'number') return Number(key);
  if (field.type === 'boolean') return key === 'true';
  return key;
}

/** 세계의 채널 값을 시스템 필드 값으로 되돌린다(put 방향). */
export function decodeChannel(b: Binding, target: VisualValue, field: FieldSchema | undefined): Decoded {
  if (!isEditableBinding(b)) return { ok: false, error: `${b.channel} 채널(${b.field})은 편집할 수 없습니다` };
  if (isQuant(b)) {
    if (typeof target !== 'number' || !Number.isInteger(target)) return { ok: false, error: '상자 수는 정수여야 합니다' };
    const [d0, d1] = b.scale.domain;
    const [r0, r1] = b.scale.range;
    let v = d0 + ((target - r0) * (d1 - d0)) / (r1 - r0);
    if (!field || field.type === 'integer') v = Math.round(v);
    return { ok: true, value: v };
  }
  if (isCategorical(b)) {
    const keys = Object.entries((b as CategoricalBinding).map)
      .filter(([, c]) => c === target)
      .map(([k]) => k);
    if (keys.length === 0) return { ok: false, error: `색 ${String(target)} 에 대응하는 값이 없습니다` };
    if (keys.length > 1) return { ok: false, error: `색 ${String(target)} 이 여러 값(${keys.join(', ')})에 대응해 되돌릴 수 없습니다` };
    return { ok: true, value: castKey(keys[0], field) };
  }
  if (isBoolean(b)) {
    if (typeof target !== 'boolean') return { ok: false, error: '불빛은 켜짐/꺼짐만 가능합니다' };
    const effective = b.invert ? !target : target;
    if (b.when) {
      const w = effective ? b.writeTrue : b.writeFalse;
      if (w === undefined) return { ok: false, error: `${effective ? 'writeTrue' : 'writeFalse'} 가 선언되지 않았습니다` };
      return { ok: true, value: w };
    }
    return { ok: true, value: effective };
  }
  return { ok: false, error: '간판은 편집할 수 없습니다' };
}

/* ───────────────────────────────── get ───────────────────────────────── */

function comparePk(a: Pk, b: Pk): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function isShown(kind: EntityKind, row: Row, snapshot: Snapshot, ctxFor: ReturnType<typeof buildContextFactory>): boolean {
  if (kind.filter && !evalExpr(kind.filter, row, ctxFor(kind.collection))) return false;
  if (kind.recency) {
    const v = row[kind.recency.field];
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isNaN(t)) return false;
    if (snapshot.ts - t > kind.recency.seconds * 1000) return false;
  }
  return true;
}

/** 시스템 상태 → 세계 상태 (렌즈의 get). 순수 함수: 같은 입력이면 항상 같은 세계. */
export function project(snapshot: Snapshot, grammar: WorldGrammar, schema: SystemSchema): WorldEntity[] {
  const ctxFor = buildContextFactory(snapshot, schema);
  const entities: WorldEntity[] = [];
  const shownIds = new Set<string>();
  const pending: { entity: WorldEntity; kind: EntityKind; row: Row }[] = [];

  for (const kind of grammar.kinds) {
    const col = findCollection(schema, kind.collection);
    if (!col) continue;
    let rows = (snapshot.collections[kind.collection] ?? []).filter((r) => isShown(kind, r, snapshot, ctxFor));
    rows = [...rows].sort((a, b) => comparePk(pkOf(a, col), pkOf(b, col)));
    if (kind.maxEntities && rows.length > kind.maxEntities) rows = rows.slice(rows.length - kind.maxEntities);
    rows.forEach((row, slot) => {
      const pk = pkOf(row, col);
      const visual: WorldEntity['visual'] = {};
      const outOfRange: ChannelName[] = [];
      for (const b of kind.channels) {
        const e = encodeChannel(b, row[b.field]);
        visual[b.channel] = e.visual;
        if (e.outOfRange) outOfRange.push(b.channel);
      }
      const label = kind.labelField && row[kind.labelField] !== null && row[kind.labelField] !== undefined
        ? String(row[kind.labelField])
        : `${kind.title} #${pk}`;
      const entity: WorldEntity = {
        id: entityId(kind.id, pk),
        kind: kind.id,
        archetype: kind.archetype,
        sprite: kind.sprite,
        label,
        region: kind.region,
        slot,
        visual,
        outOfRange,
        links: [],
        source: { collection: kind.collection, pk },
        anomalies: [],
      };
      shownIds.add(entity.id);
      entities.push(entity);
      pending.push({ entity, kind, row });
    });
  }

  // 2단계: 경로(참조) 연결
  for (const { entity, kind, row } of pending) {
    if (!kind.route) continue;
    for (const role of ['from', 'to'] as const) {
      const fieldName = kind.route[role];
      if (!fieldName) continue;
      const field = findField(schema, kind.collection, fieldName);
      const v = row[fieldName];
      let link: WorldLink;
      if (v === null || v === undefined || !field?.ref) {
        link = { role, target: null, missing: v !== null && v !== undefined };
      } else {
        const targetKind = grammar.kinds.find((k) => k.collection === field.ref!.collection && k.archetype !== 'npc');
        const target = targetKind ? entityId(targetKind.id, v as Pk) : null;
        link = { role, target, missing: !target || !shownIds.has(target) };
      }
      entity.links.push(link);
    }
  }
  return entities;
}

/* ───────────────────────────────── put ───────────────────────────────── */

export interface UpdateCommand {
  op: 'update';
  collection: string;
  pk: Pk;
  patch: Row;
  /** 되돌리기와 낙관적 동시성 검사를 위한 변경 전 값 */
  before: Row;
}

export interface WorldEdit {
  entityId: string;
  edits: ChannelEdit[];
}

export type PutResult = { ok: true; commands: UpdateCommand[] } | { ok: false; error: string };

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 세계 편집 → 시스템 명령 (렌즈의 put). 세계가 이미 목표 상태면 명령은 비어 있다(GetPut). */
export function put(snapshot: Snapshot, grammar: WorldGrammar, schema: SystemSchema, edit: WorldEdit): PutResult {
  const parsed = parseEntityId(edit.entityId);
  if (!parsed) return { ok: false, error: `잘못된 엔티티 id: ${edit.entityId}` };
  const kind = kindById(grammar, parsed.kind);
  if (!kind) return { ok: false, error: `알 수 없는 종류: ${parsed.kind}` };
  const col = findCollection(schema, kind.collection);
  if (!col) return { ok: false, error: `알 수 없는 컬렉션: ${kind.collection}` };
  const entity = project(snapshot, grammar, schema).find((e) => e.id === edit.entityId);
  if (!entity) return { ok: false, error: `세계에 없는 엔티티: ${edit.entityId}` };
  const row = (snapshot.collections[kind.collection] ?? []).find((r) => String(pkOf(r, col)) === parsed.pk);
  if (!row) return { ok: false, error: `원본 행이 없습니다: ${edit.entityId}` };

  const patch: Row = {};
  for (const e of edit.edits) {
    const binding = kind.channels.find((b) => b.channel === e.channel);
    if (!binding) return { ok: false, error: `${kind.title}에는 ${e.channel} 채널이 없습니다` };
    const current = entity.visual[e.channel] ?? null;
    let target: VisualValue;
    if (e.delta !== undefined) {
      if (typeof current !== 'number') return { ok: false, error: `${e.channel} 의 현재 값이 숫자가 아닙니다` };
      target = current + e.delta;
    } else {
      target = (e.value ?? null) as VisualValue;
    }
    if (sameValue(target, current)) continue; // 세계가 이미 목표 상태
    // 상대 편집(+n 상자)은 양자화 격자에 맞추지 않고 정확히 n×(상자당 단위)만큼 더한다.
    // linear(v + n·k) = linear(v) + n 이므로 PutGet 이 그대로 성립한다.
    if (e.delta !== undefined && isQuant(binding) && isEditableBinding(binding)) {
      const raw = row[binding.field];
      if (typeof raw !== 'number') return { ok: false, error: `${binding.field} 의 현재 값이 숫자가 아닙니다` };
      const k = (binding.scale.domain[1] - binding.scale.domain[0]) / (binding.scale.range[1] - binding.scale.range[0]);
      const f = findField(schema, kind.collection, binding.field);
      const next = raw + e.delta * k;
      patch[binding.field] = !f || f.type === 'integer' ? Math.round(next) : next;
      continue;
    }
    const decoded = decodeChannel(binding, target, findField(schema, kind.collection, binding.field));
    if (!decoded.ok) return { ok: false, error: decoded.error };
    if (binding.field in patch && !sameValue(patch[binding.field], decoded.value)) {
      return { ok: false, error: `${binding.field} 에 서로 다른 편집이 충돌합니다` };
    }
    if (!sameValue(row[binding.field], decoded.value)) patch[binding.field] = decoded.value;
  }
  if (Object.keys(patch).length === 0) return { ok: true, commands: [] };
  const before: Row = {};
  for (const k of Object.keys(patch)) before[k] = row[k] ?? null;
  return { ok: true, commands: [{ op: 'update', collection: kind.collection, pk: pkOf(row, col), patch, before }] };
}

/** 명령을 스냅샷에 순수하게 적용(드라이런·검증용). */
export function applyCommands(snapshot: Snapshot, commands: UpdateCommand[], schema: SystemSchema): Snapshot {
  if (commands.length === 0) return snapshot;
  const collections = { ...snapshot.collections };
  for (const cmd of commands) {
    const col = findCollection(schema, cmd.collection);
    if (!col) continue;
    collections[cmd.collection] = (collections[cmd.collection] ?? []).map((r) =>
      String(pkOf(r, col)) === String(cmd.pk) ? { ...r, ...cmd.patch } : r,
    );
  }
  return { ...snapshot, collections };
}

export function invertCommands(commands: UpdateCommand[]): UpdateCommand[] {
  return [...commands].reverse().map((c) => ({ op: 'update', collection: c.collection, pk: c.pk, patch: c.before, before: c.patch }));
}

export function planAffordance(
  snapshot: Snapshot,
  grammar: WorldGrammar,
  schema: SystemSchema,
  entityIdValue: string,
  affordanceId: string,
): PutResult {
  const aff = grammar.affordances.find((a) => a.id === affordanceId);
  if (!aff) return { ok: false, error: `알 수 없는 행동: ${affordanceId}` };
  const parsed = parseEntityId(entityIdValue);
  if (!parsed || parsed.kind !== aff.entityKind) return { ok: false, error: `${aff.title} 은(는) 이 대상에 쓸 수 없습니다` };
  return put(snapshot, grammar, schema, { entityId: entityIdValue, edits: aff.edits });
}
