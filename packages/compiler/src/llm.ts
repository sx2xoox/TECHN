import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ANOMALY_KO, CHANNELS, COLOR_NAMES, REGION_THEMES, SPRITES, type SystemSchema } from '@isomorph/core';
import { DraftSchema, type Draft } from './draft.ts';

/**
 * LLM Metaphor Compiler 의 모델 쪽 인터페이스.
 * 대화는 항상 덧붙이기(append-only)만 하며, 반례 되먹임으로 초안을 고친다.
 */
export interface DraftTurn {
  role: 'user' | 'assistant';
  /** assistant 턴은 모델이 돌려준 content 블록을 그대로 보관한다(사고 블록 포함) */
  content: unknown;
}

export interface DraftModel {
  readonly name: string;
  complete(system: string, turns: DraftTurn[]): Promise<{ draft: Draft; assistantContent: unknown }>;
}

export class LlmCompileError extends Error {}

export interface AnthropicDraftModelOptions {
  client?: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Claude API 기반 초안 모델. 구조화 출력으로 DraftSchema 를 보장받는다. */
export function anthropicDraftModel(opts: AnthropicDraftModelOptions = {}): DraftModel {
  const model = opts.model ?? 'claude-opus-5-5';
  let client = opts.client;
  return {
    name: model,
    async complete(system, turns) {
      client ??= new Anthropic();
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: 64000,
          system,
          thinking: { type: 'adaptive' },
          output_config: { effort: opts.effort ?? 'high', format: betaZodOutputFormat(DraftSchema) },
          // 안전 분류기가 거절하면 서버가 대체 모델로 같은 요청을 이어서 처리한다
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          messages: turns.map((t) => ({ role: t.role, content: t.content }) as Anthropic.Beta.BetaMessageParam),
        });
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') throw new LlmCompileError(`모델이 요청을 거절했습니다(${msg.stop_details?.category ?? 'unknown'})`);
        if (msg.stop_reason === 'max_tokens') throw new LlmCompileError('출력이 max_tokens 에서 잘렸습니다');
        const parsed = msg.parsed_output;
        if (!parsed) throw new LlmCompileError('구조화 출력을 해석하지 못했습니다');
        return { draft: parsed, assistantContent: msg.content };
      } catch (e) {
        if (e instanceof LlmCompileError) throw e;
        if (e instanceof Anthropic.AuthenticationError) throw new LlmCompileError('Claude API 인증 실패 — ANTHROPIC_API_KEY 를 확인하세요');
        if (e instanceof Anthropic.RateLimitError) throw new LlmCompileError('Claude API 요청 한도 초과 — 잠시 후 다시 시도하세요');
        if (e instanceof Anthropic.BadRequestError) throw new LlmCompileError(`Claude API 요청 오류: ${e.message}`);
        if (e instanceof Anthropic.APIError) throw new LlmCompileError(`Claude API 오류 ${e.status ?? ''}: ${e.message}`);
        if (e instanceof Anthropic.APIConnectionError) throw new LlmCompileError(`Claude API 연결 실패: ${e.message}`);
        throw new LlmCompileError(`LLM 컴파일 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

export function systemPrompt(): string {
  const channels = Object.entries(CHANNELS)
    .map(([k, v]) => `- ${k}: ${v.ko} (${v.kind}${v.editable ? ', 편집 가능' : ''})`)
    .join('\n');
  const anomalies = Object.entries(ANOMALY_KO).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `너는 ISOMORPH의 Metaphor Compiler다. 실제 소프트웨어 시스템의 스키마를 받아, 그 시스템을 픽셀 마을로 비추는 "세계 문법" 초안을 만든다.
이 세계는 운영자와 비개발자가 실제 시스템을 보고 만지는 인터페이스다. 아름다움보다 정직함이 먼저다.

규칙:
1. 구조 보존: 다른 행들이 가리키는(참조되는) 컬렉션은 건물(building), 다른 컬렉션을 참조하며 시간/상태를 갖는 사건성 컬렉션은 움직이는 NPC(npc), 지표성 단일 행은 광장의 랜드마크(landmark).
2. 모든 비-기본키 필드는 채널에 대응하거나, labelField/route/recency 로 쓰이거나, hidden 에 명시해야 한다. 아무 설명 없이 빠뜨리지 마라.
3. 채널 종류와 필드 타입을 맞춰라. 사용 가능한 채널:
${channels}
4. 색깔(tint)은 값마다 서로 다른 색이어야 하고(단사성), fallback 색은 어떤 값의 색과도 겹치면 안 된다. 색 이름: ${COLOR_NAMES.join(', ')}.
5. stack 채널: 정수 필드라면 (domainMax-domainMin)/(rangeMax-rangeMin) 이 1 이상의 정수가 되게 하라(상자 1개 = k 단위). rangeMin 은 0.
6. 민감 필드(sensitive=true: 이메일·비밀번호·전화 등)는 절대 채널이나 labelField 에 쓰지 말고 hidden 에 넣어라.
7. 편집 가능한 바인딩은 사람이 이해할 행동(affordance)이 있을 때만 열어라. 나머지는 readOnly=true. 범주형 필드에 lit 을 쓰려면 when(켜짐에 해당하는 값들)과 writeTrue/writeFalse 를 함께 지정하라.
8. NPC 의 recencyField 는 생성 시각 timestamp 필드, recencySeconds 는 보통 60.
9. route 필드는 반드시 참조(ref) 필드여야 하며, 가리키는 컬렉션은 건물로 그려져야 한다.
10. 불변식은 DB가 이미 강제하지 않지만 깨지면 사고인 규칙(예: 재고 ≥ 0, 수정시각 ≥ 생성시각, 참조 대상 존재)을 찾아라. 이상 현상 종류:
${anomalies}
11. 제목·설명은 한국어. id 는 영문 소문자와 밑줄. sprite 는 ${SPRITES.join(', ')} 중 하나, region theme 은 ${REGION_THEMES.join(', ')} 중 하나.
12. 해당 없는 필드는 null 로 채운다.

검증기가 문법을 수천 개의 무작위 상태로 검사한다(GetPut, PutGet, 국소성, 행동 법칙). 반례가 돌아오면 원인을 고친 전체 초안을 다시 내라.`;
}

export function describeSchemaForPrompt(schema: SystemSchema): string {
  return JSON.stringify(
    {
      system: schema.system,
      source: schema.source,
      collections: schema.collections.map((c) => ({
        name: c.name,
        primaryKey: c.primaryKey,
        rows: c.rowCountHint,
        fields: c.fields.map((f) => ({
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          ...(f.ref ? { ref: `${f.ref.collection}.${f.ref.field}`, refEnforced: !!f.refEnforced } : {}),
          ...(f.enumValues ? { enumValues: f.enumValues } : {}),
          ...(f.sensitive ? { sensitive: true } : {}),
          ...(f.stats?.min !== undefined ? { min: f.stats.min, max: f.stats.max } : {}),
        })),
      })),
      constraints: schema.constraints.map((c) => ({ collection: c.collection, rule: c.description, enforcedByDb: c.enforced })),
    },
    null,
    1,
  );
}
