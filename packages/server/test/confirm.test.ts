import { describe, expect, it } from 'vitest';
import type { SystemSchema } from '@isomorph/core';
import { IsomorphRuntime, type ViolationEvent } from '../src/index.ts';

/**
 * 확인 시간(confirmMs): 위반은 세계에 바로 보이지만, 장애 기록·알림은 그만큼 이어진 뒤에 연다(경보 규칙의 'for').
 * 공개 벤치마크에서 거짓 경보의 대부분이 30초 안팎의 짧은 튐이었던 데서 나온 것.
 */
const schema: SystemSchema = {
  system: 'svc',
  source: 'custom',
  constraints: [{ collection: 'services', expr: { op: 'cmp', field: 'latency', cmp: '<=', value: 100 }, description: '지연은 100 이하', enforced: false }],
  collections: [{ name: 'services', primaryKey: 'id', fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'latency', type: 'number', nullable: false }] }],
};

function scripted(confirmMs: number) {
  let clock = 1_000_000;
  let latency = 10;
  const adapter = {
    kind: 'custom' as const,
    system: 'svc',
    connect: async () => {},
    introspect: async () => schema,
    snapshot: async () => ({ ts: clock, collections: { services: [{ id: 'api', latency }] } }),
    execute: async () => {},
    describe: () => '',
    close: async () => {},
  };
  const rt = new IsomorphRuntime({ adapter, pollMs: 3_600_000, numRuns: 5, compile: { mode: 'heuristic' }, confirmMs });
  const events: ViolationEvent[] = [];
  rt.on('violation', (e: ViolationEvent) => events.push(e));
  const step = async (l: number) => {
    clock += 15_000;
    latency = l;
    await rt.refresh();
  };
  return { rt, events, step, now: () => clock };
}

describe('confirmation time before opening an incident', () => {
  it('shows a short blip in the world but opens no incident and sends no alert', async () => {
    const { rt, events, step } = scripted(45_000);
    await rt.start();
    try {
      await step(500); // 튐
      expect(rt.world!.violations).toHaveLength(1); // 세계에는 바로 보인다
      await step(500);
      await step(10); // 30초 만에 풀림
      expect(events).toHaveLength(0);
      expect(rt.incidents.all()).toHaveLength(0);
      expect(rt.blips).toBe(1);
    } finally {
      await rt.stop();
    }
  });

  it('opens the incident once the violation has lasted, keeping when it really started', async () => {
    const { rt, events, step, now } = scripted(45_000);
    await rt.start();
    try {
      await step(500);
      const began = now();
      await step(500);
      await step(500);
      expect(events).toHaveLength(0);
      await step(500); // 45초 이어짐 → 확인
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ phase: 'start', ts: now(), since: began });
      const inc = rt.incidents.all()[0];
      expect(inc.openedAt).toBe(now());
      expect(inc.violations[0].start).toBe(began);
      await step(10);
      expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    } finally {
      await rt.stop();
    }
  });

  it('is immediate by default (confirmMs 0)', async () => {
    const { rt, events, step } = scripted(0);
    await rt.start();
    try {
      await step(500);
      expect(events.map((e) => e.phase)).toEqual(['start']);
      expect(events[0].since).toBeUndefined();
    } finally {
      await rt.stop();
    }
  });
});
