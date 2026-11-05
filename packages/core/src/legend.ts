import { CHANNELS, PALETTE, isBoolean, isCategorical, isQuant, type Binding, type EntityKind, type WorldGrammar } from './grammar.ts';
import type { CollectionSchema, Row, SystemSchema } from './schema.ts';
import { findCollection } from './schema.ts';
import { GLYPH_SYMBOL } from './glyph.ts';

/** 정직한 범례: 세계의 모든 시각 요소가 무엇을 뜻하는지 사람 말로 풀어 쓴다. */

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toFixed(2);
}

export function describeBinding(b: Binding): string {
  const name = CHANNELS[b.channel].ko;
  if (isQuant(b)) {
    const [d0, d1] = b.scale.domain;
    const [r0, r1] = b.scale.range;
    const unit = b.unit ?? '';
    if (b.channel === 'stack') {
      const per = (d1 - d0) / (r1 - r0);
      return `${b.field} → ${name}: 상자 1개 ≈ ${fmt(per)}${unit} (${fmt(d0)}~${fmt(d1)} 범위, 음수는 붉은 유령 상자)`;
    }
    if (b.channel === 'size' || b.channel === 'speed') {
      return `${b.field} → ${name}: ${fmt(d0)}${unit}일 때 ${fmt(r0)}배 … ${fmt(d1)}${unit}일 때 ${fmt(r1)}배`;
    }
    return `${b.field} → ${name}: ${fmt(d0)}~${fmt(d1)}${unit} → ${fmt(r0)}~${fmt(r1)}`;
  }
  if (isCategorical(b)) {
    const pairs = Object.entries(b.map).map(([k, c]) => `${k}=${PALETTE[c].ko}${b.glyphs?.[k] ? `·${GLYPH_SYMBOL[b.glyphs[k]]}` : ''}`);
    return `${b.field} → ${name}${b.glyphs ? '과 모양' : ''}: ${pairs.join(', ')} (그 외=${PALETTE[b.fallback].ko})`;
  }
  if (isBoolean(b)) {
    const cond = b.when ? `${b.field} ∈ {${b.when.map(String).join(', ')}}` : `${b.field} = true`;
    const what = b.channel === 'lit' ? '불 켜짐' : '안개 낌';
    return `${b.field} → ${name}: ${what} ⇔ ${b.invert ? `아님(${cond})` : cond}`;
  }
  return `${b.field} → ${name}`;
}

export interface LegendEntry {
  kind: string;
  title: string;
  collection: string;
  archetype: EntityKind['archetype'];
  sprite: EntityKind['sprite'];
  region: string;
  headline: string;
  lines: string[];
  hidden: string[];
}

export function buildLegend(g: WorldGrammar, schema: SystemSchema): LegendEntry[] {
  return g.kinds.map((k) => {
    const lines = k.channels.map(describeBinding);
    if (k.labelField) lines.push(`${k.labelField} → 이름표`);
    if (k.route?.from || k.route?.to) {
      lines.push(`이동 경로: ${k.route.from ?? '?'} 건물 → ${k.route.to ?? '?'} 건물`);
    }
    if (k.recency) lines.push(`최근 ${k.recency.seconds}초 안에 생긴 행만 등장 (${k.recency.field} 기준)`);
    // 왜 이 모습인가(정직성): 은유를 고른 근거
    const basis = {
      name: `'${k.collection}' 라는 이름을 보고 고른 모습`,
      structure: '이름이 아니라 구조(다른 표와의 연결 방식)를 보고 고른 모습',
      fields: '이름이 아니라 담고 있는 필드(돈·글·위치·파일·작업·사람 정보)를 보고 고른 모습',
      generic: '알맞은 은유를 찾지 못해 쓴 일반적인 모습(이 모습 자체에는 뜻이 없음)',
      llm: '언어 모델이 고르고 검증기가 통과시킨 모습',
      manual: '사람이 정한 모습',
    }[k.metaphorBasis ?? 'manual'];
    if (k.metaphorBasis) lines.push(`모습의 근거: ${basis}`);
    const col = findCollection(schema, k.collection);
    return {
      kind: k.id,
      title: k.title,
      collection: k.collection,
      archetype: k.archetype,
      sprite: k.sprite,
      region: k.region,
      headline: `${k.collection} 의 각 행 = ${k.title}${col?.rowCountHint !== undefined ? ` (현재 ${col.rowCountHint}행)` : ''}`,
      lines,
      hidden: k.hidden,
    };
  });
}

/** 민감 필드는 인스펙터에서도 가린다. */
export function maskRow(row: Row, col: CollectionSchema | undefined): Row {
  if (!col) return row;
  const out: Row = { ...row };
  for (const f of col.fields) {
    if (!f.sensitive || out[f.name] === null || out[f.name] === undefined) continue;
    const s = String(out[f.name]);
    out[f.name] = s.length <= 2 ? '••' : `${s[0]}•••${s.at(-1)}`;
  }
  return out;
}
