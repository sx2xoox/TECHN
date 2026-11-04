import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeStudy, bootstrapMedianCI, makeTrial, median, planTrials, readStudyRecords, startStudyServer, STUDY_ANOMALIES, studyGrammar, wilcoxon, type StudyRecord } from '../src/index.ts';

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
      recs.push({ type: 'session', participant: p, session: `s${p}`, background: { developer: 'none' } });
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
