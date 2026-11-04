import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildLegend, type WorldGrammar, type SystemSchema } from '@isomorph/core';
import { serveFile } from './server.ts';
import { makeTrial, planTrials, STUDY_ANOMALIES, STUDY_CHOICES, STUDY_RULES, studyGrammar, type StudyAnomaly, type StudyTrial } from './study-data.ts';

/**
 * 사용자 실험 서버: "비개발자가 대시보드(표)보다 이 세계에서 규칙 위반을 더 빨리·정확히 찾는가"
 *  - 참가자 안 비교(within-subject): 모든 참가자가 모든 조건을 겪고, 조건 순서와 과제 배정을 돌려 맞춘다.
 *  - 정답은 서버에만 있다. 클라이언트는 고른 것과 시간만 보내고, 채점은 서버가 한다.
 *  - 기록: dataDir/<세션>.jsonl (한 줄 = 한 사건). 이름·연락처는 받지 않는다.
 */

export type StudyCondition = 'world' | 'table' | 'table+alerts';
export const STUDY_CONDITIONS: StudyCondition[] = ['world', 'table', 'table+alerts'];

export interface StudyOptions {
  port?: number;
  host?: string;
  /** 빌드된 클라이언트(study.html 포함) */
  staticDir: string;
  dataDir: string;
  conditions?: StudyCondition[];
  /** 조건마다 본 과제 수(기본 5 = 위반 4종 + 없음 1) */
  perCondition?: number;
  /** 조건마다 연습 과제 수(정답을 알려준다) */
  practicePerCondition?: number;
  /** 과제 하나의 제한 시간 */
  timeLimitMs?: number;
  /** 자가 시험용: 과제에 정답을 실어 보낸다(실제 실험에서는 절대 켜지 않는다) */
  exposeAnswers?: boolean;
  log?: (msg: string) => void;
}

interface Session {
  id: string;
  participant: number;
  createdAt: number;
  trials: StudyTrial[];
  answered: Set<number>;
  file: string;
}

export interface TrialPayload {
  key: number;
  index: number;
  total: number;
  practice: boolean;
  condition: StudyCondition;
  rows: StudyTrial['snapshot']['collections'];
  world: StudyTrial['world'];
  /** table+alerts 조건에서만: 규칙을 어긴 행 */
  alerts?: string[];
  oracle?: { target: string | null; anomaly: StudyAnomaly };
}

function seedFor(participant: number, key: number) {
  let h = 2166136261 ^ (participant * 7919 + key * 104729);
  h = Math.imul(h ^ (h >>> 13), 16777619);
  return (h ^ (h >>> 16)) >>> 0;
}

