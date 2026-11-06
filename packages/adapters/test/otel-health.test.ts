import { describe, expect, it } from 'vitest';
import { OtelAdapter, rpcPeer } from '../src/index.ts';

/**
 * 서비스 건강을 '평소' 와 견주기: 공개 RCA 벤치마크(RCAEval)의 실제 트레이스에서 찾은 빈틈을 메운 것들의 회귀 시험.
 *  - 계측되지 않은 서비스(스팬을 보내지 않음)를 부르는 쪽의 클라이언트 스팬으로 알아본다
 *  - 서버 스팬은 멀쩡한데 부르는 쪽에서 실패하면, 바깥에서 본 값으로 판정한다
 *  - 평소에서 배운 한도(오류 비율·p90 지연), 호출이 적을 때의 최소 증거, 한 번 튄 지연은 거른다
 * 재생 시계(now)로 스팬을 직접 넣는다(네트워크 없음).
 */
let seq = 0;
const id = () => (++seq).toString(16).padStart(16, '0');
type S = { service: string; name: string; parent?: string; span?: string; start: number; ms: number; error?: boolean };
function req(spans: S[]) {
  const by = new Map<string, S[]>();
  for (const s of spans) by.set(s.service, [...(by.get(s.service) ?? []), s]);
  return {
    resourceSpans: [...by].map(([service, xs]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans: xs.map((s) => ({ traceId: 't', spanId: s.span ?? id(), parentSpanId: s.parent, name: s.name, startTimeUnixNano: String(BigInt(s.start) * 1_000_000n), endTimeUnixNano: String(BigInt(Math.round(s.start + s.ms)) * 1_000_000n), status: { code: s.error ? 2 : 0 } })) }],
    })),
  };
}

/** 1초에 요청 몇 개: frontend(루트) → (클라이언트 스팬) → 다른 서비스. callee 가 계측됐으면 그 서버 스팬도 */
function traffic(a: OtelAdapter, from: number, to: number, opts: { perSec: number; callee: string; rpc: string; instrumented: boolean; ms: number; clientError?: (t: number) => boolean; serverError?: boolean }) {
  const spans: S[] = [];
  for (let t = from; t < to; t += 1000 / opts.perSec) {
    const root = id();
    const client = id();
    spans.push({ service: 'frontend', name: 'GET /', span: root, start: t, ms: opts.ms + 5 });
    spans.push({ service: 'frontend', name: opts.rpc, span: client, parent: root, start: t + 1, ms: opts.ms, error: opts.clientError?.(t) });
    if (opts.instrumented) spans.push({ service: opts.callee, name: `grpc.${opts.rpc}`, parent: client, start: t + 1, ms: opts.ms - 1, error: opts.serverError });
  }
  a.ingest(req(spans) as never);
}

async function rowsAt(a: OtelAdapter, clock: { t: number }, t: number) {
  clock.t = t;
  return Object.fromEntries((await a.snapshot()).collections.services.map((r) => [r.id, r]));
}

