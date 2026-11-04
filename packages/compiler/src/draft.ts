import {
  ANOMALIES,
  ARCHETYPES,
  chooseAnomaly,
  COLOR_NAMES,
  findField,
  REGION_THEMES,
  SPRITES,
  type Binding,
  type ColorName,
  type EntityKind,
  type Expr,
  type Literal,
  type SystemSchema,
  type TextBinding,
  type WorldGrammar,
} from '@isomorph/core';
import { z } from 'zod';
import { slugify } from './lexicon.ts';

/**
 * LLM이 내놓는 '초안' 형식.
 * 구조화 출력(JSON Schema)은 재귀·자유 키(record)·튜플을 지원하지 않으므로
 * 평평한(flat) 형태로 받고, 여기서 정식 WorldGrammar 로 변환한다.
 */
const Color = z.enum(COLOR_NAMES as [ColorName, ...ColorName[]]);
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const DraftBindingSchema = z.object({
  channel: z.enum(['stack', 'crowd', 'fire', 'size', 'speed', 'tint', 'lit', 'fog', 'sign']),
  field: z.string(),
  domainMin: z.number().nullable(),
  domainMax: z.number().nullable(),
  rangeMin: z.number().nullable(),
  rangeMax: z.number().nullable(),
  colors: z.array(z.object({ value: z.string(), color: Color })).nullable(),
  fallback: Color.nullable(),
  when: z.array(z.string()).nullable(),
  writeTrue: z.string().nullable(),
  writeFalse: z.string().nullable(),
  invert: z.boolean().nullable(),
  format: z.enum(['plain', 'number', 'currency', 'percent']).nullable(),
  readOnly: z.boolean().nullable(),
  unit: z.string().nullable(),
});

export const DraftExprSchema = z.object({
  op: z.enum(['cmp', 'cmpField', 'notNull', 'in', 'refExists', 'unique']),
  field: z.string(),
  cmp: z.enum(['>=', '>', '<=', '<', '==', '!=']).nullable(),
  value: Scalar.nullable(),
  other: z.string().nullable(),
  values: z.array(Scalar).nullable(),
  collection: z.string().nullable(),
  target: z.string().nullable(),
});

export const DraftSchema = z.object({
  title: z.string(),
  regions: z.array(z.object({ id: z.string(), title: z.string(), theme: z.enum(REGION_THEMES) })),
  kinds: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      collection: z.string(),
      archetype: z.enum(ARCHETYPES),
      sprite: z.enum(SPRITES),
      spritePrompt: z.string(),
      region: z.string(),
      labelField: z.string().nullable(),
      routeFrom: z.string().nullable(),
      routeTo: z.string().nullable(),
      recencyField: z.string().nullable(),
      recencySeconds: z.number().nullable(),
      channels: z.array(DraftBindingSchema),
      hidden: z.array(z.string()),
    }),
  ),
  invariants: z.array(
    z.object({
      id: z.string(),
      collection: z.string(),
      title: z.string(),
      expr: DraftExprSchema,
      anomaly: z.enum(ANOMALIES).nullable(),
      severity: z.enum(['info', 'warning', 'critical']),
    }),
  ),
  affordances: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      entityKind: z.string(),
      channel: z.enum(['stack', 'tint', 'lit']),
      value: Scalar.nullable(),
      delta: z.number().nullable(),
      risk: z.enum(['low', 'medium', 'high']),
    }),
  ),
  notes: z.array(z.string()),
});

export type Draft = z.infer<typeof DraftSchema>;
type DraftBinding = z.infer<typeof DraftBindingSchema>;

