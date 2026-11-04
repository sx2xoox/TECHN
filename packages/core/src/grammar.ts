import { z } from 'zod';
import { ExprSchema } from './expr.ts';

/**
 * 시각 대응 어휘(Visual Channel Algebra).
 * 시스템의 필드는 반드시 이 중 하나의 채널로만 세계에 나타난다.
 * 채널의 종류(kind)가 필드 타입과 맞아야 하며(베르탱의 시각 변수 원칙), 편집 가능한 채널만 put 방향을 갖는다.
 */
export const CHANNELS = {
  stack: { kind: 'quantitative', editable: true, integer: true, ko: '쌓인 상자 수' },
  crowd: { kind: 'quantitative', editable: false, integer: true, ko: '주변 인파' },
  fire: { kind: 'quantitative', editable: false, integer: true, ko: '불길 세기' },
  size: { kind: 'quantitative', editable: false, integer: false, ko: '건물 크기' },
  speed: { kind: 'quantitative', editable: false, integer: false, ko: '이동 속도' },
  tint: { kind: 'categorical', editable: true, integer: false, ko: '색깔' },
  lit: { kind: 'boolean', editable: true, integer: false, ko: '창문 불빛' },
  fog: { kind: 'boolean', editable: false, integer: false, ko: '안개' },
  sign: { kind: 'text', editable: false, integer: false, ko: '간판 글씨' },
} as const;

export type ChannelName = keyof typeof CHANNELS;
export const CHANNEL_NAMES = Object.keys(CHANNELS) as ChannelName[];
export const QUANT_CHANNELS = ['stack', 'crowd', 'fire', 'size', 'speed'] as const;

export const PALETTE = {
  green: { hex: '#5bbf4a', ko: '초록' },
  yellow: { hex: '#f2c94c', ko: '노랑' },
  red: { hex: '#e5533d', ko: '빨강' },
  blue: { hex: '#4a8fe7', ko: '파랑' },
  purple: { hex: '#9b6bd6', ko: '보라' },
  orange: { hex: '#f08a3c', ko: '주황' },
  teal: { hex: '#3cbfae', ko: '청록' },
  pink: { hex: '#e77fb3', ko: '분홍' },
  brown: { hex: '#9a6b44', ko: '갈색' },
  gray: { hex: '#8a8f98', ko: '회색' },
} as const;
export type ColorName = keyof typeof PALETTE;
export const COLOR_NAMES = Object.keys(PALETTE) as ColorName[];
const ColorSchema = z.enum(COLOR_NAMES as [ColorName, ...ColorName[]]);

const LiteralSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const QuantBindingSchema = z.object({
  channel: z.enum(QUANT_CHANNELS),
  field: z.string(),
  scale: z.object({
    domain: z.tuple([z.number(), z.number()]),
    range: z.tuple([z.number(), z.number()]),
  }),
  unit: z.string().optional(),
  readOnly: z.boolean().optional(),
});

export const CategoricalBindingSchema = z.object({
  channel: z.literal('tint'),
  field: z.string(),
  map: z.record(z.string(), ColorSchema),
  fallback: ColorSchema,
  readOnly: z.boolean().optional(),
});

export const BooleanBindingSchema = z.object({
  channel: z.enum(['lit', 'fog']),
  field: z.string(),
  /** 범주형 필드일 때: 이 값들이면 true */
  when: z.array(LiteralSchema).optional(),
  invert: z.boolean().optional(),
  /** put 방향: 세계의 true/false 를 어떤 필드 값으로 쓸지(범주형 필드일 때 필요) */
  writeTrue: LiteralSchema.optional(),
  writeFalse: LiteralSchema.optional(),
  readOnly: z.boolean().optional(),
});

export const TextBindingSchema = z.object({
  channel: z.literal('sign'),
  field: z.string(),
  format: z.enum(['plain', 'number', 'currency', 'percent']).default('plain'),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
});

export const BindingSchema = z.union([QuantBindingSchema, CategoricalBindingSchema, BooleanBindingSchema, TextBindingSchema]);

export const ARCHETYPES = ['building', 'npc', 'landmark'] as const;
export const SPRITES = [
  'house', 'warehouse', 'shop', 'bank', 'factory', 'townhall', 'library', 'clinic', 'school', 'tower', 'post', 'farm',
  'theater', 'station', 'office', 'signpost',
  'merchant', 'villager', 'courier', 'robot',
] as const;
export const REGION_THEMES = ['market', 'residential', 'finance', 'industrial', 'plaza', 'civic', 'farmland'] as const;
export const ANOMALIES = ['ghost', 'glitch', 'levitate', 'doppelganger', 'orphan', 'timewarp'] as const;

