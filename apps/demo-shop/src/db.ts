import { PGlite } from '@electric-sql/pglite';

/**
 * 데모 쇼핑몰 DB (PGlite = WASM PostgreSQL).
 * 주의: products.stock 에 CHECK 제약이 '없다'. 그래서 경쟁 조건 버그가 음수 재고를 만들 수 있다.
 * orders.product_id 에도 외래키가 없다(이름으로만 참조) — ISOMORPH 가 참조 법칙을 추정해야 한다.
 */
export const SCHEMA_SQL = `
create type order_status as enum ('pending', 'paid', 'failed', 'rejected', 'cancelled');

create table customers (
  id serial primary key,
  name text not null,
  email text,
  tier text not null default 'bronze',
  created_at timestamptz not null default now()
);

create table products (
  id serial primary key,
  name text not null,
  price integer not null check (price >= 0),
  stock integer not null,
  active boolean not null default true
);

create table orders (
  id serial primary key,
  customer_id integer not null references customers(id),
  product_id integer not null,
  quantity integer not null default 1,
  status order_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shop_stats (
  id integer primary key,
  requests_per_min integer not null,
  avg_latency_ms double precision not null,
  error_count integer not null,
  updated_at timestamptz not null default now()
);
`;

const CUSTOMERS: [string, string, string][] = [
  ['김민수', 'minsu@example.com', 'gold'],
  ['이지영', 'jiyoung@example.com', 'silver'],
  ['박서준', 'seojun@example.com', 'bronze'],
  ['최유나', 'yuna@example.com', 'bronze'],
  ['정하늘', 'haneul@example.com', 'silver'],
  ['한도윤', 'doyun@example.com', 'gold'],
];

const PRODUCTS: [string, number, number][] = [
  ['사과', 1200, 18],
  ['배', 2500, 12],
  ['귤', 800, 25],
  ['수박', 15000, 6],
  ['딸기', 6000, 9],
  ['포도', 7000, 14],
  ['복숭아', 3000, 10],
  ['한정판 굿즈', 39000, 4],
];

export async function createShopDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(SCHEMA_SQL);
  for (const [name, email, tier] of CUSTOMERS) {
    await db.query('insert into customers (name, email, tier) values ($1, $2, $3)', [name, email, tier]);
  }
  for (const [name, price, stock] of PRODUCTS) {
    await db.query('insert into products (name, price, stock) values ($1, $2, $3)', [name, price, stock]);
  }
  await db.query('insert into shop_stats (id, requests_per_min, avg_latency_ms, error_count) values (1, 0, 0, 0)');
  return db;
}
