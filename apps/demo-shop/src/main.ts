import { startShop } from './index.ts';

const httpPort = Number(process.env.SHOP_HTTP_PORT ?? 4100);
const pgPort = Number(process.env.SHOP_PG_PORT ?? 5433);

const handle = await startShop({
  httpPort,
  pgPort,
  traffic: {
    firstFlashSaleMs: Number(process.env.FLASH_FIRST_MS ?? 15_000),
    flashSaleEveryMs: Number(process.env.FLASH_EVERY_MS ?? 45_000),
  },
  shop: { fixed: process.env.SHOP_FIXED === '1' },
  log: (m) => console.log(`[shop] ${m}`),
});
console.log(`[shop] HTTP API   ${handle.httpUrl}/api/products`);
console.log(`[shop] Postgres   ${handle.pgUrl}`);

const shutdown = async () => {
  await handle.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