export const ANOMALY_KO: Record<(typeof ANOMALIES)[number], string> = {
  ghost: '유령 물건(있을 수 없는 수량)',
  glitch: '화면 깨짐(규칙 위반)',
  levitate: '공중부양(허용되지 않은 값)',
  doppelganger: '도플갱어(중복)',
  orphan: '길 잃음(참조 대상 없음)',
  timewarp: '시간 역행(시간 순서 위반)',
};

export const RegionSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.enum(REGION_THEMES),
});

export const EntityKindSchema = z.object({
  id: z.string(),
  title: z.string(),
  collection: z.string(),
  archetype: z.enum(ARCHETYPES),
  sprite: z.enum(SPRITES),
  spritePrompt: z.string(),
  region: z.string(),
  labelField: z.string().optional(),
  /** NPC 이동 경로: 참조 필드 이름(출발/도착 건물) */
  route: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  /** 최근 행만 세계에 등장(스냅샷 시각 기준) */
  recency: z.object({ field: z.string(), seconds: z.number().positive() }).optional(),
  /** 이 조건을 만족하는 행만 등장 */
  filter: ExprSchema.optional(),
  channels: z.array(BindingSchema),
  /** 명시적으로 세계에 그리지 않는 필드(정직성: 숨긴 것도 숨겼다고 선언) */
  hidden: z.array(z.string()),
  maxEntities: z.number().int().positive().optional(),
  /**
   * 은유를 고른 근거(정직성): 이름 사전 · 구조(기준표·연결표·접수처·회관) · 담긴 필드의 특징 · 근거 없음(일반 은유)
   */
  metaphorBasis: z.enum(['name', 'structure', 'fields', 'generic', 'llm', 'manual']).optional(),
});

export const InvariantSchema = z.object({
  id: z.string(),
  collection: z.string(),
  title: z.string(),
  expr: ExprSchema,
  anomaly: z.enum(ANOMALIES),
  source: z.enum(['schema', 'heuristic', 'dynamic', 'llm', 'user']),
  status: z.enum(['confirmed', 'proposed', 'dismissed']),
  severity: z.enum(['info', 'warning', 'critical']),
});

export const ChannelEditSchema = z.object({
  channel: z.enum(['stack', 'tint', 'lit']),
  value: LiteralSchema.optional(),
  delta: z.number().optional(),
});

export const AffordanceSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  entityKind: z.string(),
  edits: z.array(ChannelEditSchema).min(1),
  risk: z.enum(['low', 'medium', 'high']),
  /** 이 행동을 되돌리는 행동(있다면) */
  inverseOf: z.string().optional(),
});

export const WorldGrammarSchema = z.object({
  version: z.literal(1),
  system: z.string(),
  title: z.string(),
  theme: z.literal('town'),
  generatedBy: z.enum(['heuristic', 'llm', 'manual']),
  regions: z.array(RegionSchema),
  kinds: z.array(EntityKindSchema),
  invariants: z.array(InvariantSchema),
  affordances: z.array(AffordanceSchema),
  notes: z.array(z.string()).default([]),
});

export type QuantBinding = z.infer<typeof QuantBindingSchema>;
export type CategoricalBinding = z.infer<typeof CategoricalBindingSchema>;
export type BooleanBinding = z.infer<typeof BooleanBindingSchema>;
export type TextBinding = z.infer<typeof TextBindingSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type EntityKind = z.infer<typeof EntityKindSchema>;
export type Invariant = z.infer<typeof InvariantSchema>;
export type ChannelEdit = z.infer<typeof ChannelEditSchema>;
export type Affordance = z.infer<typeof AffordanceSchema>;
export type WorldGrammar = z.infer<typeof WorldGrammarSchema>;
export type AnomalyKind = (typeof ANOMALIES)[number];
export type Archetype = (typeof ARCHETYPES)[number];
export type SpriteKey = (typeof SPRITES)[number];

export function isQuant(b: Binding): b is QuantBinding {
  return (QUANT_CHANNELS as readonly string[]).includes(b.channel);
}
export function isCategorical(b: Binding): b is CategoricalBinding {
  return b.channel === 'tint';
}
export function isBoolean(b: Binding): b is BooleanBinding {
  return b.channel === 'lit' || b.channel === 'fog';
}
export function isText(b: Binding): b is TextBinding {
  return b.channel === 'sign';
}

/** put 방향이 열려 있는 바인딩인가(채널이 편집 가능하고, 바인딩이 읽기 전용이 아님) */
export function isEditableBinding(b: Binding): boolean {
  return CHANNELS[b.channel].editable && !('readOnly' in b && b.readOnly);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseGrammar(input: unknown): ParseResult<WorldGrammar> {
  const r = WorldGrammarSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

export function kindById(grammar: WorldGrammar, id: string): EntityKind | undefined {
  return grammar.kinds.find((k) => k.id === id);
}

export function entityId(kindId: string, pk: string | number): string {
  return `${kindId}:${pk}`;
}

export function parseEntityId(id: string): { kind: string; pk: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  return { kind: id.slice(0, i), pk: id.slice(i + 1) };
}