function castTo(schema: SystemSchema, collection: string, field: string, v: string | number | boolean | null): Literal {
  if (v === null) return null;
  const f = findField(schema, collection, field);
  if (!f) return v;
  if ((f.type === 'integer' || f.type === 'number') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (f.type === 'boolean' && typeof v === 'string') return v === 'true';
  return v;
}

function toBinding(b: DraftBinding, collection: string, schema: SystemSchema): Binding {
  const ro = b.readOnly ? { readOnly: true } : {};
  switch (b.channel) {
    case 'stack':
    case 'crowd':
    case 'fire':
    case 'size':
    case 'speed':
      return {
        channel: b.channel,
        field: b.field,
        scale: { domain: [b.domainMin ?? 0, b.domainMax ?? 10], range: [b.rangeMin ?? 0, b.rangeMax ?? 10] },
        ...(b.unit ? { unit: b.unit } : {}),
        ...ro,
      };
    case 'tint': {
      const map: Record<string, ColorName> = {};
      for (const c of b.colors ?? []) map[c.value] = c.color;
      return { channel: 'tint', field: b.field, map, fallback: b.fallback ?? 'purple', ...ro };
    }
    case 'lit':
    case 'fog':
      return {
        channel: b.channel,
        field: b.field,
        ...(b.when ? { when: b.when.map((w) => castTo(schema, collection, b.field, w)) } : {}),
        ...(b.invert ? { invert: true } : {}),
        ...(b.writeTrue !== null ? { writeTrue: castTo(schema, collection, b.field, b.writeTrue) } : {}),
        ...(b.writeFalse !== null ? { writeFalse: castTo(schema, collection, b.field, b.writeFalse) } : {}),
        ...ro,
      };
    case 'sign':
      return { channel: 'sign', field: b.field, format: b.format ?? 'plain' };
  }
}

function toExpr(e: Draft['invariants'][number]['expr'], collection: string, schema: SystemSchema): Expr {
  const cmp = e.cmp ?? '>=';
  switch (e.op) {
    case 'cmp':
      return { op: 'cmp', field: e.field, cmp, value: castTo(schema, collection, e.field, e.value) };
    case 'cmpField':
      return { op: 'cmpField', field: e.field, cmp, other: e.other ?? e.field };
    case 'notNull':
      return { op: 'notNull', field: e.field };
    case 'in':
      return { op: 'in', field: e.field, values: (e.values ?? []).map((v) => castTo(schema, collection, e.field, v)) };
    case 'refExists':
      return { op: 'refExists', field: e.field, collection: e.collection ?? '', target: e.target ?? 'id' };
    case 'unique':
      return { op: 'unique', field: e.field };
  }
}

export function draftToGrammar(d: Draft, schema: SystemSchema): WorldGrammar {
  const kinds: EntityKind[] = d.kinds.map((k) => ({
    id: slugify(k.id),
    title: k.title,
    collection: k.collection,
    archetype: k.archetype,
    sprite: k.sprite,
    spritePrompt: k.spritePrompt,
    region: k.region,
    ...(k.labelField ? { labelField: k.labelField } : {}),
    ...(k.routeFrom || k.routeTo ? { route: { ...(k.routeFrom ? { from: k.routeFrom } : {}), ...(k.routeTo ? { to: k.routeTo } : {}) } } : {}),
    ...(k.recencyField ? { recency: { field: k.recencyField, seconds: k.recencySeconds && k.recencySeconds > 0 ? k.recencySeconds : 60 } } : {}),
    channels: k.channels.map((b) => toBinding(b, k.collection, schema)),
    hidden: k.hidden,
    maxEntities: k.archetype === 'npc' ? 40 : 80,
  }));
  const g: WorldGrammar = {
    version: 1,
    system: schema.system,
    title: d.title,
    theme: 'town',
    generatedBy: 'llm',
    regions: d.regions,
    kinds,
    invariants: [],
    affordances: d.affordances.map((a) => ({
      id: slugify(a.id),
      title: a.title,
      description: a.description,
      entityKind: slugify(a.entityKind),
      edits: [{ channel: a.channel, ...(a.delta !== null ? { delta: a.delta } : { value: a.value }) }],
      risk: a.risk,
    })),
    notes: d.notes,
  };
  g.invariants = d.invariants.map((i) => {
    const inv = {
      id: slugify(i.id),
      collection: i.collection,
      title: i.title,
      expr: toExpr(i.expr, i.collection, schema),
      anomaly: i.anomaly ?? 'glitch',
      source: 'llm' as const,
      status: 'proposed' as const,
      severity: i.severity,
    };
    return { ...inv, anomaly: i.anomaly ?? chooseAnomaly(inv, g, schema) };
  });
  return g;
}

/** 정식 문법 → 초안(LLM 에게 출발점이나 이전 시도로 보여줄 때) */
export function grammarToDraft(g: WorldGrammar): Draft {
  const nul = { domainMin: null, domainMax: null, rangeMin: null, rangeMax: null, colors: null, fallback: null, when: null, writeTrue: null, writeFalse: null, invert: null, format: null, readOnly: null, unit: null };
  const flatScalar = (v: unknown) => (v === undefined || v === null ? null : (v as string | number | boolean));
  return {
    title: g.title,
    regions: g.regions,
    kinds: g.kinds.map((k) => ({
      id: k.id,
      title: k.title,
      collection: k.collection,
      archetype: k.archetype,
      sprite: k.sprite,
      spritePrompt: k.spritePrompt,
      region: k.region,
      labelField: k.labelField ?? null,
      routeFrom: k.route?.from ?? null,
      routeTo: k.route?.to ?? null,
      recencyField: k.recency?.field ?? null,
      recencySeconds: k.recency?.seconds ?? null,
      hidden: k.hidden,
      channels: k.channels.map((b): DraftBinding => {
        const base = { ...nul, channel: b.channel, field: b.field, readOnly: 'readOnly' in b && b.readOnly ? true : null };
        if ('scale' in b) return { ...base, domainMin: b.scale.domain[0], domainMax: b.scale.domain[1], rangeMin: b.scale.range[0], rangeMax: b.scale.range[1], unit: b.unit ?? null };
        if (b.channel === 'tint') return { ...base, colors: Object.entries(b.map).map(([value, color]) => ({ value, color })), fallback: b.fallback };
        if (b.channel === 'lit' || b.channel === 'fog') {
          return { ...base, when: b.when ? b.when.map(String) : null, writeTrue: b.writeTrue === undefined ? null : String(b.writeTrue), writeFalse: b.writeFalse === undefined ? null : String(b.writeFalse), invert: b.invert ?? null };
        }
        return { ...base, format: (b as TextBinding).format };
      }),
    })),
    invariants: g.invariants.map((i) => {
      const e = i.expr;
      const flat = { op: 'notNull' as const, field: '', cmp: null, value: null, other: null, values: null, collection: null, target: null };
      let expr: Draft['invariants'][number]['expr'] = flat;
      if (e.op === 'cmp') expr = { ...flat, op: 'cmp', field: e.field, cmp: e.cmp, value: flatScalar(e.value) };
      else if (e.op === 'cmpField') expr = { ...flat, op: 'cmpField', field: e.field, cmp: e.cmp, other: e.other };
      else if (e.op === 'notNull') expr = { ...flat, field: e.field };
      else if (e.op === 'in') expr = { ...flat, op: 'in', field: e.field, values: e.values.filter((v) => v !== null) as (string | number | boolean)[] };
      else if (e.op === 'refExists') expr = { ...flat, op: 'refExists', field: e.field, collection: e.collection, target: e.target };
      else if (e.op === 'unique') expr = { ...flat, op: 'unique', field: e.field };
      return { id: i.id, collection: i.collection, title: i.title, expr, anomaly: i.anomaly, severity: i.severity };
    }),
    affordances: g.affordances.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      entityKind: a.entityKind,
      channel: a.edits[0].channel,
      value: flatScalar(a.edits[0].value),
      delta: a.edits[0].delta ?? null,
      risk: a.risk,
    })),
    notes: g.notes,
  };
}