export async function startStudyServer(opts: StudyOptions) {
  const log = opts.log ?? (() => {});
  const conditions = opts.conditions ?? ['world', 'table'];
  const perCondition = opts.perCondition ?? 5;
  const practice = opts.practicePerCondition ?? 1;
  const timeLimitMs = opts.timeLimitMs ?? 120_000;
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const { schema, grammar } = studyGrammar();
  const sessions = new Map<string, Session>();

  const nextParticipant = () => fs.readdirSync(opts.dataDir).filter((f) => f.endsWith('.jsonl')).length + sessions.size;

  function createSession(): Session {
    const id = randomUUID();
    const participant = nextParticipant();
    const trials: StudyTrial[] = [];
    const plan = planTrials(participant, conditions, perCondition);
    let key = 0;
    for (const condition of conditions.map((_, i) => conditions[(i + participant) % conditions.length])) {
      for (let p = 0; p < practice; p++) {
        const anomaly = STUDY_ANOMALIES[(p + participant) % 4];
        trials.push(makeTrial({ index: -1, practice: true, condition, anomaly, seed: seedFor(participant, 1000 + key), grammar, schema }));
        key++;
      }
      plan.filter((x) => x.condition === condition).forEach((x) => {
        trials.push(makeTrial({ index: trials.filter((t) => !t.practice).length, practice: false, condition, anomaly: x.anomaly, seed: seedFor(participant, key), grammar, schema }));
        key++;
      });
    }
    const s: Session = { id, participant, createdAt: Date.now(), trials, answered: new Set(), file: path.join(opts.dataDir, `${new Date().toISOString().slice(0, 10)}-p${String(participant).padStart(3, '0')}-${id.slice(0, 8)}.jsonl`) };
    sessions.set(id, s);
    return s;
  }

  const record = (s: Session, entry: Record<string, unknown>) => fs.appendFileSync(s.file, `${JSON.stringify({ ts: Date.now(), session: s.id, participant: s.participant, ...entry })}\n`);

  const payload = (s: Session, key: number): TrialPayload => {
    const t = s.trials[key];
    const condition = t.condition as StudyCondition;
    return {
      key,
      index: t.index,
      total: s.trials.length,
      practice: t.practice,
      condition,
      rows: t.snapshot.collections,
      world: t.world,
      ...(condition === 'table+alerts' ? { alerts: [...new Set(t.world.violations.map((v) => `${v.collection}:${v.pk}`))] } : {}),
      ...(opts.exposeAnswers ? { oracle: { target: t.target, anomaly: t.anomaly } } : {}),
    };
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1_000_000) reject(new Error('too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/api/study/session') {
        const body = await readBody(req);
        const s = createSession();
        record(s, {
          type: 'session',
          conditions: s.trials.filter((t, i, a) => a.findIndex((x) => x.condition === t.condition) === i).map((t) => t.condition),
          perCondition,
          practice,
          timeLimitMs,
          background: { developer: String(body.developer ?? ''), dashboards: Number(body.dashboards ?? 0), ageBand: String(body.ageBand ?? '') },
          userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
        });
        log(`참가자 ${s.participant} 시작 (${s.file})`);
        return json(res, 200, {
          session: s.id,
          participant: s.participant,
          total: s.trials.length,
          timeLimitMs,
          rules: STUDY_RULES,
          choices: STUDY_CHOICES,
          grammar: grammar as WorldGrammar,
          legend: buildLegend(grammar, schema as SystemSchema),
          schema,
        });
      }
      const body = req.method === 'POST' && url.pathname.startsWith('/api/study/') ? await readBody(req) : {};
      const s = sessions.get(String(body.session ?? url.searchParams.get('session') ?? ''));
      if (url.pathname.startsWith('/api/study/') && !s) return json(res, 404, { error: '세션이 없습니다' });
      if (req.method === 'GET' && url.pathname === '/api/study/trial') {
        const key = Number(url.searchParams.get('key'));
        if (!Number.isInteger(key) || key < 0 || key >= s!.trials.length) return json(res, 400, { error: '잘못된 과제 번호' });
        return json(res, 200, payload(s!, key));
      }
      if (req.method === 'POST' && url.pathname === '/api/study/answer') {
        const b = body;
        const key = Number(b.key);
        const t = s!.trials[key];
        if (!t) return json(res, 400, { error: '잘못된 과제 번호' });
        if (s!.answered.has(key)) return json(res, 409, { error: '이미 답한 과제입니다' });
        s!.answered.add(key);
        const answer = typeof b.answer === 'string' ? b.answer : null;
        const choice = (STUDY_ANOMALIES as readonly string[]).includes(String(b.choice)) ? (String(b.choice) as StudyAnomaly) : null;
        const gaveUp = !!b.gaveUp;
        const timedOut = !!b.timedOut;
        const selections = Array.isArray(b.selections) ? (b.selections as { t: number; key: string }[]).filter((x) => typeof x?.t === 'number' && typeof x?.key === 'string').slice(0, 500) : [];
        // 정답: 위반이 있는 과제는 그 행을 고르고, 없는 과제는 '어긴 곳이 없다' 를 고른다
        const locate = t.target ? answer === t.target : answer === null && choice === 'none';
        const diagnose = choice === t.anomaly;
        const firstHit = t.target ? selections.find((x) => x.key === t.target)?.t ?? null : null;
        record(s!, {
          type: 'trial',
          key,
          index: t.index,
          practice: t.practice,
          condition: t.condition,
          anomaly: t.anomaly,
          target: t.target,
          seed: t.seed,
          answer,
          choice,
          locateCorrect: locate,
          diagnoseCorrect: diagnose,
          timeMs: Number(b.timeMs) || null,
          firstHitMs: firstHit,
          selections: selections.length,
          wrongSelections: selections.filter((x) => x.key !== t.target).length,
          gaveUp,
          timedOut,
          viewport: typeof b.viewport === 'string' ? b.viewport.slice(0, 20) : null,
        });
        // 연습 과제에서만 정답을 알려준다(본 과제에서 알려주면 학습 효과가 섞인다)
        return json(res, 200, t.practice ? { locateCorrect: locate, diagnoseCorrect: diagnose, target: t.target, anomaly: t.anomaly } : { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/study/questionnaire') {
        const b = body;
        const clamp = (x: unknown) => Math.max(1, Math.min(7, Math.round(Number(x) || 0))) || null;
        record(s!, {
          type: 'questionnaire',
          condition: String(b.condition ?? ''),
          effort: clamp(b.effort),
          confidence: clamp(b.confidence),
          ...(b.final ? { final: true, preference: String(b.preference ?? '').slice(0, 20), comment: String(b.comment ?? '').slice(0, 2000) } : {}),
        });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/' || url.pathname === '/study') {
        if (serveFile(res, opts.staticDir, 'study.html')) return;
      } else if (serveFile(res, opts.staticDir, url.pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found (npm run build 로 study.html 을 만들었는지 확인하세요)');
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4100, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 4100;
  return {
    port,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/study`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
