import http from 'node:http';
import { context, defaultTextMapGetter, defaultTextMapSetter, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * 진짜 OpenTelemetry SDK 로 계측한 작은 서비스 두 개(같은 프로세스, 서로 다른 service.name).
 *   web      : GET /checkout  → (클라이언트 스팬) → payments 에 HTTP 요청(W3C traceparent 전파)
 *   payments : POST /charge   → failRate 확률로 실패(오류 상태 스팬, HTTP 502)
 * 스팬은 공식 OTLP/HTTP(JSON) 내보내기로 endpoint 에 보낸다. ISOMORPH 코드는 한 줄도 쓰지 않는다.
 */
export interface TwoServices {
  webUrl: string;
  /** 체크아웃 요청 n 번(동시 conc 개씩) */
  hit(n: number, conc?: number): Promise<{ ok: number; failed: number }>;
  close(): Promise<void>;
}

export async function startTwoServices(opts: { endpoint: string; failRate?: number; paymentsDelayMs?: [number, number]; protocol?: 'json' | 'proto'; headers?: Record<string, string> }): Promise<TwoServices> {
  const propagator = new W3CTraceContextPropagator();
  const provider = (service: string) =>
    new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': service }),
      // 공식 내보내기: http/json(기본) 또는 http/protobuf
      spanProcessors: [new SimpleSpanProcessor(opts.protocol === 'proto' ? new OTLPProtoTraceExporter({ url: opts.endpoint, headers: opts.headers }) : new OTLPTraceExporter({ url: opts.endpoint, headers: opts.headers }))],
    });
  const webProvider = provider('web');
  const payProvider = provider('payments');
  const webTracer = webProvider.getTracer('example-web');
  const payTracer = payProvider.getTracer('example-payments');
  const [lo, hi] = opts.paymentsDelayMs ?? [20, 80];

  const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

  const payments = http.createServer((req, res) => {
    const parent = propagator.extract(ROOT_CONTEXT, req.headers, defaultTextMapGetter);
    const span = payTracer.startSpan('POST /charge', { kind: SpanKind.SERVER, attributes: { 'http.request.method': 'POST' } }, parent);
    setTimeout(() => {
      const fail = Math.random() < (opts.failRate ?? 0.25);
      if (fail) span.setStatus({ code: SpanStatusCode.ERROR, message: 'card declined' });
      span.end();
      res.writeHead(fail ? 502 : 200).end(fail ? 'declined' : 'ok');
    }, lo + Math.random() * (hi - lo));
  });
  const payPort = await listen(payments);

  const callPayments = (ctx: Context) =>
    new Promise<number>((resolve, reject) => {
      const headers: Record<string, string> = {};
      propagator.inject(ctx, headers, defaultTextMapSetter);
      const r = http.request({ host: '127.0.0.1', port: payPort, path: '/charge', method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end();
    });

  const web = http.createServer(async (_req, res) => {
    const server = webTracer.startSpan('GET /checkout', { kind: SpanKind.SERVER, attributes: { 'http.request.method': 'GET' } });
    const serverCtx = trace.setSpan(context.active(), server);
    const client = webTracer.startSpan('POST payments', { kind: SpanKind.CLIENT }, serverCtx);
    const status = await callPayments(trace.setSpan(serverCtx, client)).catch(() => 0);
    if (status !== 200) {
      client.setStatus({ code: SpanStatusCode.ERROR, message: `payments ${status}` });
      server.setStatus({ code: SpanStatusCode.ERROR, message: 'checkout failed' });
    }
    client.end();
    server.end();
    res.writeHead(status === 200 ? 200 : 503).end();
  });
  const webPort = await listen(web);
  const webUrl = `http://127.0.0.1:${webPort}/checkout`;

  return {
    webUrl,
    async hit(n, conc = 4) {
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < n; i += conc) {
        const batch = Array.from({ length: Math.min(conc, n - i) }, () => fetch(webUrl).then((r) => (r.ok ? ok++ : failed++)));
        await Promise.all(batch);
      }
      return { ok, failed };
    },
    async close() {
      await webProvider.forceFlush();
      await payProvider.forceFlush();
      await Promise.all([webProvider.shutdown(), payProvider.shutdown()]);
      await new Promise<void>((r) => web.close(() => r()));
      await new Promise<void>((r) => payments.close(() => r()));
    },
  };
}
