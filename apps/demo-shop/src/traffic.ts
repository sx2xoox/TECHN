import type { Shop } from './shop.ts';

/**
 * 손님 트래픽 시뮬레이터.
 * - 평소: 0.3~0.8초마다 무작위 주문
 * - 직원: 재고가 0~3 인 상품을 가끔 채운다(음수 재고는 '이상한 숫자'라 손대지 않는다)
 * - 반짝 세일: 주기적으로 '마지막 2개' 상품에 동시 주문 4건 → 경쟁 조건 발생
 */
export interface TrafficOptions {
  orderEveryMs?: [number, number];
  flashSaleEveryMs?: number;
  firstFlashSaleMs?: number;
  restockEveryMs?: number;
  log?: (msg: string) => void;
}

export class Traffic {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  flashSales = 0;

  constructor(private shop: Shop, private opts: TrafficOptions = {}) {}

  private async products() {
    return (await this.shop.db.query<{ id: number; stock: number; active: boolean }>('select id, stock, active from products order by id')).rows;
  }

  private async customers() {
    return (await this.shop.db.query<{ id: number }>('select id from customers order by id')).rows.map((r) => r.id);
  }

  async flashSale(productId?: number) {
    const products = (await this.products()).filter((p) => p.active && p.stock >= 0);
    const target = productId ? products.find((p) => p.id === productId) : products[Math.floor(Math.random() * products.length)];
    if (!target) return null;
    await this.shop.db.query('update products set stock = 2 where id = $1', [target.id]);
    const customers = await this.customers();
    this.flashSales++;
    this.opts.log?.(`⚡ 반짝 세일: 상품 #${target.id} 마지막 2개에 동시 주문 4건`);
    const orders = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        await new Promise((r) => setTimeout(r, i * 8));
        return this.shop.placeOrder(customers[i % customers.length], target.id);
      }),
    );
    return { productId: target.id, orders };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const [lo, hi] = this.opts.orderEveryMs ?? [300, 800];
    const loop = async () => {
      if (!this.running) return;
      try {
        const products = await this.products();
        const customers = await this.customers();
        const p = products[Math.floor(Math.random() * products.length)];
        const c = customers[Math.floor(Math.random() * customers.length)];
        if (p && c) void this.shop.placeOrder(c, p.id).catch((e) => this.opts.log?.(`order error: ${e}`));
      } catch (e) {
        this.opts.log?.(`traffic error: ${e}`);
      }
      this.timers.push(setTimeout(loop, lo + Math.random() * (hi - lo)));
    };
    loop();
    const restock = async () => {
      if (!this.running) return;
      const low = (await this.products()).filter((p) => p.stock >= 0 && p.stock <= 3);
      const p = low[Math.floor(Math.random() * low.length)];
      if (p) await this.shop.restock(p.id, 5 + Math.floor(Math.random() * 10));
    };
    this.timers.push(setInterval(() => void restock(), this.opts.restockEveryMs ?? 7000));
    this.timers.push(setInterval(() => void this.shop.writeStats(), 1000));
    if ((this.opts.flashSaleEveryMs ?? 45_000) > 0) {
      this.timers.push(setTimeout(() => void this.flashSale(), this.opts.firstFlashSaleMs ?? 15_000));
      this.timers.push(setInterval(() => void this.flashSale(), this.opts.flashSaleEveryMs ?? 45_000));
    }
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
