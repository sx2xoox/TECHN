import type { PGlite } from '@electric-sql/pglite';

/**
 * 쇼핑몰 비즈니스 로직 — 일부러 심어 둔 버그가 있다.
 *
 *   1) 재고 확인(SELECT)            ← 여러 요청이 동시에 "1개 남음"을 본다
 *   2) 결제 대기(수백 ms)
 *   3) 재고 차감(UPDATE stock - n)  ← 확인 없이 차감 → 음수 재고
 *
 * fixed=true 이면 3)을 조건부 원자 갱신으로 바꿔 버그를 고친다.
 */
export interface ShopOptions {
  fixed?: boolean;
  paymentMs?: [number, number];
  paymentFailureRate?: number;
  random?: () => number;
}

export type OrderResult = { id: number | null; status: 'paid' | 'failed' | 'rejected'; reason?: string };

export class Shop {
  fixed: boolean;
  private requests: { t: number; ms: number; error: boolean }[] = [];
  private rand: () => number;

  constructor(readonly db: PGlite, private opts: ShopOptions = {}) {
    this.fixed = !!opts.fixed;
    this.rand = opts.random ?? Math.random;
  }

  private record(started: number, error: boolean) {
    const now = Date.now();
    this.requests.push({ t: now, ms: now - started, error });
    const cutoff = now - 60_000;
    while (this.requests.length && this.requests[0].t < cutoff) this.requests.shift();
  }

  async placeOrder(customerId: number, productId: number, quantity = 1): Promise<OrderResult> {
    const started = Date.now();
    const { rows } = await this.db.query<{ stock: number; active: boolean }>('select stock, active from products where id = $1', [productId]);
    const p = rows[0];
    const insert = async (status: string) =>
      (await this.db.query<{ id: number }>('insert into orders (customer_id, product_id, quantity, status) values ($1, $2, $3, $4) returning id', [customerId, productId, quantity, status])).rows[0].id;
    if (!p) {
      const id = await insert('failed');
      this.record(started, true);
      return { id, status: 'failed', reason: 'no such product' };
    }
    if (!p.active) {
      const id = await insert('rejected');
      this.record(started, false);
      return { id, status: 'rejected', reason: 'sales stopped' };
    }
    if (p.stock < quantity) {
      const id = await insert('failed');
      this.record(started, false);
      return { id, status: 'failed', reason: 'out of stock' };
    }
    const id = await insert('pending');
    const [lo, hi] = this.opts.paymentMs ?? [250, 900];
    await new Promise((r) => setTimeout(r, lo + this.rand() * (hi - lo)));
    if (this.rand() < (this.opts.paymentFailureRate ?? 0.05)) {
      await this.db.query("update orders set status = 'failed', updated_at = now() where id = $1", [id]);
      this.record(started, true);
      return { id, status: 'failed', reason: 'payment declined' };
    }
    if (this.fixed) {
      const r = await this.db.query('update products set stock = stock - $2 where id = $1 and stock >= $2', [productId, quantity]);
      if ((r.affectedRows ?? 0) === 0) {
        await this.db.query("update orders set status = 'failed', updated_at = now() where id = $1", [id]);
        this.record(started, false);
        return { id, status: 'failed', reason: 'out of stock (atomic check)' };
      }
    } else {
      // BUG: 1)에서 본 재고를 다시 확인하지 않는다 (check-then-act race)
      await this.db.query('update products set stock = stock - $2 where id = $1', [productId, quantity]);
    }
    await this.db.query("update orders set status = 'paid', updated_at = now() where id = $1", [id]);
    this.record(started, false);
    return { id, status: 'paid' };
  }

  async restock(productId: number, amount: number) {
    await this.db.query('update products set stock = stock + $2 where id = $1', [productId, amount]);
  }

  async writeStats() {
    const n = this.requests.length;
    const avg = n ? this.requests.reduce((s, r) => s + r.ms, 0) / n : 0;
    const errors = this.requests.filter((r) => r.error).length;
    await this.db.query('update shop_stats set requests_per_min = $1, avg_latency_ms = $2, error_count = $3, updated_at = now() where id = 1', [n, Math.round(avg), errors]);
  }
}
