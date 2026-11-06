import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { buildLegend, type WorldGrammar, type SystemSchema } from '@isomorph/core';
import { serveFile } from './server.ts';
import { analyzeStudy, readStudyRecords, studyCsv, studyReportMarkdown, type SessionRecord, type StudyRecord } from './study-analysis.ts';
import { makeTrial, planTrials, STUDY_ANOMALIES, STUDY_CHOICES, STUDY_RULES, studyGrammar, type StudyTrial } from './study-data.ts';
import { makeRcaScene, planRcaTrials, RCA_CHOICES, RCA_GLOSSARY, RCA_KINDS, RCA_RULES, rcaEngineOutcome, rcaGrammar, type RcaFault, type RcaInsight, type RcaKind, type RcaLogEntry } from './study-rca.ts';

/**
 * 사용자 실험 서버: "비개발자가 대시보드(표)보다 이 세계에서 규칙 위반을 더 빨리·정확히 찾는가"
 *  - 참가자 안 비교(within-subject): 모든 참가자가 모든 조건을 겪고, 조건 순서와 과제 배정을 돌려 맞춘다.
 *  - 정답은 서버에만 있다. 클라이언트는 고른 것과 시간만 보내고, 채점은 서버가 한다.
 *    (세계 조건은 이상 현상을 그리기 위해 개체별 모습을 받는다 — 그것을 보여주는 것이 그 조건의 처치다.)
 *  - 기록: dataDir/<세션>.jsonl (한 줄 = 한 사건). 이름·연락처는 받지 않는다.
 */

export type StudyCondition = 'world' | 'table' | 'table+alerts';
export type StudyTask = 'locate' | 'rca';
export const STUDY_TASKS: StudyTask[] = ['locate', 'rca'];
export const STUDY_CONDITIONS: StudyCondition[] = ['world', 'table', 'table+alerts'];

export interface StudyOptions {
  port?: number;
  host?: string;
  /** 빌드된 클라이언트(study.html 포함) */
  staticDir: string;
  dataDir: string;
  conditions?: StudyCondition[];
  /**
   * 과제 종류(서버 하나에 한 종류):
   *  - locate(기본): 쇼핑몰 데이터에서 규칙을 어긴 곳 찾기
   *  - rca: 클러스터+서비스로 번진 장애에서 근본 원인 찾기(변경 기록을 모든 조건에 준다)
   */
  task?: StudyTask;
  /**
   * 근본 원인 찾기만: 조건마다 '엔진이 끝까지 못 가는' 과제를 하나 더 넣는다(노드 감시 지연: 사슬이 서비스에서 멈추고, 참된 원인은 노드).
   * 사람이 엔진의 답을 그대로 믿는지(과신)를 잰다. 주 분석에서는 빼고 따로 보고한다.
   */
  rcaHard?: boolean;
  /** 조건마다 본 과제 수(기본: locate 5 = 위반 4종 + 없음 1, rca 3 = 원인 3종) */
  perCondition?: number;
  /** 조건마다 연습 과제 수(정답을 알려준다) */
  practicePerCondition?: number;
  /** 과제 하나의 제한 시간 */
  timeLimitMs?: number;
  /** 자가 시험용: 과제에 정답을 실어 보낸다(실제 실험에서는 절대 켜지 않는다) */
  exposeAnswers?: boolean;
  /** 진행자 화면(/study/admin) 토큰. 없으면 시작할 때 무작위로 만든다 */
  adminToken?: string;
  /** 참가 코드: 원격 실험에서 아무나 참여하지 못하게(외부 주소로 열 때는 필수) */
  accessCode?: string;
  log?: (msg: string) => void;
}

interface Session {
  id: string;
  participant: number;
  createdAt: number;
  trials: StudyTrial[];
  answered: Set<number>;
  /** 이미 답한 설문(조건마다 한 번, 마지막 설문 한 번) */
  surveyed: Set<string>;
  file: string;
}

