import { describe, expect, it } from 'vitest';
import { markSensitive, readOnlyExcept, verifyGrammar, type SystemSchema } from '@isomorph/core';
import {
  autoRepair,
  BENCH_SCHEMAS,
  compile,
  compileHeuristic,
  draftToGrammar,
  feedbackFor,
  grammarToDraft,
  LlmCompileError,
  type Draft,
  type DraftModel,
  type DraftTurn,
} from '../src/index.ts';

const shop = BENCH_SCHEMAS.find((s) => s.system === 'shop')!;
const docker = BENCH_SCHEMAS.find((s) => s.system === 'docker')!;

describe('heuristic metaphor compiler', () => {
  it('maps the shop to a market town with honest bindings', () => {
    const g = compileHeuristic(shop);
    const byCol = Object.fromEntries(g.kinds.map((k) => [k.collection, k]));
    expect(byCol.products).toMatchObject({ archetype: 'building', sprite: 'warehouse', region: 'market', labelField: 'name' });
    expect(byCol.products.channels.map((c) => c.channel).sort()).toEqual(['lit', 'sign', 'stack']);
    expect(byCol.customers).toMatchObject({ archetype: 'building', sprite: 'house', hidden: expect.arrayContaining(['email']) });
    expect(byCol.orders).toMatchObject({ archetype: 'npc', sprite: 'merchant', route: { from: 'customer_id', to: 'product_id' }, recency: { field: 'created_at', seconds: 60 } });
    expect(byCol.shop_stats).toMatchObject({ archetype: 'landmark', sprite: 'townhall' });
    expect(byCol.shop_stats.channels.map((c) => c.channel).sort()).toEqual(['crowd', 'fire', 'speed']);
    expect(g.affordances.map((a) => a.id)).toEqual(expect.arrayContaining(['products_off', 'products_on', 'products_restock', 'orders_cancel']));
    // 상자 1개 = 정수 단위
    const stack = byCol.products.channels.find((c) => c.channel === 'stack')!;
    if ('scale' in stack) expect((stack.scale.domain[1] - stack.scale.domain[0]) % 10).toBe(0);
    // 재고 음수 법칙이 유령 상자로 보이도록
    expect(g.invariants.find((i) => i.id === 'nonneg_products_stock')).toMatchObject({ anomaly: 'ghost', status: 'proposed' });
    expect(verifyGrammar(g, shop, { numRuns: 60 }).ok).toBe(true);
  });

  it('never offers an action on a field the system will not accept writes to', () => {
    // 같은 도커 스키마라도 어댑터가 쓰기를 받지 않는다면(관측 전용) 스위치를 열지 않는다
    const ro = readOnlyExcept(docker, []);
    const g = compileHeuristic(ro);
    expect(g.affordances).toEqual([]);
    expect(verifyGrammar(g, ro, { numRuns: 30 }).ok).toBe(true);
    // 다른 컴파일러(LLM 등)가 그래도 열어 두면 검증기가 막고, 자동 수리가 닫는다
    const open = compileHeuristic(docker);
    const report = verifyGrammar(open, ro, { numRuns: 30 });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'WRITE_UNSUPPORTED')).toBe(true);
    const fixed = autoRepair(open, report, ro).grammar;
    expect(fixed.affordances).toEqual([]);
    expect(verifyGrammar(fixed, ro, { numRuns: 30 }).ok).toBe(true);
  });

  it('turns container state into lights that can be switched (with writeTrue/writeFalse)', () => {
    const g = compileHeuristic(docker);
    const k = g.kinds[0];
    expect(k.sprite).toBe('factory');
    const lit = k.channels.find((c) => c.channel === 'lit');
    expect(lit).toMatchObject({ field: 'state', when: ['running'], writeTrue: 'running', writeFalse: 'exited' });
    expect(g.affordances.find((a) => a.id === 'containers_off')).toMatchObject({ risk: 'high' });
    expect(verifyGrammar(g, docker, { numRuns: 60 }).ok).toBe(true);
  });

  it('compiles every benchmark schema into a lawful grammar without human help', async () => {
    for (const s of BENCH_SCHEMAS) {
      const r = await compile(s, { mode: 'heuristic', numRuns: 40 });
      expect(r.report.ok, `${s.system}: ${r.report.issues.map((i) => i.message).join('; ')}`).toBe(true);
    }
  });
});

