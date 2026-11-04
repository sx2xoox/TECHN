import type { Snapshot, SystemSchema, WorldGrammar } from '../src/index.ts';

export const shopSchema: SystemSchema = {
  system: 'demo-shop',
  source: 'postgres',
  constraints: [],
  collections: [
    {
      name: 'customers',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'email', type: 'string', nullable: true, sensitive: true },
        { name: 'tier', type: 'string', nullable: false, enumValues: ['bronze', 'silver', 'gold'] },
        { name: 'created_at', type: 'timestamp', nullable: false },
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
        { name: 'status', type: 'string', nullable: false, enumValues: ['pending', 'paid', 'failed', 'rejected', 'cancelled'] },
        { name: 'created_at', type: 'timestamp', nullable: false },
        { name: 'updated_at', type: 'timestamp', nullable: false },
      ],
    },
    {
      name: 'shop_stats',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'requests_per_min', type: 'integer', nullable: false },
        { name: 'avg_latency_ms', type: 'number', nullable: false },
        { name: 'error_count', type: 'integer', nullable: false },
        { name: 'updated_at', type: 'timestamp', nullable: false },
      ],
    },
  ],
};

export const shopGrammar: WorldGrammar = {
  version: 1,
  system: 'demo-shop',
  title: '데모 쇼핑몰 마을',
  theme: 'town',
  generatedBy: 'manual',
  notes: [],
  regions: [
    { id: 'market', title: '시장', theme: 'market' },
    { id: 'residential', title: '주택가', theme: 'residential' },
    { id: 'plaza', title: '광장', theme: 'plaza' },
  ],
  kinds: [
    {
      id: 'warehouse',
      title: '창고',
      collection: 'products',
      archetype: 'building',
      sprite: 'warehouse',
      spritePrompt: 'small wooden warehouse',
      region: 'market',
      labelField: 'name',
      channels: [
        { channel: 'stack', field: 'stock', scale: { domain: [0, 50], range: [0, 10] }, unit: '개' },
        { channel: 'lit', field: 'active' },
        { channel: 'sign', field: 'price', format: 'currency' },
      ],
      hidden: [],
    },
    {
      id: 'house',
      title: '집',
      collection: 'customers',
      archetype: 'building',
      sprite: 'house',
      spritePrompt: 'cozy house',
      region: 'residential',
      labelField: 'name',
      channels: [{ channel: 'tint', field: 'tier', map: { bronze: 'brown', silver: 'gray', gold: 'yellow' }, fallback: 'purple', readOnly: true }],
      hidden: ['email', 'created_at'],
    },
    {
      id: 'merchant',
      title: '상인',
      collection: 'orders',
      archetype: 'npc',
      sprite: 'merchant',
      spritePrompt: 'merchant',
      region: 'market',
      route: { from: 'customer_id', to: 'product_id' },
      recency: { field: 'created_at', seconds: 60 },
      channels: [
        { channel: 'tint', field: 'status', map: { pending: 'yellow', paid: 'green', failed: 'red', rejected: 'orange', cancelled: 'gray' }, fallback: 'purple' },
      ],
      hidden: ['quantity', 'updated_at'],
    },
    {
      id: 'townhall',
      title: '시청',
      collection: 'shop_stats',
      archetype: 'landmark',
      sprite: 'townhall',
      spritePrompt: 'town hall',
      region: 'plaza',
      channels: [
        { channel: 'crowd', field: 'requests_per_min', scale: { domain: [0, 600], range: [0, 12] } },
        { channel: 'fire', field: 'error_count', scale: { domain: [0, 20], range: [0, 5] } },
        { channel: 'speed', field: 'avg_latency_ms', scale: { domain: [0, 2000], range: [1, 0.2] }, unit: 'ms' },
      ],
      hidden: ['updated_at'],
    },
  ],
  invariants: [
    { id: 'stock_nonneg', collection: 'products', title: '재고는 음수가 될 수 없다', expr: { op: 'cmp', field: 'stock', cmp: '>=', value: 0 }, anomaly: 'ghost', source: 'heuristic', status: 'proposed', severity: 'critical' },
    { id: 'order_product', collection: 'orders', title: '주문의 상품이 존재해야 함', expr: { op: 'refExists', field: 'product_id', collection: 'products', target: 'id' }, anomaly: 'orphan', source: 'schema', status: 'confirmed', severity: 'warning' },
    { id: 'order_time', collection: 'orders', title: '수정 시각은 생성 시각보다 빠를 수 없다', expr: { op: 'cmpField', field: 'created_at', cmp: '<=', other: 'updated_at' }, anomaly: 'timewarp', source: 'heuristic', status: 'proposed', severity: 'warning' },
  ],
  affordances: [
    { id: 'lock', title: '창고 문 잠그기', description: '이 상품의 판매를 중지합니다', entityKind: 'warehouse', edits: [{ channel: 'lit', value: false }], risk: 'medium' },
    { id: 'unlock', title: '창고 문 열기', description: '판매를 재개합니다', entityKind: 'warehouse', edits: [{ channel: 'lit', value: true }], risk: 'medium', inverseOf: 'lock' },
    { id: 'restock', title: '상자 2개 채우기', description: '재고를 10개 늘립니다', entityKind: 'warehouse', edits: [{ channel: 'stack', delta: 2 }], risk: 'low' },
    { id: 'cancel', title: '주문 취소', description: '주문 상태를 cancelled 로 바꿉니다', entityKind: 'merchant', edits: [{ channel: 'tint', value: 'gray' }], risk: 'medium' },
  ],
};

export const NOW = 1_700_000_000_000;
const iso = (dt: number) => new Date(NOW - dt).toISOString();

export function shopSnapshot(over: Partial<{ stock: number; active: boolean }> = {}): Snapshot {
  return {
    ts: NOW,
    collections: {
      customers: [
        { id: 1, name: '민수', email: 'minsu@example.com', tier: 'gold', created_at: iso(100000) },
        { id: 2, name: '지영', email: 'jy@example.com', tier: 'bronze', created_at: iso(90000) },
      ],
      products: [
        { id: 1, name: '사과', price: 1200, stock: over.stock ?? 7, active: over.active ?? true },
        { id: 2, name: '배', price: 2500, stock: 30, active: true },
      ],
      orders: [
        { id: 10, customer_id: 1, product_id: 1, quantity: 1, status: 'pending', created_at: iso(5000), updated_at: iso(4000) },
        { id: 11, customer_id: 2, product_id: 2, quantity: 1, status: 'paid', created_at: iso(200000), updated_at: iso(1000) },
        { id: 12, customer_id: 2, product_id: 99, quantity: 1, status: 'pending', created_at: iso(3000), updated_at: iso(3000) },
      ],
      shop_stats: [{ id: 1, requests_per_min: 300, avg_latency_ms: 500, error_count: 2, updated_at: iso(0) }],
    },
  };
}
