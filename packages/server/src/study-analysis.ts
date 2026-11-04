import fs from 'node:fs';
import path from 'node:path';

/**
 * 사용자 실험 분석.
 *  주 결과: 위반한 행을 '맞게 찾기까지 걸린 시간'(정답 과제만) — 참가자별 중앙값을 조건끼리 짝지어 비교
 *  검정: 윌콕슨 부호 순위 검정(작은 표본은 정확 분포), 효과 크기 r, 참가자별 비율의 부트스트랩 95% 구간
 *  KPI: 세계의 중앙 시간이 표의 50% 이하인가(= 50% 단축)
 */

export interface TrialRecord {
  type: 'trial';
  participant: number;
  session: string;
  practice: boolean;
  condition: string;
  anomaly: string;
  locateCorrect: boolean;
  diagnoseCorrect: boolean;
  timeMs: number | null;
  gaveUp: boolean;
  timedOut: boolean;
}
export interface SessionRecord {
  type: 'session';
  participant: number;
  session: string;
  background?: { developer?: string; dashboards?: number };
}
export interface QuestionnaireRecord {
  type: 'questionnaire';
  participant: number;
  condition: string;
  effort: number | null;
  confidence: number | null;
  final?: boolean;
  preference?: string;
}
export type StudyRecord = TrialRecord | SessionRecord | QuestionnaireRecord;

export function readStudyRecords(dir: string): StudyRecord[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as StudyRecord),
    );
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 윌콕슨 부호 순위 검정(양측). 0 차이는 버리고, 동순위는 평균 순위. n ≤ 25 는 정확 분포 */
export function wilcoxon(diffs: number[]): { n: number; w: number; p: number; z: number; r: number; exact: boolean } {
  const d = diffs.filter((x) => x !== 0 && Number.isFinite(x));
  const n = d.length;
  if (n === 0) return { n: 0, w: 0, p: 1, z: 0, r: 0, exact: true };
  const order = d.map((x, i) => ({ a: Math.abs(x), i })).sort((x, y) => x.a - y.a);
  const ranks = new Array<number>(n);
  for (let k = 0; k < n; ) {
    let j = k;
    while (j + 1 < n && order[j + 1].a === order[k].a) j++;
    for (let m = k; m <= j; m++) ranks[order[m].i] = (k + j) / 2 + 1;
    k = j + 1;
  }
  const wPlus = d.reduce((s, x, i) => s + (x > 0 ? ranks[i] : 0), 0);
  const total = (n * (n + 1)) / 2;
  const w = Math.min(wPlus, total - wPlus);
  const mean = total / 2;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sd ? (wPlus - mean) / sd : 0;
  let p: number;
  let exact = false;
  if (n <= 25) {
    // 순위를 2배 해 정수로 만든 뒤, 부호 2^n 가지의 W+ 분포를 동적 계획법으로 센다
    const r2 = ranks.map((x) => Math.round(x * 2));
    const max = r2.reduce((a, b) => a + b, 0);
    let dist = new Array<number>(max + 1).fill(0);
    dist[0] = 1;
    for (const r of r2) {
      const next = dist.slice();
      for (let s = 0; s + r <= max; s++) if (dist[s]) next[s + r] += dist[s];
      dist = next;
    }
    const all = 2 ** n;
    const w2 = Math.round(w * 2);
    const tail = dist.slice(0, w2 + 1).reduce((a, b) => a + b, 0) / all;
    p = Math.min(1, 2 * tail);
    exact = true;
  } else {
    const zc = Math.max(0, Math.abs(wPlus - mean) - 0.5) / sd;
    p = Math.min(1, 2 * (1 - normalCdf(zc)));
  }
  return { n, w, p, z, r: Math.abs(z) / Math.sqrt(n), exact };
}

function normalCdf(x: number) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** 시드 고정 부트스트랩: 값들의 중앙값에 대한 95% 구간 */
export function bootstrapMedianCI(xs: number[], iters = 4000, seed = 7): [number, number] {
  if (xs.length < 2) return [NaN, NaN];
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const meds: number[] = [];
  for (let i = 0; i < iters; i++) meds.push(median(xs.map(() => xs[Math.floor(rnd() * xs.length)])));
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(iters * 0.025)], meds[Math.floor(iters * 0.975)]];
}

export interface ConditionSummary {
  condition: string;
  trials: number;
  locateAccuracy: number;
  diagnoseAccuracy: number;
  giveUpRate: number;
  medianTimeMs: number;
  /** 역효율 점수: 정답 과제 평균 시간 / 정확도 (낮을수록 좋다) */
  ies: number;
  effort: number;
  confidence: number;
}

export interface Comparison {
  a: string;
  b: string;
  participants: number;
  /** 참가자별 (a 중앙 시간 / b 중앙 시간) 의 중앙값 */
  medianRatio: number;
  ratioCI: [number, number];
  test: ReturnType<typeof wilcoxon>;
  kpi50: boolean;
}

export interface StudyReport {
  participants: number;
  byGroup: Record<string, number>;
  conditions: ConditionSummary[];
  comparisons: Comparison[];
  preference: Record<string, number>;
  warnings: string[];
}

