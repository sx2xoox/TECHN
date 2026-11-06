import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudy, readStudyRecords, studyCsv, studyReportMarkdown, studyTasks } from '@isomorph/server';

/**
 * 실험 기록 분석: npm run study:analyze [-- 기록폴더] [--out report.md] [--csv trials.csv] [--pilot] [--include-incomplete] [--task locate|rca]
 * 기본: 예비(파일럿)·제외·미완료 참가자를 뺀다(사전 등록한 기준).
 * 과제 종류(위반 찾기 locate · 근본 원인 찾기 rca)는 섞지 않고 따로 분석한다(--task 가 없으면 기록에 있는 종류마다).
 * 전체와 함께 '개발자가 아닌 참가자(none)' 만 따로 분석한다(기획안 KPI 의 대상).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1]) : null;
};
const valued = new Set(['--out', '--csv', '--task']);
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? path.join(root, 'data/study'));
const filter = { includePilot: args.includes('--pilot'), completeOnly: !args.includes('--include-incomplete') };
const records = readStudyRecords(dir);
if (!records.length) {
  console.error(`기록이 없습니다: ${dir}`);
  process.exit(1);
}
const TASK_KO: Record<string, string> = { locate: '규칙을 어긴 곳 찾기', rca: '근본 원인 찾기' };
const taskArg = args.includes('--task') ? args[args.indexOf('--task') + 1] : null;
const tasks = taskArg ? [taskArg] : studyTasks(records);
const md = tasks
  .flatMap((task) => [
    studyReportMarkdown(analyzeStudy(records, { ...filter, task }), `사용자 실험 결과 — ${TASK_KO[task] ?? task} — 전체`),
    studyReportMarkdown(analyzeStudy(records, { ...filter, task, group: 'none' }), `${TASK_KO[task] ?? task} — 개발자가 아닌 참가자만`),
  ])
  .join('\n\n');
console.log(md);
const out = opt('--out');
if (out) fs.writeFileSync(out, md);
const csv = opt('--csv');
if (csv) {
  // 과제마다 한 파일(여럿이면 이름 뒤에 과제 종류를 붙인다)
  for (const task of tasks) {
    const file = tasks.length > 1 ? csv.replace(/(\.csv)?$/, `-${task}.csv`) : csv;
    fs.writeFileSync(file, `﻿${studyCsv(records, { ...filter, task })}`);
    console.log(`\n과제 단위 CSV(${TASK_KO[task] ?? task}): ${file}`);
  }
}
