import { verifyGrammar, type SystemSchema, type VerificationIssue, type VerificationReport, type WorldGrammar } from '@isomorph/core';
import { draftToGrammar, grammarToDraft } from './draft.ts';
import { compileHeuristic } from './heuristic.ts';
import { anthropicDraftModel, describeSchemaForPrompt, LlmCompileError, systemPrompt, type DraftModel, type DraftTurn } from './llm.ts';
import { autoRepair, type RepairAction } from './repair.ts';

export interface CompileRound {
  round: number;
  source: 'heuristic' | 'llm' | 'repair';
  ok: boolean;
  errors: number;
  warnings: number;
  score: number;
  repairs?: RepairAction[];
  topIssues: string[];
}

export interface CompileResult {
  grammar: WorldGrammar;
  report: VerificationReport;
  rounds: CompileRound[];
  mode: 'heuristic' | 'llm';
  fallbackReason?: string;
}

export interface CompileOptions {
  mode?: 'heuristic' | 'llm' | 'auto';
  model?: DraftModel;
  maxLlmRounds?: number;
  maxRepairRounds?: number;
  numRuns?: number;
  seed?: number;
  onRound?: (r: CompileRound) => void;
}

function summarizeRound(round: number, source: CompileRound['source'], r: VerificationReport, repairs?: RepairAction[]): CompileRound {
  return {
    round,
    source,
    ok: r.ok,
    errors: r.issues.filter((i) => i.level === 'error').length,
    warnings: r.issues.filter((i) => i.level === 'warning').length,
    score: r.fidelity.score,
    ...(repairs ? { repairs } : {}),
    topIssues: r.issues.filter((i) => i.level === 'error').slice(0, 5).map((i) => `${i.code}: ${i.message}`),
  };
}

export function feedbackFor(report: VerificationReport): string {
  const fmt = (i: VerificationIssue) => `- [${i.code}]${i.kind ? ` (${i.kind}${i.channel ? `.${i.channel}` : ''})` : ''} ${i.message}${i.counterexample ? `\n  반례 상태: ${i.counterexample}` : ''}`;
  const errors = report.issues.filter((i) => i.level === 'error').slice(0, 15).map(fmt);
  const warnings = report.issues.filter((i) => i.level === 'warning').slice(0, 10).map(fmt);
  return [
    `검증 실패 (충실도 ${report.fidelity.score}/100). 아래 오류를 모두 고친 '전체' 초안을 다시 내라.`,
    '오류:',
    ...errors,
    ...(warnings.length ? ['경고(가능하면 해소):', ...warnings] : []),
  ].join('\n');
}

async function repairLoop(grammar: WorldGrammar, report: VerificationReport, schema: SystemSchema, opts: CompileOptions, rounds: CompileRound[]) {
  let g = grammar;
  let r = report;
  const max = opts.maxRepairRounds ?? 4;
  for (let i = 0; i < max; i++) {
    const needs = !r.ok || r.issues.some((x) => x.code === 'UNACCOUNTED_FIELD');
    if (!needs) break;
    const { grammar: fixed, actions } = autoRepair(g, r, schema);
    if (!actions.length) break;
    g = fixed;
    r = verifyGrammar(g, schema, { numRuns: opts.numRuns, seed: opts.seed });
    const round = summarizeRound(rounds.length + 1, 'repair', r, actions);
    rounds.push(round);
    opts.onRound?.(round);
  }
  return { grammar: g, report: r };
}

async function compileHeuristicVerified(schema: SystemSchema, opts: CompileOptions, rounds: CompileRound[]) {
  const g = compileHeuristic(schema);
  const r = verifyGrammar(g, schema, { numRuns: opts.numRuns, seed: opts.seed });
  const round = summarizeRound(rounds.length + 1, 'heuristic', r);
  rounds.push(round);
  opts.onRound?.(round);
  return repairLoop(g, r, schema, opts, rounds);
}

/**
 * 시스템 스키마 → 검증된 세계 문법.
 * LLM 모드: 초안 → 검증 → 반례 되먹임(최대 N회) → 그래도 실패하면 결정적 수리.
 * LLM 을 쓸 수 없으면 규칙 기반 컴파일러로 물러선다(이유를 기록).
 */
export async function compile(schema: SystemSchema, opts: CompileOptions = {}): Promise<CompileResult> {
  const rounds: CompileRound[] = [];
  const mode = opts.mode ?? 'auto';
  const useLlm = mode === 'llm' || (mode === 'auto' && (!!opts.model || !!process.env.ANTHROPIC_API_KEY));
  if (!useLlm) {
    const { grammar, report } = await compileHeuristicVerified(schema, opts, rounds);
    return { grammar, report, rounds, mode: 'heuristic' };
  }

  const model = opts.model ?? anthropicDraftModel();
  const baseline = compileHeuristic(schema);
  const turns: DraftTurn[] = [
    {
      role: 'user',
      content: [
        '다음 시스템의 세계 문법 초안을 만들어라.',
        '시스템 스키마:',
        describeSchemaForPrompt(schema),
        '참고용 규칙 기반 초안(더 나은 은유가 있으면 바꿔도 된다):',
        JSON.stringify(grammarToDraft(baseline)),
      ].join('\n\n'),
    },
  ];
  let grammar: WorldGrammar | null = null;
  let report: VerificationReport | null = null;
  const maxRounds = opts.maxLlmRounds ?? 3;
  try {
    for (let i = 0; i < maxRounds; i++) {
      const { draft, assistantContent } = await model.complete(systemPrompt(), turns);
      grammar = draftToGrammar(draft, schema);
      report = verifyGrammar(grammar, schema, { numRuns: opts.numRuns, seed: opts.seed });
      const round = summarizeRound(rounds.length + 1, 'llm', report);
      rounds.push(round);
      opts.onRound?.(round);
      if (report.ok) break;
      turns.push({ role: 'assistant', content: assistantContent });
      turns.push({ role: 'user', content: feedbackFor(report) });
    }
  } catch (e) {
    if (!(e instanceof LlmCompileError)) throw e;
    // 이미 받은 초안이 있으면 그것으로 계속, 없으면 규칙 기반으로 물러선다
    if (!grammar || !report) {
      const r = await compileHeuristicVerified(schema, opts, rounds);
      return { ...r, rounds, mode: 'heuristic', fallbackReason: e.message };
    }
  }
  const repaired = await repairLoop(grammar!, report!, schema, opts, rounds);
  if (!repaired.report.ok) {
    // LLM 초안이 끝내 법칙을 통과하지 못하면 규칙 기반 결과와 비교해 더 나은 쪽을 고른다
    const h = await compileHeuristicVerified(schema, opts, rounds);
    if (h.report.ok) return { ...h, rounds, mode: 'heuristic', fallbackReason: 'LLM 초안이 렌즈 법칙을 통과하지 못해 규칙 기반 문법을 사용' };
  }
  return { ...repaired, rounds, mode: 'llm' };
}
