import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudyServer, STUDY_CONDITIONS, type StudyCondition } from '@isomorph/server';

/**
 * 사용자 실험 서버를 띄운다. 참가자는 브라우저에서 http://127.0.0.1:4100/study 를 연다.
 *   npm run build && npm run study
 *   STUDY_CONDITIONS=world,table,table+alerts STUDY_PER_CONDITION=5 npm run study
 * 기록: data/study/*.jsonl   분석: npm run study:analyze
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conditions = (process.env.STUDY_CONDITIONS ?? 'world,table').split(',').map((s) => s.trim()) as StudyCondition[];
for (const c of conditions) if (!STUDY_CONDITIONS.includes(c)) throw new Error(`알 수 없는 조건: ${c} (가능: ${STUDY_CONDITIONS.join(', ')})`);
const srv = await startStudyServer({
  port: Number(process.env.PORT ?? 4100),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: path.join(root, 'packages/client/dist'),
  dataDir: path.resolve(process.env.STUDY_DATA ?? path.join(root, 'data/study')),
  conditions,
  perCondition: Number(process.env.STUDY_PER_CONDITION ?? 5),
  practicePerCondition: Number(process.env.STUDY_PRACTICE ?? 1),
  timeLimitMs: Number(process.env.STUDY_TIME_LIMIT_MS ?? 120_000),
  log: (m) => console.log(m),
});
console.log(`사용자 실험: ${srv.url}  (조건: ${conditions.join(' / ')})`);
