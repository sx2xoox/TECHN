import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeStudy, makeRcaScene, planRcaTrials, RCA_FAULTS, RCA_KINDS, rcaEngineOutcome, rcaFaultApplies, readStudyRecords, startStudyServer, studyCsv, studyTasks, type RcaFault, type RcaKind } from '../src/index.ts';

/**
 * 사용자 실험의 '근본 원인 찾기' 과제: 장면이 의도한 대로 만들어지는가, 서버가 조건마다 같은 원자료를 주고
 * 엔진의 계산(살펴보기)은 표 조건에 주지 않는가, 채점과 분석이 과제 종류를 섞지 않는가.
 */
const keys = (s: Awaited<ReturnType<typeof makeRcaScene>>) => new Set(s.world.violations.map((v) => `${v.collection}:${v.pk}`));

describe('root-cause scenes', () => {
  it('break the root first, spread to the customer-facing service, and include an unrelated earlier failure', async () => {
    for (const kind of RCA_KINDS) {
      for (let seed = 1; seed <= 30; seed++) {
        const s = await makeRcaScene(kind, seed);
        const bad = keys(s);
        expect(bad.has(s.target), `${kind}/${seed}: 근본 원인이 법칙을 어기고 있음`).toBe(true);
        expect(bad.has('otel_services:frontend'), `${kind}/${seed}: 고객 화면이 실패함`).toBe(true);
        // 헷갈리게 하는 것: 장애와 상관없이 먼저 깨진 배치 작업 파드
        expect([...bad].some((k) => k.startsWith('k8s_pods:ops/reports-'))).toBe(true);
        // 근본 원인의 첫 위반이 다른 모든 장애 관련 위반보다 먼저(배치 작업 빼고)
        const breakAt = (key: string) => Math.min(...s.log.filter((e) => e.key === key && /→ "failing"|→ "degraded"|ready: true → false/.test(e.text)).map((e) => e.at));
        const rootAt = breakAt(s.target);
        expect(Number.isFinite(rootAt)).toBe(true);
        for (const k of bad) if (k !== s.target && !k.includes('ops/reports')) expect(breakAt(k), `${kind}/${seed}: ${k}`).toBeGreaterThanOrEqual(rootAt);
        // 잘못된 배포만 근본 원인에 '직전 변경'(이미지)이 있다
        expect(!!s.insights[s.target].change, `${kind}/${seed}`).toBe(kind === 'bad_deploy');
        if (kind === 'bad_deploy') expect(s.insights[s.target].change!.map((c) => c.field)).toEqual(['image']);
        // 상관없는 정상 배포(이미지 변경)가 장애 직전 기록에 있다
        expect(s.log.filter((e) => e.key.startsWith('k8s_deployments:') && e.text.startsWith('image:') && e.key !== s.target)).toHaveLength(1);
      }
    }
  });

  it("lets the engine's root-cause chain from the failing frontend reach the planted root", async () => {
    // 노드 고장은 디플로이먼트와 노드가 파드로만 이어져 있다: '함께 기댄 곳' 규칙이 있어야 노드까지 간다
    for (const kind of RCA_KINDS) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = await makeRcaScene(kind, seed);
        const chain = s.insights['otel_services:frontend'].chain;
        expect(chain.at(-1)?.key, `${kind}/${seed}`).toBe(s.target);
      }
    }
    const nd = await makeRcaScene('node_down', 7);
    const dep = nd.insights[nd.insights['otel_services:frontend'].chain.at(-2)!.key];
    expect(dep.diagnosis?.title).toBe('함께 기댄 곳이 먼저 법칙을 어김');
    expect(dep.chain[0].via).toMatch(/^k8s_pods \d+개를 거쳐/);
    // 두 조건에 똑같이 주는 글이라 세계의 비유 이름을 쓰지 않는다
    expect(JSON.stringify(nd.insights)).not.toMatch(/공장|창고|마을/);
    // 배치 작업 파드는 장애와 이어지지 않는다
    const reports = Object.keys(nd.insights).find((k) => k.startsWith('k8s_pods:ops/reports-'))!;
    expect(nd.insights[reports].chain).toEqual([]);
  });

  it('is deterministic per seed and varies across seeds', async () => {
    const a = await makeRcaScene('bad_deploy', 42, 1_800_000_000_000);
    const b = await makeRcaScene('bad_deploy', 42, 1_800_000_000_000);
    expect(b.target).toBe(a.target);
    expect(b.log.map((e) => e.text)).toEqual(a.log.map((e) => e.text));
    const roots = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) roots.add((await makeRcaScene('service_bug', seed)).target);
    expect(roots.size).toBeGreaterThan(3);
  });

  it('balances the three root kinds per condition and rotates condition order', () => {
    for (let p = 0; p < 6; p++) {
      const plan = planRcaTrials(p, ['world', 'table'], 3);
      for (const c of ['world', 'table']) expect(new Set(plan.filter((x) => x.condition === c).map((x) => x.anomaly)).size).toBe(3);
      expect(plan[0].condition).toBe(p % 2 === 0 ? 'world' : 'table');
    }
  });
});

