import {
  chooseAnomaly,
  mineHeuristicInvariants,
  mineSchemaInvariants,
  type Affordance,
  type Binding,
  type CollectionSchema,
  type EntityKind,
  type FieldSchema,
  type Invariant,
  type Region,
  type SystemSchema,
  type WorldGrammar,
  assignGlyphs,
} from '@isomorph/core';
import {
  assignColors,
  CANCEL_VALUES,
  CREATED_RE,
  CROWD_RE,
  DEFAULT_PLACE,
  EVENT_PLACE,
  FIELD_SIGNATURES,
  HUB_PLACE,
  LOOKUP_PLACE,
  DEFAULT_WALKER,
  ENUM_RE,
  FIRE_RE,
  FOG_RE,
  LABEL_RE,
  LANDMARK_RE,
  LIT_RE,
  MONEY_RE,
  niceCeil,
  PLACE_GROUPS,
  REGION_ORDER,
  REGIONS,
  RESTOCK_RE,
  RUNNING_VALUES,
  SIGN_RE,
  slugify,
  SPEED_RE,
  STACK_RE,
  STOPPED_VALUES,
  WALKER_GROUPS,
} from './lexicon.ts';

/**
 * 규칙 기반 Metaphor Compiler.
 * LLM 없이도 동작하는 결정적 컴파일러이며, LLM 모드의 출발점·최후 보루 역할을 한다.
 */

type Role = 'building' | 'npc' | 'landmark';

function isNumeric(f: FieldSchema) {
  return f.type === 'integer' || f.type === 'number';
}

/** 서로 다른 두 곳을 잇기만 하는 연결표(예: film_actor, playlist_track) */
export function isJoin(c: CollectionSchema): boolean {
  const targets = new Set(c.fields.filter((f) => f.ref && f.ref.collection !== c.name).map((f) => f.ref!.collection));
  const rest = c.fields.filter((f) => !f.ref && f.name !== c.primaryKey && f.type !== 'timestamp');
  return targets.size === 2 && rest.length <= 2;
}

/** 다른 테이블이 가리키는, 이름 하나 남짓 담은 작은 기준표(예: genre, category, language) */
export function isLookup(c: CollectionSchema, schema: SystemSchema): boolean {
  const refsIn = schema.collections.some((o) => o.name !== c.name && o.fields.some((f) => f.ref?.collection === c.name));
  const rest = c.fields.filter((f) => f.name !== c.primaryKey && !f.ref && f.type !== 'timestamp');
  return refsIn && rest.length >= 1 && rest.length <= 2 && rest.some((f) => f.type === 'string') && (c.rowCountHint === undefined || c.rowCountHint <= 300);
}

function classify(c: CollectionSchema, schema: SystemSchema): Role {
  const refsOut = c.fields.filter((f) => f.ref && f.ref.collection !== c.name).length;
  const refsIn = schema.collections.reduce(
    (n, other) => n + other.fields.filter((f) => f.ref?.collection === c.name && other.name !== c.name).length,
    0,
  );
  const hasTime = c.fields.some((f) => f.type === 'timestamp');
  const hasStatus = c.fields.some((f) => f.type === 'string' && f.enumValues && f.enumValues.length > 0);
  const numericCount = c.fields.filter((f) => isNumeric(f) && f.name !== c.primaryKey && !f.ref).length;
  if (refsOut >= 1 && refsIn === 0 && (hasTime || hasStatus || isJoin(c) || WALKER_GROUPS.some((g) => g.re.test(c.name)))) return 'npc';
  if ((c.rowCountHint === 1 || LANDMARK_RE.test(c.name)) && numericCount >= 1 && refsIn === 0) return 'landmark';
  return 'building';
}

interface KindPlan {
  kind: EntityKind;
  affordances: Affordance[];
  notes: string[];
}

