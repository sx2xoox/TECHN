import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudyServer, STUDY_CONDITIONS, STUDY_TASKS, type StudyCondition, type StudyTask } from '@isomorph/server';

/**
 * 사용자 실험 서버를 띄운다. 참가자는 브라우저에서 http://127.0.0.1:4100/study 를 연다.
 *   npm run build && npm run study
 *   STUDY_CONDITIONS=world,table,table+alerts STUDY_PER_CONDITION=5 npm run study
 *   원격: HOST=0.0.0.0 STUDY_ACCESS_CODE=<참가 코드> npm run study  (외부 주소는 참가 코드 필수)
 *   근본 원인 찾기 과제: STUDY_TASK=rca STUDY_CONDITIONS=world,table,table+alerts STUDY_DATA=data/study-rca npm run study
 *     (+ STUDY_RCA_HARD=1: 조건마다 엔진이 끝까지 못 가는 과제를 하나 더 — 엔진을 과신하는지 잰다)
 * 기록: data/study/*.jsonl   분석: npm run study:analyze
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conditions = (process.env.STUDY_CONDITIONS ?? 'world,table').split(',').map((s) => s.trim()) as StudyCondition[];
for (const c of conditions) if (!STUDY_CONDITIONS.includes(c)) throw new Error(`알 수 없는 조건: ${c} (가능: ${STUDY_CONDITIONS.join(', ')})`);
const task = (process.env.STUDY_TASK ?? 'locate') as StudyTask;
if (!STUDY_TASKS.includes(task)) throw new Error(`알 수 없는 과제 종류: ${task} (가능: ${STUDY_TASKS.join(', ')})`);
const srv = await startStudyServer({
  task,
  rcaHard: process.env.STUDY_RCA_HARD === '1',
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: path.join(root, 'packages/client/dist'),
  dataDir: path.resolve(process.env.STUDY_DATA ?? path.join(root, 'data/study')),
  conditions,
  perCondition: process.env.STUDY_PER_CONDITION ? Number(process.env.STUDY_PER_CONDITION) : undefined,
  practicePerCondition: Number(process.env.STUDY_PRACTICE ?? 1),
  timeLimitMs: process.env.STUDY_TIME_LIMIT_MS ? Number(process.env.STUDY_TIME_LIMIT_MS) : undefined,
  accessCode: process.env.STUDY_ACCESS_CODE || undefined,
  adminToken: process.env.STUDY_ADMIN_TOKEN || undefined,
  log: (m) => console.log(m),
});
console.log(`참가자 화면: ${srv.url}  (과제: ${task} · 조건: ${conditions.join(' / ')}${process.env.STUDY_ACCESS_CODE ? ' · 참가 코드 필요' : ''})`);
console.log(`예비(파일럿) 참가자: ${srv.url}?pilot=1  — 본 분석에서 자동으로 빠집니다`);
console.log(`진행자 화면(참가자에게 보이지 않게): ${srv.adminUrl}`);