describe('root-cause engine under realistic faults (bench-rca)', () => {
  // 고친 뒤 기대: 우연·같은 관측·느린 번짐·감시 지연(배포)은 맞음, 트레이스 없음은 멈춤, 노드 감시 지연은 덜 감 — 어떤 상황에서도 틀리지 않는다
  const expected: Partial<Record<RcaFault, 'correct' | 'partial' | 'abstain'>> = { clean: 'correct', 'same-tick': 'correct', 'slow-spread': 'correct', coincidence: 'correct', 'no-trace': 'abstain' };
  it('never points outside the true causal path, and gets the expected outcome per fault', async () => {
    for (const fault of RCA_FAULTS) {
      for (const kind of RCA_KINDS) {
        if (!rcaFaultApplies(fault, kind)) continue;
        for (let seed = 1; seed <= 8; seed++) {
          const s = await makeRcaScene(kind, seed, 1_800_000_000_000, fault);
          const o = rcaEngineOutcome(s);
          expect(o.outcome, `${fault}/${kind}/${seed}: ${o.chain.join(' ← ')}`).not.toBe('wrong');
          const want = fault === 'lag' ? (kind === 'bad_deploy' ? 'correct' : 'partial') : expected[fault];
          if (want) expect(o.outcome, `${fault}/${kind}/${seed}`).toBe(want);
        }
      }
    }
  });

  it('says why it climbed when time order alone cannot tell', async () => {
    // 같은 관측: 디플로이먼트와 서비스가 함께 깨짐 → 연결의 방향(디플로이먼트가 기반)으로, 낮은 확신
    const tie = await makeRcaScene('bad_deploy', 3, 1_800_000_000_000, 'same-tick');
    const svc = tie.insights[tie.path[1]];
    expect(svc.diagnosis?.title).toBe('연결된 기반이 같은 관측에서 함께 깨짐');
    expect(svc.chain[0]).toMatchObject({ key: tie.target, via: '같은 관측에서 함께 깨진 기반(순서는 모름)' });
    // 감시 지연: 디플로이먼트가 서비스보다 '나중에' 깨진 것처럼 보이지만, 그 전에 이미지가 바뀌었다
    const lag = await makeRcaScene('bad_deploy', 3, 1_800_000_000_000, 'lag');
    const lsvc = lag.insights[lag.path[1]];
    expect(lsvc.diagnosis?.title).toBe('지금 깨진 기반이 직전에 바뀜');
    expect(lsvc.diagnosis?.detail).toContain('image');
    expect(lsvc.chain[0]).toMatchObject({ key: lag.target, via: '지금 깨져 있고 직전에 바뀐 기반' });
    // 반대로, 바뀐 것이 없는 서비스 코드 오류에서는 디플로이먼트로 오르지 않는다
    const bug = await makeRcaScene('service_bug', 3, 1_800_000_000_000, 'lag');
    expect(bug.insights[bug.target].chain).toEqual([]);
  });

  it('does not blame a scale-up in progress, nor a crash-looping pod that broke long before its node', async () => {
    const co = await makeRcaScene('service_bug', 5, 1_800_000_000_000, 'coincidence');
    const dep = `k8s_deployments:shop/${co.target.split(':')[1]}`;
    expect(co.insights[dep].violations.length).toBe(1); // 디플로이먼트는 정말 모자라다(복제본을 늘리는 중)
    expect(co.insights[dep].diagnosis?.title).toBe('기준 값이 방금 바뀜');
    expect(co.insights[co.target].chain.map((c) => c.key)).not.toContain(dep);
    const slow = await makeRcaScene('node_down', 5, 1_800_000_000_000, 'slow-spread');
    expect(slow.insights[slow.target].chain).toEqual([]); // 노드에서 그 위의 오래된 CrashLoop 파드로 거꾸로 오르지 않는다
  });
});