function quant(channel: 'stack' | 'crowd' | 'fire' | 'size' | 'speed', f: FieldSchema): Binding {
  const max = Math.max(f.stats?.max ?? 0, 0);
  switch (channel) {
    case 'stack':
      return { channel, field: f.name, scale: { domain: [0, niceCeil(Math.max(max * 1.5, 10))], range: [0, 10] } };
    case 'crowd':
      return { channel, field: f.name, scale: { domain: [0, niceCeil(Math.max(max * 1.5, 10))], range: [0, 12] } };
    case 'fire':
      return { channel, field: f.name, scale: { domain: [0, niceCeil(Math.max(max * 2, 5))], range: [0, 5] } };
    case 'speed':
      return { channel, field: f.name, scale: { domain: [0, niceCeil(Math.max(max * 2, 1000))], range: [1, 0.2] }, ...(/ms/i.test(f.name) ? { unit: 'ms' } : {}) };
    case 'size':
      return { channel, field: f.name, scale: { domain: [0, niceCeil(Math.max(max * 1.2, 10))], range: [0.8, 1.5] } };
  }
}

function planKind(c: CollectionSchema, role: Role, schema: SystemSchema, roles: Map<string, Role>): KindPlan {
  const id = slugify(c.name);
  const notes: string[] = [];
  const channels: Binding[] = [];
  const hidden: string[] = [];
  const used = new Set<string>();
  const take = (ch: string) => {
    if (used.has(ch)) return false;
    used.add(ch);
    return true;
  };
  let labelField: string | undefined;
  const route: { from?: string; to?: string } = {};
  let recency: EntityKind['recency'];

  let sprite: EntityKind['sprite'];
  let title: string;
  let region: Region;
  let basis: NonNullable<EntityKind['metaphorBasis']>;
  // 필드 특징: 같은 묶음의 필드가 하나 이상 있으면(숨김·기본키 제외) 그 묶음의 은유
  const signature = FIELD_SIGNATURES.find((sig) => c.fields.some((f) => f.name !== c.primaryKey && !f.ref && sig.re.test(f.name)));
  if (role === 'npc') {
    const named = WALKER_GROUPS.find((w) => w.re.test(c.name));
    const g = named ?? signature?.walker ?? DEFAULT_WALKER;
    sprite = g.sprite;
    title = g.title;
    basis = named ? 'name' : signature ? 'fields' : 'generic';
    if (!named && isJoin(c)) {
      // 연결표: 두 곳 사이를 오가는 주민 — 무엇과 무엇을 잇는지를 이름에 적는다
      const [a, b] = [...new Set(c.fields.filter((f) => f.ref && f.ref.collection !== c.name).map((f) => f.ref!.collection))];
      sprite = 'villager';
      title = `${a}·${b} 연결`;
      basis = 'structure';
    }
    region = REGIONS.market;
  } else if (role === 'landmark') {
    sprite = 'townhall';
    title = '시청';
    region = REGIONS.plaza;
    basis = 'structure';
  } else {
    const refsIn = schema.collections.reduce((n, o) => n + (o.name !== c.name ? o.fields.filter((f) => f.ref?.collection === c.name).length : 0), 0);
    const named = PLACE_GROUPS.find((p) => p.re.test(c.name));
    const structural = WALKER_GROUPS.some((w) => w.re.test(c.name)) ? EVENT_PLACE : isLookup(c, schema) ? LOOKUP_PLACE : null;
    const g = named ?? structural ?? signature?.place ?? (refsIn >= 3 ? HUB_PLACE : DEFAULT_PLACE);
    basis = named ? 'name' : structural ? 'structure' : signature ? 'fields' : g === HUB_PLACE ? 'structure' : 'generic';
    sprite = g.sprite;
    title = g.title;
    region = g.region;
  }

  const fields = c.fields.filter((f) => f.name !== c.primaryKey);
  // 이름표: name·title 같은 이름이 먼저, 없으면 first_name·album_title 처럼 _name·_title 로 끝나는 칸
  const labelCandidate =
    fields.find((f) => !f.sensitive && f.type === 'string' && LABEL_RE.test(f.name)) ??
    fields.find((f) => !f.sensitive && f.type === 'string' && /(^|_)(name|title)$/i.test(f.name));
  // 색깔(tint)은 '상태'를 뜻하는 범주형 필드가 우선 차지한다(값이 하나뿐인 필드는 구분할 것이 없어 제외)
  const enumish = fields.filter((f) => f.type === 'string' && !f.ref && !f.sensitive && (f.enumValues?.length ?? 0) > 1);
  // 상태(status·state·phase…)가 종류(kind·type)보다 먼저: 색은 '지금 어떤 상태인가' 를 보여줄 때 가장 쓸모 있다
  const tintField = (enumish.find((f) => /(^|_)(status|state|phase|stage|health|condition)$/i.test(f.name)) ?? enumish.find((f) => ENUM_RE.test(f.name)) ?? enumish.find((f) => f.enumValues!.length <= 8))?.name;
  // 1) 참조 필드: NPC는 경로, 건물은 숨김
  const refs = fields.filter((f) => f.ref);
  if (role === 'npc') {
    // 연결표는 복합 기본키의 첫 칸이 곧 참조인 경우가 많다(예: playlist_track.playlist_id): 경로에는 쓸 수 있다
    const pkRef = c.fields.find((f) => f.name === c.primaryKey && f.ref);
    if (pkRef) refs.unshift(pkRef);
    const toPlace = (f: FieldSchema) => roles.get(f.ref!.collection) !== 'npc';
    const people = refs.find((f) => toPlace(f) && /(customer|user|member|patient|student|person|owner|sender|author|client|account|from)/i.test(f.name + f.ref!.collection));
    const others = refs.filter((f) => f !== people && toPlace(f));
    if (people && others.length) {
      route.from = people.name;
      route.to = others[0].name;
    } else if (others.length >= 2) {
      route.from = others[0].name;
      route.to = others[1].name;
    } else if (others.length === 1 || people) {
      route.to = (others[0] ?? people)!.name;
    }
    for (const r of refs) if (r.name !== route.from && r.name !== route.to) hidden.push(r.name);
  } else {
    for (const r of refs) hidden.push(r.name);
  }

  for (const f of fields) {
    if (f.ref) continue;
    if (f.sensitive) {
      hidden.push(f.name);
      continue;
    }
    const n = f.name;
    if (!labelField && n === labelCandidate?.name) {
      labelField = n;
      continue;
    }
    if (f.type === 'timestamp') {
      if (role === 'npc' && !recency && CREATED_RE.test(n)) recency = { field: n, seconds: 60 };
      else hidden.push(n);
      continue;
    }
    if (isNumeric(f)) {
      if (role !== 'npc' && STACK_RE.test(n) && take('stack')) channels.push(quant('stack', f));
      else if (FIRE_RE.test(n) && take('fire')) channels.push(quant('fire', f));
      else if (SPEED_RE.test(n) && take('speed')) channels.push(quant('speed', f));
      else if (MONEY_RE.test(n) && take('sign')) channels.push({ channel: 'sign', field: n, format: 'currency' });
      else if (CROWD_RE.test(n) && role !== 'npc' && take('crowd')) channels.push(quant('crowd', f));
      else if (role !== 'npc' && take('size')) channels.push(quant('size', f));
      else hidden.push(n);
      continue;
    }
    if (f.type === 'boolean') {
      // 의미가 분명한 on/off 필드(active, enabled …)만 건물에서 편집 가능
      if (LIT_RE.test(n) && take('lit')) channels.push(role === 'npc' ? { channel: 'lit', field: n, readOnly: true } : { channel: 'lit', field: n });
      else if (FOG_RE.test(n) && take('fog')) channels.push({ channel: 'fog', field: n });
      else if (take('lit')) channels.push({ channel: 'lit', field: n, readOnly: true });
      else hidden.push(n);
      continue;
    }
    if (f.type === 'string' && f.enumValues?.length && (ENUM_RE.test(n) || f.enumValues.length <= 8) && !(SIGN_RE.test(n) && n !== tintField)) {
      let consumed = false;
      if (n === tintField && take('tint')) {
        const { map, fallback } = assignColors(f.enumValues);
        channels.push({ channel: 'tint', field: n, map, fallback, glyphs: assignGlyphs(Object.keys(map)), readOnly: true });
        consumed = true;
      }
      // 사전 순서(우선순위)대로 고른다: exited 가 paused 보다 '꺼짐'의 대표값으로 적합
      const pickIn = (vocab: string[]) => vocab.flatMap((w) => f.enumValues!.filter((v) => v.toLowerCase() === w));
      const running = pickIn(RUNNING_VALUES);
      const stopped = pickIn(STOPPED_VALUES);
      if (role !== 'npc' && running.length && !used.has('lit') && take('lit')) {
        channels.push({
          channel: 'lit',
          field: n,
          when: running,
          ...(stopped.length ? { writeTrue: running[0], writeFalse: stopped[0] } : { readOnly: true }),
        });
        consumed = true;
      }
      if (!consumed) hidden.push(n);
      continue;
    }
    if (f.type === 'string' && SIGN_RE.test(n) && take('sign')) {
      channels.push({ channel: 'sign', field: n, format: 'plain' });
      continue;
    }
    hidden.push(n);
  }

  // 시스템이 쓰기를 받지 않는 필드는 편집을 열지 않는다(그러면 그 필드로는 행동도 생기지 않는다)
  const systemReadOnly = new Set(c.fields.filter((f) => f.readOnly).map((f) => f.name));
  for (const b of channels) if (systemReadOnly.has(b.field) && b.channel !== 'sign') (b as { readOnly?: boolean }).readOnly = true;

  // NPC 가 여러 행을 다룰 때 너무 많아지지 않게
  const maxEntities = role === 'npc' ? 40 : 80;
  const kind: EntityKind = {
    id,
    title,
    collection: c.name,
    archetype: role,
    sprite,
    spritePrompt: '',
    region: region.id,
    ...(labelField ? { labelField } : {}),
    metaphorBasis: basis,
    ...(route.from || route.to ? { route } : {}),
    ...(recency ? { recency } : {}),
    channels,
    hidden: [...new Set(hidden)],
    maxEntities,
  };

  // 2) 행동(affordance): 편집 가능한 채널마다 사람이 이해할 수 있는 동작
  const affordances: Affordance[] = [];
  for (const b of channels) {
    if (b.channel === 'lit' && !b.readOnly) {
      const isState = !!b.when;
      affordances.push({
        id: `${id}_off`,
        title: isState ? `${title} 멈추기` : `${title} 문 잠그기`,
        description: isState ? `${b.field} 를 ${String(b.writeFalse)} 로 바꿉니다` : `${b.field} 를 false 로 바꿔 이용을 중지합니다`,
        entityKind: id,
        edits: [{ channel: 'lit', value: false }],
        risk: isState ? 'high' : 'medium',
      });
      affordances.push({
        id: `${id}_on`,
        title: isState ? `${title} 가동하기` : `${title} 문 열기`,
        description: isState ? `${b.field} 를 ${String(b.writeTrue)} 로 바꿉니다` : `${b.field} 를 true 로 바꿔 이용을 재개합니다`,
        entityKind: id,
        edits: [{ channel: 'lit', value: true }],
        risk: 'medium',
        inverseOf: `${id}_off`,
      });
    }
    if (b.channel === 'stack' && !b.readOnly && RESTOCK_RE.test(b.field)) {
      const per = (b.scale.domain[1] - b.scale.domain[0]) / (b.scale.range[1] - b.scale.range[0]);
      affordances.push({
        id: `${id}_restock`,
        title: /replica/i.test(b.field) ? `${title} 복제본 ${per * 2}개 늘리기` : `${title}에 상자 2개 채우기`,
        description: `${b.field} 를 ${per * 2}만큼 늘립니다`,
        entityKind: id,
        edits: [{ channel: 'stack', delta: 2 }],
        risk: 'low',
      });
    }
    if (b.channel === 'tint' && role === 'npc') {
      const cancelValue = Object.keys(b.map).find((v) => CANCEL_VALUES.includes(v.toLowerCase()));
      if (cancelValue && !systemReadOnly.has(b.field)) {
        delete b.readOnly;
        affordances.push({
          id: `${id}_cancel`,
          title: `${title} 돌려보내기(${cancelValue})`,
          description: `${b.field} 를 ${cancelValue} 로 바꿉니다`,
          entityKind: id,
          edits: [{ channel: 'tint', value: b.map[cancelValue] }],
          risk: 'medium',
        });
      }
    }
  }
  kind.spritePrompt = spritePrompt(kind);
  notes.push(
    role === 'npc'
      ? `${c.name}: 다른 컬렉션을 참조하고 시간/상태가 있어 움직이는 ${title}(NPC)로 표현`
      : role === 'landmark'
        ? `${c.name}: 지표성 단일 행이라 광장의 ${title}로 표현`
        : `${c.name}: 다른 데이터가 가리키는 장소라 ${REGIONS[region.id as keyof typeof REGIONS]?.title ?? region.title}의 ${title}로 표현`,
  );
  return { kind, affordances, notes };
}