describe('service health against its own normal (lessons from RCAEval)', () => {
  it('reads the callee name from a gRPC full method name', () => {
    expect(rpcPeer('hipstershop.CartService/GetCart')).toBe('cartservice');
    expect(rpcPeer('grpc.hipstershop.CurrencyService/Convert')).toBe('currencyservice');
    expect(rpcPeer('GET /api/v1/orders')).toBeNull();
  });

  it('shows an uninstrumented callee from its callers, and breaks its law when calls to it start failing', async () => {
    const clock = { t: 0 };
    const a = new OtelAdapter({ port: 0, now: () => clock.t });
    const start = 1_000_000;
    // 평소 2분: 실패 없음
    traffic(a, start, start + 120_000, { perSec: 2, callee: 'cartservice', rpc: 'hipstershop.CartService/GetCart', instrumented: false, ms: 8 });
    for (let t = start + 60_000; t <= start + 120_000; t += 15_000) await rowsAt(a, clock, t);
    const before = await rowsAt(a, clock, start + 120_000);
    expect(before.cartservice).toMatchObject({ instrumented: false, status: 'healthy', error_ratio: 0 });
    expect(before.cartservice.error_limit).toBeGreaterThan(0); // 평소를 배웠다
    // 장애: 부르는 쪽에서 본 호출의 30% 가 실패(서버 스팬은 처음부터 없다)
    let n = 0;
    traffic(a, start + 120_000, start + 180_000, { perSec: 2, callee: 'cartservice', rpc: 'hipstershop.CartService/GetCart', instrumented: false, ms: 8, clientError: () => n++ % 10 < 3 });
    const after = await rowsAt(a, clock, start + 180_000);
    expect(after.cartservice.error_ratio).toBeGreaterThan(after.cartservice.error_limit as number);
    expect(after.cartservice.status).toBe('degraded');
    // frontend 는 오류를 삼켜 멀쩡하다: 근본 원인 후보는 cartservice 하나
    expect(after.frontend.error_ratio).toBe(0);
  });

  it("judges an instrumented service by its callers' view when its own spans look fine", async () => {
    const clock = { t: 0 };
    const a = new OtelAdapter({ port: 0, now: () => clock.t });
    const start = 5_000_000;
    traffic(a, start, start + 120_000, { perSec: 2, callee: 'currencyservice', rpc: 'hipstershop.CurrencyService/Convert', instrumented: true, ms: 4 });
    for (let t = start + 60_000; t <= start + 120_000; t += 15_000) await rowsAt(a, clock, t);
    traffic(a, start + 120_000, start + 180_000, { perSec: 2, callee: 'currencyservice', rpc: 'hipstershop.CurrencyService/Convert', instrumented: true, ms: 4, clientError: () => true });
    const r = (await rowsAt(a, clock, start + 180_000)).currencyservice;
    expect(r.instrumented).toBe(true);
    expect(r.status).toBe('failing'); // 서버 스팬에는 오류가 하나도 없지만 부르는 쪽에서는 모두 실패
  });

  it('needs real evidence on a quiet service, and ignores a single latency spike', async () => {
    const clock = { t: 0 };
    const a = new OtelAdapter({ port: 0, now: () => clock.t });
    const start = 9_000_000;
    // 조용한 서비스: 1분에 12번
    traffic(a, start, start + 120_000, { perSec: 0.2, callee: 'emailservice', rpc: 'hipstershop.EmailService/Send', instrumented: true, ms: 20 });
    for (let t = start + 60_000; t <= start + 120_000; t += 15_000) await rowsAt(a, clock, t);
    // 오류 한 번(1/12 ≈ 8%): 최소 증거(오류 3번 몫)에 못 미쳐 위반이 아니다
    traffic(a, start + 120_000, start + 135_000, { perSec: 0.2, callee: 'emailservice', rpc: 'hipstershop.EmailService/Send', instrumented: true, ms: 20, clientError: (t) => t === start + 120_000 });
    const one = (await rowsAt(a, clock, start + 135_000)).emailservice;
    expect(one.error_ratio).toBeGreaterThan(0.05);
    expect(one.error_ratio as number).toBeLessThanOrEqual(one.error_limit as number);
    // 지연이 한 관측에서만 10배: 이어지지 않았으므로 판정에 쓰는 값은 그대로
    traffic(a, start + 135_000, start + 150_000, { perSec: 0.8, callee: 'emailservice', rpc: 'hipstershop.EmailService/Send', instrumented: true, ms: 200 });
    const spike = (await rowsAt(a, clock, start + 150_000)).emailservice;
    expect(spike.p90_latency_ms as number).toBeLessThanOrEqual(spike.latency_limit_ms as number);
    // 다음 관측에도 느리면 넘는다
    traffic(a, start + 150_000, start + 165_000, { perSec: 0.8, callee: 'emailservice', rpc: 'hipstershop.EmailService/Send', instrumented: true, ms: 200 });
    const sustained = (await rowsAt(a, clock, start + 165_000)).emailservice;
    expect(sustained.p90_latency_ms as number).toBeGreaterThan(sustained.latency_limit_ms as number);
  });

  it('blames a caller that got slow everywhere, not the services it calls', async () => {
    const clock = { t: 0 };
    const a = new OtelAdapter({ port: 0, now: () => clock.t });
    const start = 20_000_000;
    // checkout 이 email·payment 를 부른다. 장애: checkout 의 CPU 가 모자라 checkout 자신과 그 모든 바깥 호출이 느려진다(불린 쪽 서버 스팬은 그대로)
    const tick = (from: number, to: number, slow: boolean) => {
      const spans: S[] = [];
      for (let t = from; t < to; t += 500) {
        const root = id();
        spans.push({ service: 'checkoutservice', name: 'PlaceOrder', span: root, start: t, ms: slow ? 120 : 30 });
        for (const [callee, rpc] of [['emailservice', 'hipstershop.EmailService/Send'], ['paymentservice', 'hipstershop.PaymentService/Charge']]) {
          const c = id();
          spans.push({ service: 'checkoutservice', name: rpc, span: c, parent: root, start: t + 1, ms: slow ? 60 : 5 });
          spans.push({ service: callee, name: `grpc.${rpc}`, parent: c, start: t + 2, ms: 2 });
        }
      }
      a.ingest(req(spans) as never);
    };
    tick(start, start + 120_000, false);
    for (let t = start + 60_000; t <= start + 120_000; t += 15_000) await rowsAt(a, clock, t);
    for (const [from, to] of [[120_000, 135_000], [135_000, 150_000], [150_000, 165_000]]) {
      tick(start + from, start + to, true);
      await rowsAt(a, clock, start + to);
    }
    const r = await rowsAt(a, clock, start + 165_000);
    expect(r.checkoutservice.p90_latency_ms as number).toBeGreaterThan(r.checkoutservice.latency_limit_ms as number);
    for (const callee of ['emailservice', 'paymentservice']) expect(r[callee].p90_latency_ms as number, callee).toBeLessThanOrEqual(r[callee].latency_limit_ms as number);
  });

  it('points a slow caller at the callee its time goes to (latency origin), found from the trace structure alone', async () => {
    const clock = { t: 0 };
    const a = new OtelAdapter({ port: 0, now: () => clock.t });
    const start = 30_000_000;
    // HTTP 처럼 이름 규칙이 없는 호출: 부르는 쪽의 'GET' 스팬 아래에 불린 쪽의 서버 스팬. 장애: travel 앞의 네트워크 지연(서버 스팬은 그대로)
    const tick = (from: number, to: number, delay: number) => {
      const spans: S[] = [];
      for (let t = from; t < to; t += 250) {
        const root = id();
        spans.push({ service: 'admin-travel', name: 'GET /admin/trips', span: root, start: t, ms: 12 + delay });
        for (const [callee, ms] of [['travel', 3 + delay], ['station', 3]] as const) {
          const c = id();
          spans.push({ service: 'admin-travel', name: 'GET', span: c, parent: root, start: t + 1, ms });
          spans.push({ service: callee, name: `GET /api/${callee}`, parent: c, start: t + 1 + (callee === 'travel' ? delay / 2 : 0), ms: 2 });
        }
      }
      a.ingest(req(spans) as never);
    };
    tick(start, start + 120_000, 0);
    for (let t = start + 60_000; t <= start + 120_000; t += 15_000) await rowsAt(a, clock, t);
    for (const [from, to] of [[120_000, 135_000], [135_000, 150_000], [150_000, 165_000]]) {
      tick(start + from, start + to, 80);
      await rowsAt(a, clock, start + to);
    }
    const r = await rowsAt(a, clock, start + 165_000);
    expect(r['admin-travel'].p90_latency_ms as number).toBeGreaterThan(r['admin-travel'].latency_limit_ms as number);
    expect(r['admin-travel'].latency_origin_id).toBe('travel');
    // 불린 쪽도 '부르는 쪽에서 본' 지연으로 법칙을 어긴다(그래야 사슬이 그곳까지 오른다)
    expect(r.travel.p90_latency_ms as number).toBeGreaterThan(r.travel.latency_limit_ms as number);
    expect(r.station.p90_latency_ms as number).toBeLessThanOrEqual(r.station.latency_limit_ms as number);
  });
});