describe('metaphors for unfamiliar schemas', () => {
  // 컴파일러 어휘를 만들 때 쓰지 않은 모양의 스키마: 음악 서비스
  const music: SystemSchema = markSensitive({
    system: 'music',
    source: 'postgres',
    constraints: [],
    collections: [
      { name: 'genre', primaryKey: 'genre_id', fields: [{ name: 'genre_id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: true }] },
      { name: 'track', primaryKey: 'track_id', fields: [{ name: 'track_id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'genre_id', type: 'integer', nullable: true, ref: { collection: 'genre', field: 'genre_id' }, refEnforced: true }, { name: 'milliseconds', type: 'integer', nullable: false }] },
      { name: 'playlist', primaryKey: 'playlist_id', fields: [{ name: 'playlist_id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: true }, { name: 'curator', type: 'string', nullable: true }, { name: 'plays', type: 'integer', nullable: true }] },
      { name: 'playlist_track', primaryKey: 'playlist_id', fields: [{ name: 'playlist_id', type: 'integer', nullable: false, ref: { collection: 'playlist', field: 'playlist_id' }, refEnforced: true }, { name: 'track_id', type: 'integer', nullable: false, ref: { collection: 'track', field: 'track_id' }, refEnforced: true }] },
      { name: 'quarterly_reports', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'title', type: 'string', nullable: false }, { name: 'body', type: 'string', nullable: true }] },
    ],
  });

  it('recognises lookup tables and join tables by structure, not by name', () => {
    const g = compileHeuristic(music);
    const kind = (c: string) => g.kinds.find((k) => k.collection === c)!;
    expect(kind('genre')).toMatchObject({ sprite: 'signpost', title: '분류 표지판' });
    expect(kind('track')).toMatchObject({ sprite: 'theater', title: '극장(track)' }); // playlist 도 극장이라 이름으로 구분
    // 연결표는 두 곳 사이를 오가는 주민이 되고, 무엇과 무엇을 잇는지 이름에 적힌다
    expect(kind('playlist_track')).toMatchObject({ archetype: 'npc', title: 'playlist·track 연결' });
    expect(kind('playlist_track').route).toEqual({ from: 'playlist_id', to: 'track_id' });
    expect(verifyGrammar(g, music, { numRuns: 20 }).ok).toBe(true);
  });

  it('falls back to what a table holds, then to how central it is, and records why', () => {
    const s: SystemSchema = markSensitive({
      system: 'odd-names',
      source: 'postgres',
      constraints: [],
      collections: [
        { name: 'zorbs', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'label', type: 'string', nullable: false }, { name: 'balance', type: 'number', nullable: false }] },
        { name: 'quux', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'flavor', type: 'string', nullable: true }, { name: 'weight', type: 'integer', nullable: true }] },
        ...['a', 'b', 'c'].map((n) => ({ name: `blip_${n}`, primaryKey: 'id', fields: [{ name: 'id', type: 'integer' as const, nullable: false }, { name: 'quux_id', type: 'integer' as const, nullable: false, ref: { collection: 'quux', field: 'id' }, refEnforced: true }, { name: 'body', type: 'string' as const, nullable: true }, { name: 'created_at', type: 'timestamp' as const, nullable: false }] })),
        { name: 'thingamajigs', primaryKey: 'id', fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'string', nullable: false }, { name: 'weight', type: 'integer', nullable: true }] },
      ],
    });
    const g = compileHeuristic(s);
    const kind = (c: string) => g.kinds.find((k) => k.collection === c)!;
    expect(kind('zorbs')).toMatchObject({ sprite: 'bank', metaphorBasis: 'fields' }); // balance → 은행
    expect(kind('quux')).toMatchObject({ sprite: 'office', title: '회관', metaphorBasis: 'structure' }); // 세 곳이 가리킴
    expect(kind('blip_a')).toMatchObject({ archetype: 'npc', sprite: 'courier', metaphorBasis: 'fields' }); // body → 편지 배달부
    expect(kind('thingamajigs')).toMatchObject({ metaphorBasis: 'generic' }); // 근거가 없으면 솔직하게 일반 은유
    expect(verifyGrammar(g, s, { numRuns: 20 }).ok).toBe(true);
  });

  it('matches short words only at word boundaries', () => {
    const g = compileHeuristic(music);
    // 'reports' 안의 'port' 는 항구(역)가 아니다
    expect(g.kinds.find((k) => k.collection === 'quarterly_reports')!.sprite).not.toBe('station');
  });
});

describe('draft conversion', () => {
  it('round-trips a grammar through the flat LLM draft format', () => {
    for (const s of BENCH_SCHEMAS) {
      const g = compileHeuristic(s);
      const back = draftToGrammar(grammarToDraft(g), s);
      // 은유 근거(metaphorBasis)는 출처 기록이라 LLM 초안 형식에는 싣지 않는다
      expect(back.kinds).toEqual(g.kinds.map(({ metaphorBasis: _basis, ...k }) => k));
      expect(back.affordances).toEqual(g.affordances.map(({ inverseOf: _ignored, ...a }) => a));
      expect(verifyGrammar(back, s, { numRuns: 30 }).ok).toBe(true);
    }
  });
});

/** 첫 초안은 색이 겹치고(단사성 위반), 두 번째 초안에서 고치는 가짜 모델 */
function scriptedModel(): DraftModel & { calls: DraftTurn[][] } {
  const good = grammarToDraft(compileHeuristic(shop));
  const bad: Draft = JSON.parse(JSON.stringify(good));
  const orders = bad.kinds.find((k) => k.collection === 'orders')!;
  const tint = orders.channels.find((c) => c.channel === 'tint')!;
  tint.colors = tint.colors!.map((c) => ({ ...c, color: 'yellow' }));
  const calls: DraftTurn[][] = [];
  return {
    name: 'scripted',
    calls,
    async complete(_system, turns) {
      calls.push([...turns]);
      return { draft: calls.length === 1 ? bad : good, assistantContent: [{ type: 'text', text: 'draft' }] };
    },
  };
}

describe('LLM compile loop (counter-example feedback)', () => {
  it('feeds verifier counter-examples back and accepts the corrected draft', async () => {
    const model = scriptedModel();
    const r = await compile(shop, { mode: 'llm', model, numRuns: 40 });
    expect(r.mode).toBe('llm');
    expect(r.rounds.map((x) => [x.source, x.ok])).toEqual([
      ['llm', false],
      ['llm', true],
    ]);
    expect(model.calls).toHaveLength(2);
    const feedback = model.calls[1].at(-1)!.content as string;
    expect(feedback).toContain('NON_INJECTIVE');
    expect(model.calls[1].map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.grammar.generatedBy).toBe('llm');
  });

  it('falls back to the heuristic compiler when the model is unavailable', async () => {
    const failing: DraftModel = {
      name: 'down',
      async complete() {
        throw new LlmCompileError('Claude API 연결 실패: offline');
      },
    };
    const r = await compile(shop, { mode: 'llm', model: failing, numRuns: 30 });
    expect(r.mode).toBe('heuristic');
    expect(r.fallbackReason).toContain('연결 실패');
    expect(r.report.ok).toBe(true);
  });

  it('repairs a draft deterministically when the model keeps failing', async () => {
    const stubborn = scriptedModel();
    const always: DraftModel = {
      name: 'stubborn',
      async complete(s, t) {
        const res = await stubborn.complete(s, t);
        stubborn.calls.length = 0; // 항상 '나쁜' 초안
        return res;
      },
    };
    const r = await compile(shop, { mode: 'llm', model: always, maxLlmRounds: 2, numRuns: 30 });
    expect(r.rounds.filter((x) => x.source === 'llm')).toHaveLength(2);
    expect(r.rounds.some((x) => x.source === 'repair' && x.repairs?.some((a) => a.code === 'NON_INJECTIVE'))).toBe(true);
    expect(r.report.ok).toBe(true);
  });

  it('writes actionable feedback', () => {
    const g = compileHeuristic(shop);
    const k = g.kinds.find((x) => x.collection === 'products')!;
    const st = k.channels.find((c) => c.channel === 'stack')!;
    if ('scale' in st) st.scale = { domain: [0, 3], range: [0, 10] };
    const text = feedbackFor(verifyGrammar(g, shop, { numRuns: 40 }));
    expect(text).toContain('PUTGET');
    expect(text).toContain('반례 상태');
  });
});
