import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelAdapter } from '@isomorph/adapters';
import { startTwoServices, type TwoServices } from '../../../examples/otel/two-services.ts';
import { IsomorphRuntime } from '../src/index.ts';

/** 진짜 OpenTelemetry SDK 트레이스 → 사람 손 없이 컴파일·검증된 세계 */
let adapter: OtelAdapter;
let app: TwoServices;
let rt: IsomorphRuntime;

beforeAll(async () => {
  adapter = new OtelAdapter({ port: 0 });
  await adapter.connect();
  app = await startTwoServices({ endpoint: adapter.endpoint, failRate: 0.4 });
  await app.hit(12);
  rt = new IsomorphRuntime({ adapter, pollMs: 60_000, numRuns: 40, compile: { mode: 'heuristic' } });
  expect(await rt.start()).toBe('running');
}, 30_000);

afterAll(async () => {
  await app?.close();
  await rt?.stop();
});

describe('OpenTelemetry → world', () => {
  it('compiles a lawful world: services are buildings, spans walk from caller to callee', () => {
    expect(rt.report!.ok).toBe(true);
    const svc = rt.grammar!.kinds.find((k) => k.collection === 'services')!;
    const spans = rt.grammar!.kinds.find((k) => k.collection === 'spans')!;
    expect(svc.archetype).toBe('building');
    expect(svc.channels.map((c) => `${c.channel}:${c.field}`)).toEqual(expect.arrayContaining(['crowd:calls_per_min', 'fire:error_count', 'speed:avg_latency_ms', 'tint:status']));
    expect(spans.archetype).toBe('npc');
    expect(spans.route).toEqual({ from: 'caller_id', to: 'service_id' });
    expect(spans.channels.some((c) => c.channel === 'tint' && c.field === 'status')).toBe(true);
  });

  it('shows the failing service on fire and its failed calls in the failure colour', () => {
    const w = rt.world!;
    const payments = w.entities.find((e) => e.source.collection === 'services' && e.source.pk === 'payments')!;
    expect(Number(payments.visual.fire)).toBeGreaterThan(0);
    const tint = rt.grammar!.kinds.find((k) => k.collection === 'spans')!.channels.find((c) => c.channel === 'tint');
    const errorColor = tint && 'map' in tint ? tint.map.error : undefined;
    expect(errorColor).toBe('red');
    expect(w.entities.filter((e) => e.source.collection === 'spans' && e.visual.tint === errorColor).length).toBeGreaterThan(0);
  });

  it('updates as soon as new traces arrive (push)', async () => {
    const before = rt.world!.entities.filter((e) => e.source.collection === 'spans').length;
    await app.hit(4);
    await new Promise((r) => setTimeout(r, 400));
    expect(rt.world!.entities.filter((e) => e.source.collection === 'spans').length).toBeGreaterThan(before);
  });
});
