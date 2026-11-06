import { attachStats, markSensitive, observe, type Row, type Snapshot, type SystemSchema, type WorldGrammar, type WorldState } from '@isomorph/core';
import { compileHeuristic } from '@isomorph/compiler';
import type { RcaInsight, RcaLogEntry } from './study-rca.ts';

/**
 * 사용자 실험용 과제 생성기.
 * 같은 쇼핑몰 데이터에 '규칙 위반 하나'(또는 없음)를 심은 정적 장면을 만든다.
 * 같은 과제를 세계(ISOMORPH) 와 표(대시보드) 로 똑같이 보여줄 수 있도록 원본 행과 세계를 함께 준다.
 */

export const STUDY_ANOMALIES = ['negative_stock', 'orphan_order', 'timewarp_order', 'duplicate_product', 'none'] as const;
export type StudyAnomaly = (typeof STUDY_ANOMALIES)[number];

/** 참가자에게 두 조건 모두에서 똑같이 보여주는 규칙 카드 */
export const STUDY_RULES: { id: StudyAnomaly; text: string }[] = [
  { id: 'negative_stock', text: '상품의 재고(stock)는 0보다 작을 수 없다' },
  { id: 'orphan_order', text: '주문(orders)이 가리키는 상품(product_id)은 실제로 있어야 한다' },
  { id: 'timewarp_order', text: '주문의 수정 시각(updated_at)은 생성 시각(created_at)보다 이를 수 없다' },
  { id: 'duplicate_product', text: '같은 번호(id)의 상품이 두 개 있을 수 없다' },
];

export const STUDY_CHOICES: { id: StudyAnomaly; text: string }[] = [
  ...STUDY_RULES.map((r) => ({ id: r.id, text: r.text })),
  { id: 'none', text: '어긴 곳이 없다' },
];

export interface StudyTrial {
  /** 참가자 안에서 몇 번째 과제인가(연습 제외, 0부터) */
  index: number;
  practice: boolean;
  condition: string;
  /** 위반 찾기: 심은 위반 종류(StudyAnomaly), 근본 원인 찾기: 원인 종류(RcaKind) */
  anomaly: string;
  /** 정답 행: `${collection}:${pk}` (어긴 곳이 없으면 null) */
  target: string | null;
  seed: number;
  snapshot: Snapshot;
  world: WorldState;
  /** 근본 원인 찾기 과제만: 변경 기록(모든 조건), 엔진이 계산한 살펴보기(세계·표+위반 강조), 장애가 드러난 곳 */
  task?: 'rca';
  log?: RcaLogEntry[];
  insights?: Record<string, RcaInsight>;
  symptom?: string;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function studySchema(): SystemSchema {
  return markSensitive({
    system: 'study-shop',
    // 'http': 원본이 제약을 강제하지 않는 시스템으로 둔다(그래야 중복·없는 참조가 존재할 수 있다)
    source: 'http',
    constraints: [],
    collections: [
      {
        name: 'customers',
        primaryKey: 'id',
        fields: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'name', type: 'string', nullable: false },
          { name: 'tier', type: 'string', nullable: false, enumValues: ['bronze', 'silver', 'gold'] },
        ],
      },
      {
        name: 'products',
        primaryKey: 'id',
        fields: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'name', type: 'string', nullable: false },
          { name: 'price', type: 'integer', nullable: false },
          { name: 'stock', type: 'integer', nullable: false },
          { name: 'active', type: 'boolean', nullable: false },
        ],
      },
      {
        name: 'orders',
        primaryKey: 'id',
        fields: [
          { name: 'id', type: 'integer', nullable: false },
          { name: 'customer_id', type: 'integer', nullable: false, ref: { collection: 'customers', field: 'id' }, refEnforced: true },
          { name: 'product_id', type: 'integer', nullable: false, ref: { collection: 'products', field: 'id' }, refEnforced: false },
          { name: 'quantity', type: 'integer', nullable: false },
          { name: 'status', type: 'string', nullable: false, enumValues: ['pending', 'paid', 'failed'] },
          { name: 'created_at', type: 'timestamp', nullable: false },
          { name: 'updated_at', type: 'timestamp', nullable: false },
        ],
      },
    ],
  });
}

const PRODUCT_NAMES = ['사과', '배', '귤', '수박', '딸기', '포도', '복숭아', '감', '자두', '참외', '키위', '망고', '레몬', '체리'];
const CUSTOMER_NAMES = ['김민수', '이지영', '박서준', '최유나', '정하늘', '강도윤', '조수아', '윤시우', '장예린', '임건우', '한서연', '오지호', '서다은', '신민재'];