export function analyzeStudy(records: StudyRecord[], opts: { group?: string } = {}): StudyReport {
  const sessions = records.filter((r): r is SessionRecord => r.type === 'session');
  const groupOf = new Map(sessions.map((s) => [s.participant, s.background?.developer || '응답 없음']));
  const keep = (p: number) => !opts.group || groupOf.get(p) === opts.group;
  const trials = records.filter((r): r is TrialRecord => r.type === 'trial' && !r.practice && keep(r.participant));
  const qs = records.filter((r): r is QuestionnaireRecord => r.type === 'questionnaire' && keep(r.participant));
  const participants = [...new Set(trials.map((t) => t.participant))];
  const conditions = [...new Set(trials.map((t) => t.condition))];
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  const summaries: ConditionSummary[] = conditions.map((c) => {
    const ts = trials.filter((t) => t.condition === c);
    const ok = ts.filter((t) => t.locateCorrect && t.timeMs !== null);
    const acc = ts.length ? ok.length / ts.length : NaN;
    return {
      condition: c,
      trials: ts.length,
      locateAccuracy: acc,
      diagnoseAccuracy: ts.length ? ts.filter((t) => t.diagnoseCorrect).length / ts.length : NaN,
      giveUpRate: ts.length ? ts.filter((t) => t.gaveUp || t.timedOut).length / ts.length : NaN,
      medianTimeMs: median(ok.map((t) => t.timeMs!)),
      ies: mean(ok.map((t) => t.timeMs!)) / acc,
      effort: mean(qs.filter((q) => q.condition === c && q.effort).map((q) => q.effort!)),
      confidence: mean(qs.filter((q) => q.condition === c && q.confidence).map((q) => q.confidence!)),
    };
  });

  const perParticipant = (p: number, c: string) => median(trials.filter((t) => t.participant === p && t.condition === c && t.locateCorrect && t.timeMs !== null).map((t) => t.timeMs!));
  const comparisons: Comparison[] = [];
  if (conditions.includes('world')) {
    for (const b of conditions.filter((c) => c !== 'world')) {
      const pairs = participants.map((p) => [perParticipant(p, 'world'), perParticipant(p, b)] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      const ratios = pairs.map(([x, y]) => x / y);
      const medianRatio = median(ratios);
      const ratioCI = bootstrapMedianCI(ratios);
      comparisons.push({ a: 'world', b, participants: pairs.length, medianRatio, ratioCI, test: wilcoxon(pairs.map(([x, y]) => x - y)), kpi50: Number.isFinite(ratioCI[1]) && ratioCI[1] <= 0.5 });
    }
  }

  const preference: Record<string, number> = {};
  for (const q of qs.filter((q) => q.final)) preference[q.preference || '응답 없음'] = (preference[q.preference || '응답 없음'] ?? 0) + 1;
  const byGroup: Record<string, number> = {};
  for (const p of participants) byGroup[groupOf.get(p) ?? '응답 없음'] = (byGroup[groupOf.get(p) ?? '응답 없음'] ?? 0) + 1;

  const warnings: string[] = [];
  if (participants.length < 12) warnings.push(`참가자가 ${participants.length}명뿐이라 결론을 내리기에 부족합니다(사전에 정한 표본 크기까지 모으세요).`);
  for (const c of comparisons) if (c.participants < participants.length) warnings.push(`${c.a} 대 ${c.b}: 한 조건에서 정답이 하나도 없는 참가자 ${participants.length - c.participants}명은 시간 비교에서 빠졌습니다(정확도 표를 함께 보세요).`);
  return { participants: participants.length, byGroup, conditions: summaries, comparisons, preference, warnings };
}

const KO: Record<string, string> = { world: '세계(ISOMORPH)', table: '표(대시보드)', 'table+alerts': '표 + 위반 강조' };
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}초` : '-');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');

export function studyReportMarkdown(r: StudyReport, title = '사용자 실험 결과'): string {
  const lines = [`# ${title}`, '', `참가자 ${r.participants}명 (${Object.entries(r.byGroup).map(([k, v]) => `${k} ${v}`).join(', ') || '-'})`, ''];
  for (const w of r.warnings) lines.push(`> ⚠ ${w}`);
  if (r.warnings.length) lines.push('');
  lines.push('| 조건 | 과제 | 위치 정확도 | 원인 정확도 | 포기·시간 초과 | 중앙 시간(정답) | 역효율 점수 | 노력(1-7) | 확신(1-7) |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of r.conditions) lines.push(`| ${KO[c.condition] ?? c.condition} | ${c.trials} | ${pct(c.locateAccuracy)} | ${pct(c.diagnoseAccuracy)} | ${pct(c.giveUpRate)} | ${sec(c.medianTimeMs)} | ${sec(c.ies)} | ${num(c.effort, 1)} | ${num(c.confidence, 1)} |`);
  lines.push('');
  for (const c of r.comparisons) {
    lines.push(
      `**${KO[c.a]} 대 ${KO[c.b] ?? c.b}** (짝지은 참가자 ${c.participants}명): 세계/표 시간 비율의 중앙값 ${num(c.medianRatio)} (95% 구간 ${num(c.ratioCI[0])}~${num(c.ratioCI[1])}), ` +
        `윌콕슨 W=${num(c.test.w, 1)}, p=${num(c.test.p, 3)}${c.test.exact ? '(정확)' : '(정규 근사)'}, 효과 크기 r=${num(c.test.r)} → KPI(50% 단축, 구간 상한 ≤ 0.5): ${c.kpi50 ? '**달성**' : '미달 또는 판단 불가'}`,
      '',
    );
  }
  if (Object.keys(r.preference).length) lines.push(`선호: ${Object.entries(r.preference).map(([k, v]) => `${KO[k] ?? k} ${v}`).join(', ')}`, '');
  return lines.join('\n');
}