/** 동시에 진행 중인 세션 수와 한 세션의 수명(참가 코드 하나를 여럿이 써도 메모리가 무한히 늘지 않게) */
const MAX_LIVE_SESSIONS = 50;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface TrialPayload {
  key: number;
  index: number;
  total: number;
  practice: boolean;
  condition: StudyCondition;
  rows: StudyTrial['snapshot']['collections'];
  world: StudyTrial['world'] | null;
  /** table+alerts 조건에서만: 규칙을 어긴 행 */
  alerts?: string[];
  oracle?: { target: string | null; anomaly: string };
  /** 근본 원인 찾기만 */
  task?: 'rca';
  log?: RcaLogEntry[];
  /** 세계와 표+위반 강조 조건만: 엔진이 계산한 살펴보기(진단·근본 원인 사슬·직전 변경) */
  insights?: Record<string, RcaInsight>;
  symptom?: string;
}

function seedFor(participant: number, key: number) {
  let h = 2166136261 ^ (participant * 7919 + key * 104729);
  h = Math.imul(h ^ (h >>> 13), 16777619);
  return (h ^ (h >>> 16)) >>> 0;
}

export async function startStudyServer(opts: StudyOptions) {
  const log = opts.log ?? (() => {});
  const conditions = opts.conditions ?? ['world', 'table'];
  const task: StudyTask = opts.task ?? 'locate';
  if (!STUDY_TASKS.includes(task)) throw new Error(`알 수 없는 과제 종류: ${task} (가능: ${STUDY_TASKS.join(', ')})`);
  const rca = task === 'rca';
  const perCondition = opts.perCondition ?? (rca ? 3 : 5);
  const practice = opts.practicePerCondition ?? 1;
  const timeLimitMs = opts.timeLimitMs ?? (rca ? 180_000 : 120_000);
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const loopback = ['127.0.0.1', 'localhost', '::1', undefined].includes(opts.host);
  if (!loopback && !opts.accessCode) throw new Error(`외부 주소(${opts.host})로 실험을 열려면 참가 코드(accessCode / STUDY_ACCESS_CODE)가 필요합니다.`);
  const adminToken = opts.adminToken ?? randomBytes(12).toString('hex');
  const { schema, grammar } = rca ? await rcaGrammar() : studyGrammar();
  const sessions = new Map<string, Session>();

  // 참가 번호는 지운(철회한) 참가자가 있어도 다시 쓰지 않는다(순서 균형과 기록이 섞이지 않게)
  const counterFile = path.join(opts.dataDir, '.next-participant');
  const nextParticipant = () => {
    const fromFiles = fs.readdirSync(opts.dataDir).filter((f) => f.endsWith('.jsonl')).length;
    const stored = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) || 0 : 0;
    const n = Math.max(stored, fromFiles);
    fs.writeFileSync(counterFile, String(n + 1));
    return n;
  };
  const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const isAdmin = (req: http.IncomingMessage, url: URL) => sameSecret(String(req.headers['x-study-admin'] ?? url.searchParams.get('token') ?? ''), adminToken);
  const filesOf = (participant: number) => fs.readdirSync(opts.dataDir).filter((f) => f.endsWith('.jsonl') && f.includes(`-p${String(participant).padStart(3, '0')}-`));
  const appendFor = (participant: number, entry: Record<string, unknown>) => {
    const f = filesOf(participant)[0];
    if (!f) return false;
    fs.appendFileSync(path.join(opts.dataDir, f), `${JSON.stringify({ ts: Date.now(), participant, ...entry })}\n`);
    return true;
  };

  async function rcaTrial(index: number, isPractice: boolean, condition: string, kind: RcaKind, seed: number, fault: RcaFault = 'clean'): Promise<StudyTrial> {
    const sc = await makeRcaScene(kind, seed, Date.now(), fault);
    const engine = rcaEngineOutcome(sc);
    return { index, practice: isPractice, condition, anomaly: kind, target: sc.target, seed, snapshot: sc.snapshot, world: sc.world, task: 'rca', log: sc.log, insights: sc.insights, symptom: sc.symptom, fault, engine: { outcome: engine.outcome, end: engine.end }, ...(fault !== 'clean' ? { hard: true } : {}) };
  }

  async function createSession(): Promise<Session | null> {
    const now = Date.now();
    for (const [sid, x] of sessions) if (now - x.createdAt > SESSION_TTL_MS) sessions.delete(sid);
    if (sessions.size >= MAX_LIVE_SESSIONS) return null;
    const id = randomUUID();
    const participant = nextParticipant();
    const trials: StudyTrial[] = [];
    const plan = rca ? planRcaTrials(participant, conditions, perCondition) : planTrials(participant, conditions, perCondition);
    let key = 0;
    for (const condition of conditions.map((_, i) => conditions[(i + participant) % conditions.length])) {
      for (let p = 0; p < practice; p++) {
        const seed = seedFor(participant, 1000 + key);
        trials.push(rca ? await rcaTrial(-1, true, condition, RCA_KINDS[(p + participant) % RCA_KINDS.length], seed) : makeTrial({ index: -1, practice: true, condition, anomaly: STUDY_ANOMALIES[(p + participant) % 4], seed, grammar, schema }));
        key++;
      }
      const mine = plan.filter((y) => y.condition === condition);
      // 엔진이 끝까지 못 가는 과제는 블록 안 자리를 참가자·조건마다 돌린다(늘 마지막이면 눈치챈다)
      const hardAt = rca && opts.rcaHard ? (participant + conditions.indexOf(condition)) % (mine.length + 1) : -1;
      for (let i = 0; i <= mine.length; i++) {
        if (i === hardAt) {
          trials.push(await rcaTrial(trials.filter((t) => !t.practice).length, false, condition, 'node_down', seedFor(participant, key), 'lag'));
          key++;
        }
        if (i === mine.length) break;
        const x = mine[i];
        const index = trials.filter((t) => !t.practice).length;
        const seed = seedFor(participant, key);
        trials.push(rca ? await rcaTrial(index, false, condition, x.anomaly as RcaKind, seed) : makeTrial({ index, practice: false, condition, anomaly: x.anomaly as (typeof STUDY_ANOMALIES)[number], seed, grammar, schema }));
        key++;
      }
    }
    const s: Session = { id, participant, createdAt: Date.now(), trials, answered: new Set(), surveyed: new Set(), file: path.join(opts.dataDir, `${new Date().toISOString().slice(0, 10)}-p${String(participant).padStart(3, '0')}-${id.slice(0, 8)}.jsonl`) };
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
      rows: t.task === 'rca' ? Object.fromEntries(Object.entries(t.snapshot.collections).filter(([, rows]) => rows.length)) : t.snapshot.collections,
      // 세계 조건만 세계를 받는다. 위반 목록(정답이 적힌 것)은 빼고, 그림에 필요한 개체별 이상 현상만 남긴다.
      // (세계 조건은 그 이상 현상을 '그려 보여주는 것' 자체가 실험 처치다. 표 조건에는 세계를 보내지 않는다.)
      world: condition === 'world' ? { ...t.world, violations: [] } : null,
      ...(condition === 'table+alerts' ? { alerts: [...new Set(t.world.violations.map((v) => `${v.collection}:${v.pk}`))] } : {}),
      ...(opts.exposeAnswers ? { oracle: { target: t.target, anomaly: t.anomaly } } : {}),
      // 근본 원인 찾기: 변경 기록은 모든 조건에(같은 원자료), 엔진이 계산한 살펴보기는 표 조건에만 주지 않는다
      ...(t.task === 'rca' ? { task: 'rca' as const, log: t.log, symptom: t.symptom, ...(condition !== 'table' ? { insights: t.insights } : {}) } : {}),
    };
  };

  /** 요청 본문: 64KiB 를 넘으면 연결을 끊고 더 읽지 않는다(실험 화면이 보내는 것은 아주 작다) */
  const MAX_BODY = 64 * 1024;
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let data = '';
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        data += c;
        if (data.length > MAX_BODY) {
          over = true;
          data = '';
          reject(new Error('요청이 너무 큽니다'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (over) return;
        try {
          resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/study/config') {
        return json(res, 200, { requiresCode: !!opts.accessCode, task });
      }
      if (url.pathname.startsWith('/api/study/admin/') || url.pathname === '/study/admin') {
        if (!isAdmin(req, url)) return json(res, 403, { error: '진행자 토큰이 필요합니다' });
        return await admin(req, res, url);
      }
      if (req.method === 'POST' && url.pathname === '/api/study/session') {
        const body = await readBody(req);
        if (opts.accessCode && !sameSecret(String(body.code ?? ''), opts.accessCode)) return json(res, 403, { error: '참가 코드가 맞지 않습니다' });
        const s = await createSession();
        if (!s) return json(res, 503, { error: '진행 중인 참가자가 너무 많습니다. 잠시 뒤 다시 시도하세요.' });
        record(s, {
          type: 'session',
          pilot: !!body.pilot,
          task,
          conditions: s.trials.filter((t, i, a) => a.findIndex((x) => x.condition === t.condition) === i).map((t) => t.condition),
          perCondition,
          practice,
          timeLimitMs,
          ...(rca && opts.rcaHard ? { rcaHard: true } : {}),
          background: { developer: String(body.developer ?? '').slice(0, 20), dashboards: Math.max(0, Math.min(5, Math.round(Number(body.dashboards) || 0))), ageBand: String(body.ageBand ?? '').slice(0, 20) },
          userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
        });
        log(`참가자 ${s.participant} 시작 (${s.file})`);
        return json(res, 200, {
          session: s.id,
          participant: s.participant,
          total: s.trials.length,
          timeLimitMs,
          task,
          rules: rca ? RCA_RULES : STUDY_RULES,
          choices: rca ? RCA_CHOICES : STUDY_CHOICES,
          ...(rca ? { glossary: RCA_GLOSSARY } : {}),
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
        const choice = ((rca ? RCA_KINDS : STUDY_ANOMALIES) as readonly string[]).includes(String(b.choice)) ? String(b.choice) : null;
        const gaveUp = !!b.gaveUp;
        const timedOut = !!b.timedOut;
        const selections = Array.isArray(b.selections) ? (b.selections as { t: number; key: string }[]).filter((x) => typeof x?.t === 'number' && typeof x?.key === 'string').slice(0, 500) : [];
        // 정답: 위반이 있는 과제는 그 행을 고르고, 없는 과제는 '어긴 곳이 없다' 를 고른다
        const locate = t.target ? answer === t.target : answer === null && choice === 'none';
        const diagnose = choice === t.anomaly;
        const firstHit = t.target ? selections.find((x) => x.key === t.target)?.t ?? null : null;
        record(s!, {
          type: 'trial',
          task,
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
          // 근본 원인 찾기: 엔진의 결과와, 참가자가 엔진이 짚은 곳(사슬의 끝)을 그대로 답했는가
          ...(t.task === 'rca' ? { fault: t.fault ?? 'clean', hard: !!t.hard, engineOutcome: t.engine?.outcome ?? null, followedEngine: t.engine?.end ? answer === t.engine.end : null } : {}),
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
        const surveyKey = b.final ? 'final' : String(b.condition ?? '').slice(0, 20);
        if (s!.surveyed.has(surveyKey)) return json(res, 409, { error: '이미 답한 설문입니다' });
        s!.surveyed.add(surveyKey);
        record(s!, {
          type: 'questionnaire',
          condition: surveyKey,
          effort: clamp(b.effort),
          confidence: clamp(b.confidence),
          ...(b.final ? { final: true, preference: String(b.preference ?? '').slice(0, 20), comment: String(b.comment ?? '').slice(0, 2000) } : {}),
        });
        if (b.final) {
          record(s!, { type: 'complete' });
          log(`참가자 ${s!.participant} 완료`);
        }
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

  /** 진행자 화면과 API: 진행 상황, 제외(사유 기록), 철회(기록 삭제), 보고서, CSV */
  async function admin(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const records = readStudyRecords(opts.dataDir) as StudyRecord[];
    if (req.method === 'GET' && url.pathname === '/api/study/admin/sessions') {
      const list = records
        .filter((r): r is SessionRecord => r.type === 'session')
        .map((s) => {
          const mine = records.filter((r) => r.participant === s.participant);
          return {
            participant: s.participant,
            started: s.ts ?? null,
            pilot: !!s.pilot,
            group: s.background?.developer ?? '',
            order: s.conditions ?? [],
            answered: mine.filter((r) => r.type === 'trial').length,
            complete: mine.some((r) => r.type === 'complete'),
            excluded: (mine.find((r) => r.type === 'exclusion') as { reason?: string } | undefined)?.reason ?? null,
          };
        })
        .sort((a, b) => a.participant - b.participant);
      return json(res, 200, { sessions: list, live: [...sessions.values()].filter((s) => !list.find((l) => l.participant === s.participant && l.complete)).map((s) => s.participant) });
    }
    if (req.method === 'GET' && url.pathname === '/api/study/admin/report') {
      const includePilot = url.searchParams.get('pilot') === '1';
      const md = [studyReportMarkdown(analyzeStudy(records, { includePilot, task }), `전체${rca ? ' — 근본 원인 찾기' : ''}`), studyReportMarkdown(analyzeStudy(records, { includePilot, task, group: 'none' }), '개발자가 아닌 참가자만')].join('\n\n');
      return json(res, 200, { markdown: md });
    }
    if (req.method === 'GET' && url.pathname === '/api/study/admin/export.csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="isomorph-study.csv"', 'cache-control': 'no-store' });
      return res.end(`\ufeff${studyCsv(records, { includePilot: url.searchParams.get('pilot') === '1', task })}`);
    }
    if (req.method === 'POST' && url.pathname === '/api/study/admin/exclude') {
      const b = await readBody(req);
      const reason = String(b.reason ?? '').trim().slice(0, 300);
      if (!reason) return json(res, 400, { error: '제외 사유를 적어 주세요(사전 등록한 기준)' });
      if (!appendFor(Number(b.participant), { type: 'exclusion', reason })) return json(res, 404, { error: '그 참가자의 기록이 없습니다' });
      log(`참가자 ${b.participant} 제외: ${reason}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/study/admin/withdraw') {
      const b = await readBody(req);
      const participant = Number(b.participant);
      const files = filesOf(participant);
      if (!files.length) return json(res, 404, { error: '그 참가자의 기록이 없습니다' });
      for (const f of files) fs.rmSync(path.join(opts.dataDir, f));
      for (const [id, s] of sessions) if (s.participant === participant) sessions.delete(id);
      // 감사 기록에는 번호와 시각만 남긴다(내용은 남기지 않는다)
      fs.appendFileSync(path.join(opts.dataDir, 'withdrawals.log'), `${new Date().toISOString()} p${participant} 기록 ${files.length}개 삭제\n`);
      log(`참가자 ${participant} 철회: 기록 삭제`);
      return json(res, 200, { ok: true, deleted: files.length });
    }
    if (req.method === 'GET' && url.pathname === '/study/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(ADMIN_HTML);
    }
    return json(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4100, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 4100;
  return {
    port,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}/study`,
    adminUrl: `http://${opts.host ?? '127.0.0.1'}:${port}/study/admin?token=${adminToken}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 진행자 화면: 외부 스크립트 없이 한 장으로 */
const ADMIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ISOMORPH 실험 진행자</title>
<style>
body{font-family:system-ui,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;background:#1c1722;color:#f3ede2;margin:0;padding:16px 24px;font-size:14px}
h1{font-size:18px}h2{font-size:15px;margin-top:24px}table{border-collapse:collapse;width:100%;max-width:1100px}
th,td{border:1px solid #4a4356;padding:4px 8px;text-align:left}th{background:#342d3e}.muted{color:#a99fb5}.bad{color:#ff6b57}.ok{color:#5bbf4a}
button,input{font:inherit;background:#342d3e;color:inherit;border:1px solid #4a4356;padding:3px 8px}button{cursor:pointer}pre{white-space:pre-wrap;background:#2b2533;padding:12px;max-width:1100px}
a{color:#8fb8ff}
</style></head><body>
<h1>ISOMORPH 사용자 실험 — 진행자 화면</h1>
<p class="muted">이 화면의 주소(토큰)는 참가자에게 보이지 않게 하세요. 제외는 사전 등록한 기준에 따라서만, 철회는 참가자가 요청할 때만 쓰세요.</p>
<p><a id="csv" href="#">CSV 내려받기(본 과제, 예비·제외·미완료 뺌)</a> · <label><input type="checkbox" id="pilot"> 예비 참가자 포함해 보기</label></p>
<h2>참가자</h2><table id="t"><thead><tr><th>번호</th><th>시작</th><th>개발 경험</th><th>조건 순서</th><th>답한 과제</th><th>상태</th><th></th></tr></thead><tbody></tbody></table>
<h2>보고서</h2><pre id="r">불러오는 중…</pre>
<script>
const token = new URLSearchParams(location.search).get('token');
const H = { 'x-study-admin': token, 'content-type': 'application/json' };
const api = (p, o = {}) => fetch(p, { ...o, headers: H }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
function el(tag, attrs, ...kids) { const e = document.createElement(tag); Object.assign(e, attrs || {}); for (const k of kids) e.append(k); return e; }
async function load() {
  const pilot = document.getElementById('pilot').checked ? '1' : '0';
  document.getElementById('csv').href = '/api/study/admin/export.csv?token=' + encodeURIComponent(token) + '&pilot=' + pilot;
  const { sessions, live } = await api('/api/study/admin/sessions');
  const tb = document.querySelector('#t tbody'); tb.replaceChildren();
  for (const s of sessions) {
    const state = s.excluded ? el('span', { className: 'bad', textContent: '제외: ' + s.excluded }) : s.complete ? el('span', { className: 'ok', textContent: '완료' }) : el('span', { className: 'muted', textContent: live.includes(s.participant) ? '진행 중' : '중단' });
    const ex = el('button', { textContent: '제외', onclick: async () => { const reason = prompt('제외 사유(사전 등록한 기준)'); if (reason) { await api('/api/study/admin/exclude', { method: 'POST', body: JSON.stringify({ participant: s.participant, reason }) }); load(); } } });
    const wd = el('button', { textContent: '철회(기록 삭제)', onclick: async () => { if (confirm('참가자 ' + s.participant + '의 기록을 모두 지웁니다. 참가자가 철회를 요청했나요?')) { await api('/api/study/admin/withdraw', { method: 'POST', body: JSON.stringify({ participant: s.participant }) }); load(); } } });
    tb.append(el('tr', {}, el('td', { textContent: s.participant + (s.pilot ? ' (예비)' : '') }), el('td', { textContent: s.started ? new Date(s.started).toLocaleString('ko-KR') : '' }), el('td', { textContent: s.group }), el('td', { textContent: s.order.join(' → ') }), el('td', { textContent: s.answered }), el('td', {}, state), el('td', {}, ex, ' ', wd)));
  }
  const { markdown } = await api('/api/study/admin/report?pilot=' + pilot);
  document.getElementById('r').textContent = markdown;
}
document.getElementById('pilot').onchange = load;
load().catch((e) => (document.getElementById('r').textContent = '오류: ' + e.message));
setInterval(() => load().catch(() => {}), 10000);
</script></body></html>`;
