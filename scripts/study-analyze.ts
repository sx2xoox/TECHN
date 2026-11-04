import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudy, readStudyRecords, studyReportMarkdown } from '@isomorph/server';

/**
 * 실험 기록 분석: npm run study:analyze [-- 기록폴더] [--out report.md]
 * 전체와 함께 '개발자가 아닌 참가자(none)' 만 따로 분석한다(기획안 KPI 의 대상).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : null;
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? path.join(root, 'data/study'));
const records = readStudyRecords(dir);
if (!records.length) {
  console.error(`기록이 없습니다: ${dir}`);
  process.exit(1);
}
const md = [studyReportMarkdown(analyzeStudy(records), '사용자 실험 결과 — 전체'), studyReportMarkdown(analyzeStudy(records, { group: 'none' }), '개발자가 아닌 참가자만')].join('\n\n');
console.log(md);
if (out) fs.writeFileSync(out, md);
