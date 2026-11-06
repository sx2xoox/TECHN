import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubernetesAdapter } from '@isomorph/adapters';
import { startFakeKube, type FakeKube } from '../../adapters/test/fake-kube.ts';
import { IsomorphRuntime } from '../src/index.ts';

/** 장애 기록은 저장소 파일에 남아 다시 시작해도 이어진다 */
let kube: FakeKube;
let dir: string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runtime = (file: string) => new IsomorphRuntime({ adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }), storePath: file, pollMs: 60_000, numRuns: 20, compile: { mode: 'heuristic' } });

beforeAll(async () => {
  kube = await startFakeKube();
  kube.addDeployment('pay', 'shop', 2);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-incidents-'));
});

afterAll(async () => {
  await kube?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('incident records survive a restart', () => {
  it('continues what is still broken, closes what recovered while ISOMORPH was down, never duplicates', async () => {
    const file = path.join(dir, 'events.sqlite');
    const a = runtime(file);
    await a.start();
    kube.deployImage('default/web', 'registry.example/app:9-broken');
    kube.deployImage('shop/pay', 'registry.example/app:9-broken');
    await wait(60);
    await a.refresh();
    const before = a.incidents.all().filter((i) => !i.observedFromStart);
    const web = before.find((i) => i.rootKey === 'deployments:default/web')!;
    const pay = before.find((i) => i.rootKey === 'deployments:shop/pay')!;
    expect(web.change?.[0]).toMatchObject({ field: 'image', now: 'registry.example/app:9-broken' });
    await a.stop();

    // ISOMORPH 가 멈춘 사이 web 만 고쳐졌다
    kube.deployImage('default/web', kube.goodImage);
    await wait(60);

    const b = runtime(file);
    await b.start();
    const after = b.incidents.all();
    const web2 = after.find((i) => i.id === web.id)!;
    const pay2 = after.find((i) => i.id === pay.id)!;
    expect(web2.closedAt).not.toBeNull();
    expect(web2.timeline.some((s) => s.text.includes('ISOMORPH 가 멈춘 사이 — 정확한 시각 모름'))).toBe(true);
    expect(web2.change?.[0]).toMatchObject({ field: 'image' }); // 근본 원인·직전 변경도 그대로
    expect(pay2.closedAt).toBeNull();
    expect(pay2.timeline.some((s) => s.kind === 'note')).toBe(true);
    // 여전히 깨진 것은 새 장애로 다시 열리지 않는다(시작할 때 이미 깨져 있던 위반이 이어받은 장애에 이미 있다)
    expect(after.filter((i) => i.rootKey === 'deployments:shop/pay')).toHaveLength(1);
    expect(after.filter((i) => i.closedAt === null && i.violations.some((v) => v.pk === 'shop/api'))).toHaveLength(1);
    await b.stop();
  });
});