const SPRITE_PROMPTS: Record<string, string> = {
  house: 'cozy small house with red roof',
  warehouse: 'wooden warehouse with big doors',
  shop: 'small shop with striped awning',
  bank: 'stone bank building with columns',
  factory: 'brick factory with chimney',
  townhall: 'town hall with clock tower',
  library: 'library with arched windows',
  clinic: 'clinic with a red cross sign',
  school: 'schoolhouse with a bell',
  tower: 'observation tower with antenna',
  post: 'post office with mailbox',
  farm: 'farmhouse with fields',
  merchant: 'merchant carrying a sack',
  villager: 'villager walking',
  courier: 'courier with a parcel',
  robot: 'small helper robot',
};

function spritePrompt(k: EntityKind): string {
  return `${SPRITE_PROMPTS[k.sprite] ?? k.sprite}, top-down 3/4 view, 16-bit pixel art, warm palette`;
}

export function compileHeuristic(schema: SystemSchema): WorldGrammar {
  const roles = new Map(schema.collections.map((c) => [c.name, classify(c, schema)] as const));
  const plans = schema.collections.map((c) => planKind(c, roles.get(c.name)!, schema, roles));

  // 같은 제목이 겹치면 컬렉션 이름으로 구분
  const titleCount = new Map<string, number>();
  for (const p of plans) titleCount.set(p.kind.title, (titleCount.get(p.kind.title) ?? 0) + 1);
  for (const p of plans) {
    if ((titleCount.get(p.kind.title) ?? 0) > 1) {
      const t = `${p.kind.title}(${p.kind.collection})`;
      for (const a of p.affordances) a.title = a.title.replace(p.kind.title, t);
      p.kind.title = t;
    }
  }

  const kinds = plans.map((p) => p.kind);
  const usedRegions = new Set(kinds.filter((k) => k.archetype !== 'npc').map((k) => k.region));
  if (!usedRegions.size) usedRegions.add('market');
  let regions: Region[] = REGION_ORDER.filter((r) => usedRegions.has(r)).map((r) => REGIONS[r as keyof typeof REGIONS]);
  for (const k of kinds) if (k.archetype === 'npc') k.region = regions[0].id;

  // 여러 시스템을 한 세계로 묶었으면 시스템마다 따로 구역을 둔다(어느 건물이 어느 시스템인지 한눈에)
  const systemOf = new Map(schema.collections.map((c) => [c.name, c.system] as const));
  const systems = [...new Set(schema.collections.map((c) => c.system).filter((s): s is string => !!s))];
  if (systems.length > 1) {
    const out: Region[] = [];
    for (const sys of systems) {
      const mine = kinds.filter((k) => systemOf.get(k.collection) === sys);
      const used = new Set(mine.filter((k) => k.archetype !== 'npc').map((k) => k.region));
      if (!used.size) used.add(mine[0]?.region ?? 'market');
      const regs = REGION_ORDER.filter((r) => used.has(r)).map((r) => REGIONS[r as keyof typeof REGIONS]).map((r) => ({ ...r, id: `${sys}_${r.id}`, title: `${sys} · ${r.title}` }));
      for (const k of mine) k.region = k.archetype === 'npc' ? regs[0].id : `${sys}_${k.region}`;
      out.push(...regs);
    }
    regions = out;
  }

  const draft: WorldGrammar = {
    version: 1,
    system: schema.system,
    title: `${schema.system} 마을`,
    theme: 'town',
    generatedBy: 'heuristic',
    regions,
    kinds,
    invariants: [],
    affordances: plans.flatMap((p) => p.affordances),
    notes: plans.flatMap((p) => p.notes),
  };
  const mined: Invariant[] = [...mineSchemaInvariants(schema), ...mineHeuristicInvariants(schema)];
  const seen = new Set<string>();
  draft.invariants = mined
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .map((i) => ({ ...i, anomaly: chooseAnomaly(i, draft, schema) }));
  return draft;
}
