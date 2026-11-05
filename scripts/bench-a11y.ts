import fs from 'node:fs';
import path from 'node:path';
import { deltaE2000, hexToRgb, isCategorical, MIN_DISTINGUISHABLE_DE, PALETTE, simulateVision, tintAccessibility, type CategoricalBinding, type ColorName, type SystemSchema, type Vision } from '@isomorph/core';
import { BENCH_SCHEMAS, compileHeuristic, parseRailsSchema } from '@isomorph/compiler';

/**
 * 접근성 측정: 컴파일러가 만든 '색깔(상태)' 채널이 적색맹·녹색맹·청색맹에게도 구분되는가.
 *   npm run bench:a11y [-- <schema.rb 폴더> ...]
 *  - 이전 방식: 이전 팔레트 + '뜻 계열에서 아직 안 쓴 첫 색'
 *  - 지금: 바꾼 초록·빨강 + 색각 이상까지 고려한 색 고르기
 *  - 모양(글리프)까지: 값마다 다른 모양이 있으면 색이 같아 보여도 구분된다
 */
const OLD_HEX: Record<ColorName, string> = { ...Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, v.hex])), green: '#5bbf4a', red: '#e5533d' } as Record<ColorName, string>;
const OLD_FAMILIES: [RegExp, ColorName[]][] = [
  [/^(gold|premium|vip)$/i, ['yellow', 'orange']],
  [/^(silver|standard)$/i, ['gray', 'blue']],
  [/^(bronze|basic|free)$/i, ['brown', 'orange']],
  [/^(platinum|diamond|enterprise)$/i, ['teal', 'blue']],
  [/^(ok|active|paid|success|succeeded|running|completed?|done|delivered|open|online|healthy|approved|available|published|resolved|up|ready|returned|enrolled|discharged|stable|low)$/i, ['green', 'teal']],
  [/^(pending|waiting|queued|created|processing|in_progress|new|draft|scheduled|starting|review|shipped|in_transit|borrowed|medium|moderate)$/i, ['yellow', 'orange']],
  [/^(failed|failure|error|rejected|dead|exited|crashed|down|offline|unhealthy|blocked|banned|overdue|expired|critical|high|lost)$/i, ['red', 'pink']],
  [/^(cancelled|canceled|refunded|restarting|degraded|warning|stopped|paused|suspended|archived|revoked)$/i, ['gray', 'brown']],
];
const NEUTRAL: ColorName[] = ['blue', 'purple', 'teal', 'pink', 'brown', 'orange', 'green', 'yellow', 'red', 'gray'];
function oldAssign(values: string[]): ColorName[] {
  const used: ColorName[] = [];
  for (const v of values.slice(0, 9)) used.push([...(OLD_FAMILIES.find(([re]) => re.test(v))?.[1] ?? []), ...NEUTRAL].find((c) => !used.includes(c))!);
  used.push((['purple', 'pink', 'blue', 'teal', 'brown', 'gray', 'orange'] as ColorName[]).find((c) => !used.includes(c)) ?? NEUTRAL.find((c) => !used.includes(c))!);
  return used;
}
const oldDistinct = (colors: ColorName[]) => {
  for (const v of ['protan', 'deutan', 'tritan'] as Vision[])
    for (let i = 0; i < colors.length; i++)
      for (let j = i + 1; j < colors.length; j++) if (deltaE2000(simulateVision(hexToRgb(OLD_HEX[colors[i]]), v), simulateVision(hexToRgb(OLD_HEX[colors[j]]), v)) < MIN_DISTINGUISHABLE_DE) return false;
  return true;
};

const sets: { name: string; schemas: SystemSchema[] }[] = [{ name: '벤치마크 12종', schemas: BENCH_SCHEMAS }];
for (const dir of process.argv.slice(2)) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.schema') && fs.readFileSync(path.join(dir, f), 'utf8').includes('create_table'));
  sets.push({ name: `${path.basename(dir)} ${files.length}종`, schemas: files.map((f) => parseRailsSchema(f, fs.readFileSync(path.join(dir, f), 'utf8'))) });
}
const rows: Record<string, string | number>[] = [];
for (const set of sets) {
  let n = 0;
  let oldOk = 0;
  let newOk = 0;
  let glyphOk = 0;
  for (const s of set.schemas) {
    for (const k of compileHeuristic(s).kinds) {
      const b = k.channels.find((c): c is CategoricalBinding => c.channel === 'tint' && isCategorical(c));
      if (!b) continue;
      n++;
      if (oldDistinct(oldAssign(Object.keys(b.map)))) oldOk++;
      const a = tintAccessibility(b);
      if (a.byColor) newOk++;
      if (a.ok) glyphOk++;
    }
  }
  const pct = (x: number) => (n ? `${Math.round((x / n) * 100)}%` : '-');
  rows.push({ '스키마 묶음': set.name, '색깔 채널': n, '이전: 색만으로 구분': `${oldOk} (${pct(oldOk)})`, '지금: 색만으로 구분': `${newOk} (${pct(newOk)})`, '지금: 색 또는 모양으로 구분': `${glyphOk} (${pct(glyphOk)})` });
}
console.log(`색각 이상(적·녹·청) 모두에서 가장 가까운 두 색의 CIEDE2000 차이가 ${MIN_DISTINGUISHABLE_DE} 이상이면 '색만으로 구분'`);
console.table(rows);
console.log('주의: Rails 스키마는 enum 값을 모델 코드에 두므로(데이터 없이 읽으면) 색깔 채널이 생기지 않는다. 표본이 작다는 점을 함께 보고할 것.');
