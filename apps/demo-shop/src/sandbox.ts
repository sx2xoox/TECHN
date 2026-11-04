import { PGlite } from '@electric-sql/pglite';
import type { Hypothesis } from '@isomorph/core';
import { Shop } from './shop.ts';
import { Traffic } from './traffic.ts';

/**
 * 실제 코드 샌드박스: 살아있는 쇼핑몰 DB 를 통째로 복제해, 진짜 Shop/Traffic 코드를
 * 가설 조건으로 돌린다. 가설 시뮬레이터(학습된 모델)의 예측을 검증하는 '정답지' 역할.
 * (데모 쇼핑몰 전용 — 임의의 시스템은 자기 코드를 이렇게 복제해 돌릴 수 없으므로 모델이 필요하다)
 */
export interface SandboxOptions {
  /** 원본과 같은 손님 트래픽 */
  orderEveryMs: [number, number];
  restockEveryMs?: number;
  paymentFailureRate?: number;
  pollMs?: number;
}

export interface TrialResult {
  newViolation: boolean;
  firstMs: number | null;
  orders: number;
  finalNegative: number[];
}

export async function cloneDb(db: PGlite): Promise<Blob> {
  return (await db.dumpDataDir('none')) as Blob;
}

/** 가설 하나를 실제 코드로 한 번 돌린다(실시간). */
export async function runTrial(dump: Blob, h: Hypothesis, opts: SandboxOptions): Promise<TrialResult> {
  const db = await PGlite.create({ loadDataDir: dump });
  let rateFactor = 1;
  let failFactor = 1;
  let fixed = false;
  for (const ch of h.changes) {
    if (ch.kind === 'rate' && ch.collection === 'orders') rateFactor *= ch.factor;
    if (ch.kind === 'transition' && ch.collection === 'orders' && /fail/.test(ch.to)) failFactor *= ch.factor;
    if (ch.kind === 'atomic') fixed = true;
    if (ch.kind === 'set') {
      for (const [k, v] of Object.entries(ch.patch)) await db.query(`update ${ch.collection} set ${k} = $1 where id = $2`, [v, ch.pk]);
    }
    if (ch.kind === 'setAll') {
      for (const [k, v] of Object.entries(ch.patch)) await db.query(`update ${ch.collection} set ${k} = $1`, [v]);
    }
  }
  const shop = new Shop(db, { fixed, paymentFailureRate: (opts.paymentFailureRate ?? 0.05) * failFactor });
  const traffic = new Traffic(shop, {
    orderEveryMs: [opts.orderEveryMs[0] / rateFactor, opts.orderEveryMs[1] / rateFactor],
    restockEveryMs: opts.restockEveryMs ?? 7000,
    firstFlashSaleMs: -1,
    flashSaleEveryMs: 0,
  });
  const initialNeg = new Set((await db.query<{ id: number }>('select id from products where stock < 0')).rows.map((r) => r.id));
  const ordersBefore = (await db.query<{ n: number }>('select count(*)::int as n from orders')).rows[0].n;
  const started = Date.now();
  let firstMs: number | null = null;
  const timers: NodeJS.Timeout[] = [];
  for (const ch of h.changes) {
    if (ch.kind !== 'burst') continue;
    for (let k = 0; k < ch.count; k++) {
      const at = ch.atMs + (ch.count > 1 ? (k / (ch.count - 1)) * ch.spreadMs : 0);
      timers.push(setTimeout(() => void shop.placeOrder(1 + (k % 6), Number(ch.target)).catch(() => {}), at));
    }
  }
  traffic.start();
  while (Date.now() - started < h.horizonMs) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 200));
    if (firstMs !== null) continue;
    const neg = (await db.query<{ id: number }>('select id from products where stock < 0')).rows.map((r) => r.id).filter((id) => !initialNeg.has(id));
    if (neg.length) firstMs = Date.now() - started;
  }
  traffic.stop();
  for (const t of timers) clearTimeout(t);
  await new Promise((r) => setTimeout(r, 1200)); // 결제 대기 중인 요청이 끝나도록
  const finalNegative = (await db.query<{ id: number }>('select id from products where stock < 0')).rows.map((r) => r.id).filter((id) => !initialNeg.has(id));
  const orders = (await db.query<{ n: number }>('select count(*)::int as n from orders')).rows[0].n - ordersBefore;
  await db.close();
  return { newViolation: firstMs !== null, firstMs, orders, finalNegative };
}
