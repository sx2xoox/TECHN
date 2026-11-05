import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeOtlpTraces, OtelAdapter } from '../src/index.ts';
import { startTwoServices, type TwoServices } from '../../../examples/otel/two-services.ts';

/**
 * 진짜 OpenTelemetry SDK(공식 OTLP/HTTP 내보내기)가 만든 트레이스를 받아 세계용 행으로 바꾸는지.
 * 보내는 쪽 코드는 ISOMORPH 와 무관한 공식 라이브러리다.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let adapter: OtelAdapter;
let app: TwoServices;
let result: { ok: number; failed: number };

beforeAll(async () => {
  adapter = new OtelAdapter({ port: 0 });
  await adapter.connect();
  app = await startTwoServices({ endpoint: adapter.endpoint, failRate: 0.3 });
  result = await app.hit(24);
  await app.close(); // 남은 스팬까지 내보낸다
}, 30_000);

afterAll(async () => {
  await adapter?.close();
});

describe('OpenTelemetry adapter (real SDK)', () => {
  it('receives every span the real SDK exported', () => {
    // 체크아웃 한 번 = web 서버 스팬 + web 클라이언트 스팬 + payments 서버 스팬
    expect(result.ok + result.failed).toBe(24);
    expect(adapter.received).toBe(24 * 3);
  });

  it('turns services into buildings with calls, errors and latency', async () => {
    const snap = await adapter.snapshot();
    const svc = Object.fromEntries(snap.collections.services.map((s) => [s.id, s]));
    expect(Object.keys(svc).sort()).toEqual(['payments', 'web']);
    expect(svc.web.calls_per_min).toBe(24); // 1분 창 안의 web 서버 스팬
    expect(svc.payments.calls_per_min).toBe(24);
    expect(svc.payments.error_count).toBe(result.failed);
    expect(svc.web.error_count).toBe(result.failed);
    expect(Number(svc.payments.avg_latency_ms)).toBeGreaterThanOrEqual(15);
    if (result.failed) expect(['degraded', 'failing']).toContain(svc.payments.status);
  });

  it('links spans across services through the propagated trace context', async () => {
    const spans = (await adapter.snapshot()).collections.spans;
    const charges = spans.filter((s) => s.name === 'POST /charge');
    expect(charges).toHaveLength(24);
    // payments 의 서버 스팬은 web 의 클라이언트 스팬을 부모로 둔다 → '부른 쪽' 은 web
    expect(charges.every((s) => s.service_id === 'payments' && s.caller_id === 'web' && s.kind === 'server')).toBe(true);
    expect(charges.filter((s) => s.status === 'error')).toHaveLength(result.failed);
    // 같은 서비스 안의 부모·자식은 '부른 쪽' 이 없다
    expect(spans.filter((s) => s.name === 'POST payments').every((s) => s.caller_id === null)).toBe(true);
    expect(new Set(charges.map((s) => s.trace_id)).size).toBe(24);
  });

  it('accepts the hand-written OTLP sample used by the container smoke test', async () => {
    const a = new OtelAdapter({ port: 0, windowMs: 10 * 365 * 24 * 3600_000 });
    a.ingest(JSON.parse(fs.readFileSync(path.join(root, 'examples/otel/sample-otlp.json'), 'utf8')));
    const snap = await a.snapshot();
    expect(snap.collections.services.map((s) => s.id).sort()).toEqual(['payments', 'web']);
    const charges = snap.collections.spans.filter((s) => s.name === 'POST /charge');
    expect(charges.map((s) => s.caller_id)).toEqual(['web', 'web']);
    expect(snap.collections.services.find((s) => s.id === 'payments')!.error_count).toBe(1);
  });

  it('refuses other content types with a clear message and stays read-only', async () => {
    const r = await fetch(adapter.endpoint, { method: 'POST', headers: { 'content-type': 'application/grpc' }, body: new Uint8Array([1, 2]) });
    expect(r.status).toBe(415);
    await expect(adapter.execute()).rejects.toThrow(/읽기 전용/);
  });
});

describe('OpenTelemetry adapter (real SDK, http/protobuf)', () => {
  it('decodes the official protobuf exporter just like JSON', async () => {
    const a = new OtelAdapter({ port: 0 });
    await a.connect();
    const app2 = await startTwoServices({ endpoint: a.endpoint, failRate: 0.3, protocol: 'proto' });
    const r = await app2.hit(12);
    await app2.close();
    try {
      expect(a.received).toBe(12 * 3);
      const snap = await a.snapshot();
      const svc = Object.fromEntries(snap.collections.services.map((s) => [s.id, s]));
      expect(svc.payments.error_count).toBe(r.failed);
      const charges = snap.collections.spans.filter((s) => s.name === 'POST /charge');
      expect(charges.every((s) => s.caller_id === 'web' && s.kind === 'server' && String(s.trace_id).length === 32)).toBe(true);
      expect(charges.filter((s) => s.status === 'error')).toHaveLength(r.failed);
      // 시각이 나노초 정밀도로 올바르게 읽혔다(지금 근처, 길이는 양수)
      expect(Math.abs(Date.parse(String(charges[0].created_at)) - Date.now())).toBeLessThan(60_000);
      expect(charges.every((s) => Number(s.duration_ms) >= 15)).toBe(true);
    } finally {
      await a.close();
    }
  });

  it('rejects truncated or random protobuf cleanly', async () => {
    expect(() => decodeOtlpTraces(new Uint8Array([0x0a, 0x10, 0x01]))).toThrow(/잘렸/);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 300; i++) {
      const bytes = new Uint8Array(Array.from({ length: 1 + Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256)));
      try {
        decodeOtlpTraces(bytes);
      } catch (e) {
        expect(String(e)).toMatch(/protobuf/);
      }
    }
    const r = await fetch(adapter.endpoint, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: new Uint8Array([0x0a, 0x10, 0x01]) });
    expect(r.status).toBe(400);
  });
});
