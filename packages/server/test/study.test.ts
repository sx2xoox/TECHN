import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeStudy, bootstrapMedianCI, makeTrial, median, planTrials, readStudyRecords, startStudyServer, STUDY_ANOMALIES, studyCsv, studyGrammar, studyPower, wilcoxon, type StudyRecord } from '../src/index.ts';

describe('study tasks', () => {
  const { schema, grammar } = studyGrammar();

  it('plants exactly the intended rule violation (or none) and nothing else', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const anomaly of STUDY_ANOMALIES) {
        const t = makeTrial({ index: 0, practice: false, condition: 'world', anomaly, seed, grammar, schema });
        const keys = new Set(t.world.violations.map((v) => `${v.collection}:${v.pk}`));
        if (anomaly === 'none') expect(keys.size).toBe(0);
        else expect([...keys]).toEqual([t.target]);
      }
    }
  });

  it('balances conditions and violation kinds, and alternates condition order', () => {
    for (let p = 0; p < 6; p++) {
      const plan = planTrials(p, ['world', 'table'], 5);
      for (const c of ['world', 'table']) expect(new Set(plan.filter((x) => x.condition === c).map((x) => x.anomaly)).size).toBe(5);
      expect(plan[0].condition).toBe(p % 2 === 0 ? 'world' : 'table');
    }
  });
});

