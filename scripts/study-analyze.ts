import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudy, readStudyRecords, studyCsv, studyReportMarkdown } from '@isomorph/server';

/**
 * 실험 기록 분석: npm run study:analyze [-- 기록폴더] [--out report.md] [--csv trials.csv] [--pilot] [--include-incomplete]
 * 기본: 예비(파일럿)·제외·미완료 참가자를 뺀다(사전 등록한 기준).
 * 전체와 함께 '개발자가 아닌 참가자(none)' 만 따로 분석한다(기획안 KPI 의 대상).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1]) : null;
};
const valued = new Set(['--out', '--csv']);
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1])) ?? path.join(root, 'data/study'));
const filter = { includePilot: args.includes('--pilot'), completeOnly: !args.includes('--include-incomplete') };
const records = readStudyRecords(dir);
if (!records.length) {
  console.error(`기록이 없습니다: ${dir}`);
  process.exit(1);
}
const md = [studyReportMarkdown(analyzeStudy(records, filter), '사용자 실험 결과 — 전체'), studyReportMarkdown(analyzeStudy(records, { ...filter, group: 'none' }), '개발자가 아닌 참가자만')].join('\n\n');
console.log(md);
const out = opt('--out');
if (out) fs.writeFileSync(out, md);
const csv = opt('--csv');
if (csv) {
  fs.writeFileSync(csv, `﻿${studyCsv(records, filter)}`);
  console.log(`\n과제 단위 CSV: ${csv}`);
}