/** 어긴 곳이 없는 기본 장면(시드마다 값이 다르다) */
export function baseScene(seed: number, ts = Date.now()): Snapshot {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const nProducts = 10 + Math.floor(r() * 4);
  const nCustomers = 8 + Math.floor(r() * 4);
  const products: Row[] = Array.from({ length: nProducts }, (_, i) => ({ id: i + 1, name: PRODUCT_NAMES[i], price: 500 + Math.floor(r() * 60) * 100, stock: 1 + Math.floor(r() * 40), active: r() > 0.15 }));
  const customers: Row[] = Array.from({ length: nCustomers }, (_, i) => ({ id: i + 1, name: CUSTOMER_NAMES[i], tier: pick(['bronze', 'silver', 'gold']) }));
  const nOrders = 14 + Math.floor(r() * 8);
  const orders: Row[] = Array.from({ length: nOrders }, (_, i) => {
    const created = ts - Math.floor(r() * 45_000) - 2000;
    const updated = created + Math.floor(r() * 1500);
    return { id: 100 + i, customer_id: 1 + Math.floor(r() * nCustomers), product_id: 1 + Math.floor(r() * nProducts), quantity: 1 + Math.floor(r() * 3), status: pick(['pending', 'paid', 'paid', 'paid', 'failed']), created_at: new Date(created).toISOString(), updated_at: new Date(updated).toISOString() };
  });
  return { ts, collections: { customers, products, orders } };
}

/** 장면에 규칙 위반 하나를 심고, 정답 행을 돌려준다 */
export function injectAnomaly(scene: Snapshot, anomaly: StudyAnomaly, seed: number): { snapshot: Snapshot; target: string | null } {
  const r = rng(seed ^ 0x9e3779b9);
  const s: Snapshot = { ts: scene.ts, collections: Object.fromEntries(Object.entries(scene.collections).map(([k, rows]) => [k, rows.map((x) => ({ ...x }))])) };
  const products = s.collections.products;
  const orders = s.collections.orders;
  const anyOf = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  switch (anomaly) {
    case 'negative_stock': {
      const p = anyOf(products);
      p.stock = -(1 + Math.floor(r() * 3));
      return { snapshot: s, target: `products:${p.id}` };
    }
    case 'orphan_order': {
      const o = anyOf(orders);
      o.product_id = 90 + Math.floor(r() * 9);
      return { snapshot: s, target: `orders:${o.id}` };
    }
    case 'timewarp_order': {
      const o = anyOf(orders);
      o.updated_at = new Date(Date.parse(String(o.created_at)) - (3000 + Math.floor(r() * 20_000))).toISOString();
      return { snapshot: s, target: `orders:${o.id}` };
    }
    case 'duplicate_product': {
      const p = anyOf(products);
      products.splice(products.indexOf(p) + 1 + Math.floor(r() * 3), 0, { ...p, stock: Math.max(0, Number(p.stock) + 1 + Math.floor(r() * 5)) });
      return { snapshot: s, target: `products:${p.id}` };
    }
    case 'none':
      return { snapshot: s, target: null };
  }
}

/** 실험 전체에서 쓰는 하나의 세계 문법(모든 과제가 같은 모습 규칙을 쓴다) */
export function studyGrammar(): { schema: SystemSchema; grammar: WorldGrammar } {
  const base = studySchema();
  const schema = attachStats(base, baseScene(1));
  const grammar = compileHeuristic(schema);
  // 실험의 규칙 카드에 있는 법칙만 남기고, 모두 '확정' 으로 둔다(두 조건이 같은 규칙을 갖도록)
  grammar.invariants = grammar.invariants
    .filter((i) => ['nonneg_products_stock', 'ref_orders_product_id', 'order_orders_created_at_updated_at', 'unique_products_id'].includes(i.id))
    .map((i) => ({ ...i, status: 'confirmed' as const }));
  return { schema, grammar };
}

export function makeTrial(opts: { index: number; practice: boolean; condition: string; anomaly: StudyAnomaly; seed: number; grammar: WorldGrammar; schema: SystemSchema; ts?: number }): StudyTrial {
  const { snapshot, target } = injectAnomaly(baseScene(opts.seed, opts.ts), opts.anomaly, opts.seed);
  return { index: opts.index, practice: opts.practice, condition: opts.condition, anomaly: opts.anomaly, target, seed: opts.seed, snapshot, world: observe(snapshot, opts.grammar, opts.schema) };
}

/**
 * 과제 배정: 조건 순서와 '어떤 위반을 어떤 조건에서 보나' 를 참가자마다 돌려 맞춘다(라틴 방진).
 * 각 조건은 모든 위반 종류를 같은 수만큼 본다.
 */
export function planTrials(participant: number, conditions: string[], perCondition: number): { condition: string; anomaly: StudyAnomaly }[] {
  const kinds = STUDY_ANOMALIES;
  const blocks = conditions.map((_, i) => conditions[(i + participant) % conditions.length]);
  const out: { condition: string; anomaly: StudyAnomaly }[] = [];
  blocks.forEach((condition, b) => {
    for (let k = 0; k < perCondition; k++) out.push({ condition, anomaly: kinds[(k + b + participant) % kinds.length] });
  });
  return out;
}