describe('root-cause study server', () => {
  it('gives every condition the same rows and change log, withholds the engine from the plain table, and scores the root', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-rca-'));
    const srv = await startStudyServer({ port: 0, staticDir: dataDir, dataDir, task: 'rca', conditions: ['world', 'table', 'table+alerts'], practicePerCondition: 1 });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(`${base}/api/study/config`)).json()).toMatchObject({ task: 'rca' });
      const info = (await (await post('/api/study/session', { developer: 'none', dashboards: 2 })).json()) as { session: string; total: number; task: string; choices: { id: string }[]; glossary: string[] };
      expect(info.task).toBe('rca');
      expect(info.total).toBe(3 * (1 + 3));
      expect(info.choices.map((c) => c.id)).toEqual([...RCA_KINDS]);
      expect(info.glossary.length).toBeGreaterThan(0);
      type P = { condition: string; practice: boolean; task: string; rows: Record<string, unknown[]>; log: unknown[]; insights?: Record<string, unknown>; alerts?: string[]; world: unknown; oracle?: unknown };
      const trials: P[] = [];
      for (let k = 0; k < info.total; k++) trials.push((await (await fetch(`${base}/api/study/trial?session=${info.session}&key=${k}`)).json()) as P);
      for (const t of trials) {
        expect(t.task).toBe('rca');
        expect(t.oracle).toBeUndefined();
        expect(t.log.length).toBeGreaterThan(10);
        expect(Object.keys(t.rows).sort()).toEqual(['k8s_deployments', 'k8s_nodes', 'k8s_pods', 'otel_services']);
        expect(!!t.insights).toBe(t.condition !== 'table');
        expect(!!t.world).toBe(t.condition === 'world');
        expect(!!t.alerts).toBe(t.condition === 'table+alerts');
      }
      // 연습: 정답을 알려준다. 틀린 근본 원인(증상인 frontend)을 고르면 오답
      const fb = (await (await post('/api/study/answer', { session: info.session, key: 0, answer: 'otel_services:frontend', choice: 'service_bug', timeMs: 900 })).json()) as { locateCorrect: boolean; target: string; anomaly: RcaKind };
      expect(fb.locateCorrect).toBe(false);
      expect(fb.target).not.toBe('otel_services:frontend');
      // '어긴 곳이 없다' 는 이 과제의 선택지가 아니다
      expect((await (await post('/api/study/answer', { session: info.session, key: 1, answer: null, choice: 'none', timeMs: 10 })).json())).toEqual({ ok: true });
      const recs = readStudyRecords(dataDir);
      expect(recs[0]).toMatchObject({ type: 'session', task: 'rca' });
      expect(recs.filter((r) => r.type === 'trial').every((r) => (r as { task?: string }).task === 'rca')).toBe(true);
      expect(recs.at(-1)).toMatchObject({ choice: null, locateCorrect: false });
    } finally {
      await srv.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('adds one engine-stops-early trial per condition, keeps it off the screen, and records whether the answer followed the engine', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-rca-hard-'));
    const srv = await startStudyServer({ port: 0, staticDir: dataDir, dataDir, task: 'rca', rcaHard: true, conditions: ['world', 'table'], practicePerCondition: 1, exposeAnswers: true });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const info = (await (await post('/api/study/session', { developer: 'some' })).json()) as { session: string; total: number };
      expect(info.total).toBe(2 * (1 + 4));
      type P = { key: number; condition: string; practice: boolean; insights?: Record<string, { chain: { key: string }[] }>; oracle: { target: string } };
      const ts: P[] = [];
      for (let k = 0; k < info.total; k++) {
        const raw = await (await fetch(`${base}/api/study/trial?session=${info.session}&key=${k}`)).text();
        // 엔진의 결과·상황 이름은 서버에만 둔다
        expect(raw).not.toMatch(/"(engine|fault|hard|followedEngine)"/);
        ts.push(JSON.parse(raw) as P);
      }
      const worldHard = ts.filter((t) => !t.practice && t.condition === 'world' && t.insights!['otel_services:frontend'].chain.at(-1)?.key !== t.oracle.target);
      expect(worldHard).toHaveLength(1); // 세계 조건의 본 과제 중 엔진이 끝까지 못 가는 것은 하나
      const h = worldHard[0];
      const engineEnd = h.insights!['otel_services:frontend'].chain.at(-1)!.key;
      expect(engineEnd).toMatch(/^otel_services:/);
      expect(h.oracle.target).toMatch(/^k8s_nodes:/);
      await post('/api/study/answer', { session: info.session, key: h.key, answer: engineEnd, choice: 'service_bug', timeMs: 5000 });
      const rec = readStudyRecords(dataDir).find((r) => r.type === 'trial') as unknown as Record<string, unknown>;
      expect(rec).toMatchObject({ hard: true, fault: 'lag', engineOutcome: 'partial', followedEngine: true, locateCorrect: false });
      // 분석: 주 분석에서 빠지고 따로 보고된다
      const recs = [
        { type: 'session', participant: 0, session: 'a', task: 'rca', background: { developer: 'none' } },
        { type: 'complete', participant: 0 },
        { type: 'trial', participant: 0, session: 'a', task: 'rca', practice: false, condition: 'world', anomaly: 'node_down', locateCorrect: false, diagnoseCorrect: false, timeMs: 9000, gaveUp: false, timedOut: false, hard: true, followedEngine: true },
        { type: 'trial', participant: 0, session: 'a', task: 'rca', practice: false, condition: 'world', anomaly: 'bad_deploy', locateCorrect: true, diagnoseCorrect: true, timeMs: 3000, gaveUp: false, timedOut: false },
      ] as Parameters<typeof analyzeStudy>[0];
      const r = analyzeStudy(recs, { task: 'rca' });
      expect(r.conditions[0]).toMatchObject({ trials: 1, medianTimeMs: 3000 });
      expect(r.hard).toEqual([{ condition: 'world', trials: 1, locateAccuracy: 0, followedEngine: 1, medianTimeMs: NaN }]);
    } finally {
      await srv.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('never mixes the two task families in one analysis', () => {
    const recs = [
      { type: 'session', participant: 0, session: 'a', background: { developer: 'none' } },
      { type: 'complete', participant: 0 },
      { type: 'trial', participant: 0, session: 'a', practice: false, condition: 'world', anomaly: 'negative_stock', locateCorrect: true, diagnoseCorrect: true, timeMs: 1000, gaveUp: false, timedOut: false },
      { type: 'session', participant: 1, session: 'b', task: 'rca', background: { developer: 'none' } },
      { type: 'complete', participant: 1 },
      { type: 'trial', participant: 1, session: 'b', task: 'rca', practice: false, condition: 'world', anomaly: 'node_down', locateCorrect: true, diagnoseCorrect: true, timeMs: 5000, gaveUp: false, timedOut: false },
    ] as Parameters<typeof analyzeStudy>[0];
    expect(studyTasks(recs)).toEqual(['locate', 'rca']);
    expect(analyzeStudy(recs).participants).toBe(1);
    expect(analyzeStudy(recs).conditions[0].medianTimeMs).toBe(1000);
    expect(analyzeStudy(recs, { task: 'rca' }).conditions[0].medianTimeMs).toBe(5000);
    expect(studyCsv(recs, { task: 'rca' }).trim().split('\n')).toHaveLength(2);
    expect(studyCsv(recs, { task: 'rca' })).toContain(',rca,world,node_down,');
  });
});
