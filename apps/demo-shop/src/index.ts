import http from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createShopDb } from './db.ts';
import { Shop, type ShopOptions } from './shop.ts';
import { Traffic, type TrafficOptions } from './traffic.ts';

export { createShopDb, SCHEMA_SQL } from './db.ts';
export { Shop } from './shop.ts';
export { Traffic } from './traffic.ts';

export interface ShopServerOptions {
  httpPort?: number;
  pgPort?: number;
  host?: string;
  traffic?: boolean | TrafficOptions;
  shop?: ShopOptions;
  log?: (msg: string) => void;
}

export interface ShopHandle {
  db: PGlite;
  shop: Shop;
  traffic: Traffic;
  httpUrl: string;
  pgUrl: string;
  stop(): Promise<void>;
}

const WRITABLE: Record<string, string[]> = {
  products: ['active', 'stock', 'price'],
  orders: ['status'],
  customers: ['tier'],
};

const LISTS: Record<string, string> = {
  customers: 'select * from customers order by id',
  products: 'select * from products order by id',
  orders: 'select * from (select * from orders order by id desc limit 200) o order by id',
  shop_stats: 'select * from shop_stats order by id',
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** 쇼핑몰 = HTTP API(:4100) + PostgreSQL 와이어 프로토콜(:5433) + 손님 트래픽 */
export async function startShop(opts: ShopServerOptions = {}): Promise<ShopHandle> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? (() => {});
  const db = await createShopDb();
  const shop = new Shop(db, opts.shop);
  const traffic = new Traffic(shop, { log, ...(typeof opts.traffic === 'object' ? opts.traffic : {}) });

  const pgServer = new PGLiteSocketServer({ db, port: opts.pgPort ?? 5433, host, maxConnections: 8 });
  await pgServer.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });
      const [, name, id] = parts;
      if (req.method === 'GET' && name && LISTS[name] && !id) return json(res, 200, (await db.query(LISTS[name])).rows);
      if (req.method === 'PATCH' && name && WRITABLE[name] && id) {
        const body = await readBody(req);
        const keys = Object.keys(body).filter((k) => WRITABLE[name].includes(k));
        if (!keys.length) return json(res, 400, { error: `writable fields: ${WRITABLE[name].join(', ')}` });
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const r = await db.query(`update ${name} set ${sets} where id = $1 returning *`, [Number(id), ...keys.map((k) => body[k])]);
        if (!r.rows.length) return json(res, 404, { error: 'not found' });
        log(`PATCH ${name}/${id} ${JSON.stringify(body)}`);
        return json(res, 200, r.rows[0]);
      }
      if (req.method === 'POST' && name === 'orders') {
        const body = await readBody(req);
        return json(res, 201, await shop.placeOrder(Number(body.customer_id), Number(body.product_id), Number(body.quantity ?? 1)));
      }
      if (req.method === 'POST' && name === '_demo' && id === 'flash-sale') {
        const body = await readBody(req).catch((): Record<string, unknown> => ({}));
        return json(res, 200, await traffic.flashSale(body.product_id ? Number(body.product_id) : undefined));
      }
      if (req.method === 'POST' && name === '_demo' && id === 'fix') {
        const body = await readBody(req).catch((): Record<string, unknown> => ({}));
        shop.fixed = body.fixed !== false;
        log(`버그 수정 모드: ${shop.fixed}`);
        return json(res, 200, { fixed: shop.fixed });
      }
      if (req.method === 'GET' && name === '_demo' && id === 'status') {
        return json(res, 200, { fixed: shop.fixed, flashSales: traffic.flashSales });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.httpPort ?? 4100, host, resolve));
  const addr = server.address();
  const httpPort = typeof addr === 'object' && addr ? addr.port : opts.httpPort ?? 4100;
  if (opts.traffic !== false) traffic.start();

  return {
    db,
    shop,
    traffic,
    httpUrl: `http://${host}:${httpPort}`,
    pgUrl: `postgres://postgres@${host}:${opts.pgPort ?? 5433}/postgres`,
    async stop() {
      traffic.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pgServer.stop();
      await db.close();
    },
  };
}