describe('study statistics', () => {
  it('computes exact Wilcoxon p-values', () => {
    expect(wilcoxon([1, 2, 3, 4, 5, 6]).p).toBeCloseTo(2 / 64, 10);
    expect(wilcoxon([-1, -2, -3, -4, -5, -6, -7, -8, -9, -10]).p).toBeCloseTo(2 / 1024, 10);
    const balanced = wilcoxon([1, -1, 2, -2, 3, -3]);
    expect(balanced.p).toBe(1);
    expect(wilcoxon([0, 0]).n).toBe(0);
  });

  it('reports medians, bootstrap intervals and the 50% KPI from paired participants', () => {
    expect(median([5, 1, 3])).toBe(3);
    const [lo, hi] = bootstrapMedianCI([0.3, 0.35, 0.4, 0.32, 0.38, 0.36, 0.31, 0.34]);
    expect(lo).toBeGreaterThan(0.29);
    expect(hi).toBeLessThan(0.41);
    const recs: StudyRecord[] = [];
    for (let p = 0; p < 14; p++) {
      recs.push({ type: 'session', participant: p, session: `s${p}`, background: { developer: 'none' } }, { type: 'complete', participant: p });
      for (let i = 0; i < 4; i++) {
        const base = { type: 'trial' as const, participant: p, session: `s${p}`, practice: false, anomaly: 'negative_stock', diagnoseCorrect: true, gaveUp: false, timedOut: false };
        recs.push({ ...base, condition: 'world', locateCorrect: true, timeMs: 4000 + p * 100 + i * 50 });
        recs.push({ ...base, condition: 'table', locateCorrect: i !== 3, timeMs: 12000 + p * 300 + i * 100 });
      }
    }
    const r = analyzeStudy(recs);
    const world = r.conditions.find((c) => c.condition === 'world')!;
    const table = r.conditions.find((c) => c.condition === 'table')!;
    expect(world.locateAccuracy).toBe(1);
    expect(table.locateAccuracy).toBe(0.75);
    const cmp = r.comparisons[0];
    expect(cmp.participants).toBe(14);
    expect(cmp.medianRatio).toBeLessThan(0.4);
    expect(cmp.test.p).toBeLessThan(0.001);
    expect(cmp.kpi50).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe('study server', () => {
  it('keeps answers on the server, scores them, and logs one JSONL line per event', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-test-'));
    const srv = await startStudyServer({ port: 0, staticDir: dataDir, dataDir, perCondition: 5, practicePerCondition: 1 });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = async (p: string, body: unknown) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    try {
      const info = (await (await post('/api/study/session', { developer: 'none', dashboards: 3 })).json()) as { session: string; total: number };
      expect(info.total).toBe(12);
      const t = (await (await fetch(`${base}/api/study/trial?session=${info.session}&key=0`)).json()) as Record<string, unknown>;
      expect(t.oracle).toBeUndefined();
      expect(t.practice).toBe(true);
      // 연습 과제: 정답을 알려준다
      const fb = (await (await post('/api/study/answer', { session: info.session, key: 0, answer: 'products:999', choice: 'negative_stock', timeMs: 1234, selections: [{ t: 500, key: 'products:999' }] })).json()) as { locateCorrect: boolean; target: string };
      expect(fb.locateCorrect).toBe(false);
      expect(typeof fb.target).toBe('string');
      expect((await post('/api/study/answer', { session: info.session, key: 0, answer: null, choice: 'none', timeMs: 1 })).status).toBe(409);
      // 본 과제: 채점 결과를 돌려주지 않는다
      const real = (await (await post('/api/study/answer', { session: info.session, key: 1, answer: null, choice: 'none', timeMs: 2000 })).json()) as Record<string, unknown>;
      expect(real).toEqual({ ok: true });
      expect((await post('/api/study/answer', { session: 'nope', key: 1 })).status).toBe(404);
      const recs = readStudyRecords(dataDir);
      expect(recs.map((r) => r.type)).toEqual(['session', 'trial', 'trial']);
      expect(recs[1]).toMatchObject({ locateCorrect: false, timeMs: 1234, selections: 1, wrongSelections: 1 });
    } finally {
      await srv.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('running a study', () => {
  async function server(extra: Record<string, unknown> = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ops-'));
    const srv = await startStudyServer({ port: 0, staticDir: dataDir, dataDir, perCondition: 5, practicePerCondition: 1, adminToken: 'secret-token', ...extra });
    const base = `http://127.0.0.1:${srv.port}`;
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    /** 참가자 한 명을 끝까지(모든 과제에 '없음' 으로 답하고 설문까지) */
    const participant = async (bg: Record<string, unknown>) => {
      const info = (await (await post('/api/study/session', bg)).json()) as { session: string; total: number };
      for (let key = 0; key < info.total; key++) await post('/api/study/answer', { session: info.session, key, answer: null, choice: 'none', timeMs: 1000 + key });
      await post('/api/study/questionnaire', { session: info.session, condition: 'final', final: true, preference: 'same' });
      return info;
    };
    return { srv, dataDir, base, post, participant, done: async () => (await srv.close(), fs.rmSync(dataDir, { recursive: true, force: true })) };
  }

  it('protects the experimenter view and keeps pilot, excluded and unfinished sessions out of the analysis', async () => {
    const t = await server();
    try {
      expect((await fetch(`${t.base}/api/study/admin/sessions`)).status).toBe(403);
      expect((await fetch(`${t.base}/study/admin?token=wrong`)).status).toBe(403);
      expect((await fetch(`${t.base}/study/admin?token=secret-token`)).status).toBe(200);
      await t.participant({ developer: 'none', pilot: true });
      await t.participant({ developer: 'none' });
      await t.participant({ developer: 'work' });
      await t.post('/api/study/session', { developer: 'none' }); // 시작만 하고 그만둔 참가자
      const admin = { 'x-study-admin': 'secret-token' };
      expect((await t.post('/api/study/admin/exclude', { participant: 2, reason: '' }, admin)).status).toBe(400);
      expect((await t.post('/api/study/admin/exclude', { participant: 2, reason: '과제 설명을 이해하지 못함(사전 기준 3)' }, admin)).status).toBe(200);
      const list = (await (await fetch(`${t.base}/api/study/admin/sessions`, { headers: admin })).json()) as { sessions: { participant: number; pilot: boolean; complete: boolean; excluded: string | null }[] };
      expect(list.sessions.map((s) => [s.participant, s.pilot, s.complete, !!s.excluded])).toEqual([[0, true, true, false], [1, false, true, false], [2, false, true, true], [3, false, false, false]]);
      const records = readStudyRecords(t.dataDir);
      expect(analyzeStudy(records).participants).toBe(1); // 1번만: 0 예비, 2 제외, 3 미완료
      expect(analyzeStudy(records, { includePilot: true }).participants).toBe(2);
      const csv = studyCsv(records).trim().split('\n');
      expect(csv[0]).toContain('participant,group');
      expect(csv.length - 1).toBe(10); // 1번 참가자의 본 과제 10개
      const report = (await (await fetch(`${t.base}/api/study/admin/report`, { headers: admin })).json()) as { markdown: string };
      expect(report.markdown).toContain('분석에서 빠졌습니다');
    } finally {
      await t.done();
    }
  });

  it('deletes a withdrawn participant and never reuses their number', async () => {
    const t = await server();
    try {
      await t.participant({ developer: 'none' });
      await t.participant({ developer: 'none' });
      const admin = { 'x-study-admin': 'secret-token' };
      expect((await (await t.post('/api/study/admin/withdraw', { participant: 1 }, admin)).json())).toMatchObject({ ok: true, deleted: 1 });
      expect(readStudyRecords(t.dataDir).some((r) => r.participant === 1)).toBe(false);
      expect(fs.readFileSync(path.join(t.dataDir, 'withdrawals.log'), 'utf8')).toMatch(/p1 기록 1개 삭제/);
      const next = (await (await t.post('/api/study/session', { developer: 'none' })).json()) as { participant: number };
      expect(next.participant).toBe(2);
    } finally {
      await t.done();
    }
  });

  it('requires an access code when one is set, and refuses to open on an external address without one', async () => {
    const t = await server({ accessCode: 'tiger-42' });
    try {
      expect(await (await fetch(`${t.base}/api/study/config`)).json()).toEqual({ requiresCode: true, task: 'locate' });
      expect((await t.post('/api/study/session', { developer: 'none', code: 'nope' })).status).toBe(403);
      expect((await t.post('/api/study/session', { developer: 'none', code: 'tiger-42' })).status).toBe(200);
    } finally {
      await t.done();
    }
    await expect(startStudyServer({ port: 0, host: '0.0.0.0', staticDir: os.tmpdir(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'study-ext-')) })).rejects.toThrow(/참가 코드/);
  });

  it('estimates power for the KPI criterion', () => {
    const strong = studyPower({ n: 30, trueRatio: 0.3, logSd: 0.4, sims: 60 });
    const none = studyPower({ n: 30, trueRatio: 1, logSd: 0.4, sims: 60 });
    expect(strong.kpi).toBeGreaterThan(0.8);
    expect(none.kpi).toBe(0);
    expect(none.wilcoxon).toBeLessThan(0.2);
  });
});
