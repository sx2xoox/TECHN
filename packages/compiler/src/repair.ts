import {
  findCollection,
  isCategorical,
  isQuant,
  type SystemSchema,
  type VerificationIssue,
  type VerificationReport,
  type WorldGrammar,
} from '@isomorph/core';
import { assignGlyphs } from '@isomorph/core';
import { assignColors } from './lexicon.ts';

/**
 * 결정적 자동 수리: 검증기가 찾은 문제를 보수적으로 고친다.
 * 원칙: 확신이 없으면 '그리지 않는다/편집을 막는다' 쪽으로 물러선다(정직성 > 표현력).
 */
export interface RepairAction {
  code: string;
  kind?: string;
  action: string;
}

export function autoRepair(input: WorldGrammar, report: VerificationReport, schema: SystemSchema): { grammar: WorldGrammar; actions: RepairAction[] } {
  const g: WorldGrammar = JSON.parse(JSON.stringify(input));
  const actions: RepairAction[] = [];
  const kindOf = (id?: string) => g.kinds.find((k) => k.id === id);
  const dropAffordancesFor = (kindId: string, channel?: string) => {
    const before = g.affordances.length;
    g.affordances = g.affordances.filter((a) => !(a.entityKind === kindId && (!channel || a.edits.some((e) => e.channel === channel))));
    return before - g.affordances.length;
  };

  for (const issue of report.issues.filter((i: VerificationIssue) => i.level === 'error')) {
    const k = kindOf(issue.kind);
    const binding = k && issue.channel ? k.channels.find((b) => b.channel === issue.channel) : undefined;
    switch (issue.code) {
      case 'NON_INJECTIVE':
      case 'FALLBACK_COLLISION':
      case 'UNKNOWN_COLOR':
        if (binding && isCategorical(binding)) {
          const { map, fallback } = assignColors(Object.keys(binding.map));
          binding.map = map;
          binding.fallback = fallback;
          binding.glyphs = assignGlyphs(Object.keys(map));
          actions.push({ code: issue.code, kind: k!.id, action: `${binding.field} 의 색을 값마다 다르게 재배정` });
        }
        break;
      case 'PUTGET':
        if (binding && isQuant(binding) && binding.channel === 'stack' && issue.message.includes('양자화')) {
          const span = binding.scale.range[1] - binding.scale.range[0];
          const per = Math.max(1, Math.ceil((binding.scale.domain[1] - binding.scale.domain[0]) / span));
          binding.scale.domain = [binding.scale.domain[0], binding.scale.domain[0] + per * span];
          actions.push({ code: issue.code, kind: k!.id, action: `${binding.field}: 상자 1개 = ${per} 단위로 조정(정수 왕복 보장)` });
        } else if (binding) {
          (binding as { readOnly?: boolean }).readOnly = true;
          const n = dropAffordancesFor(k!.id, binding.channel);
          actions.push({ code: issue.code, kind: k!.id, action: `${binding.field}(${binding.channel}) 편집 차단, 관련 행동 ${n}개 제거` });
        }
        break;
      case 'PRIVACY_LEAK':
        if (k) {
          const col = findCollection(schema, k.collection);
          const sensitive = new Set(col?.fields.filter((f) => f.sensitive).map((f) => f.name));
          const removed = k.channels.filter((b) => sensitive.has(b.field)).map((b) => b.field);
          k.channels = k.channels.filter((b) => !sensitive.has(b.field));
          if (k.labelField && sensitive.has(k.labelField)) {
            removed.push(k.labelField);
            delete k.labelField;
          }
          k.hidden = [...new Set([...k.hidden, ...removed])];
          actions.push({ code: issue.code, kind: k.id, action: `민감 필드 ${removed.join(', ')} 를 세계에서 제거` });
        }
        break;
      case 'TYPE_MISMATCH':
      case 'UNKNOWN_FIELD':
      case 'DEGENERATE_SCALE':
      case 'DUPLICATE_CHANNEL':
      case 'WRITE_UNDEFINED':
      case 'WRITE_INCONSISTENT':
      case 'WRITE_UNSUPPORTED':
        if (k && binding) {
          if (issue.code === 'WRITE_UNDEFINED' || issue.code === 'WRITE_INCONSISTENT' || issue.code === 'WRITE_UNSUPPORTED') {
            (binding as { readOnly?: boolean }).readOnly = true;
            dropAffordancesFor(k.id, binding.channel);
            actions.push({ code: issue.code, kind: k.id, action: `${binding.field}(${binding.channel}) 를 읽기 전용으로` });
          } else {
            const idx = k.channels.lastIndexOf(binding);
            k.channels.splice(idx, 1);
            const col = findCollection(schema, k.collection);
            if (col?.fields.some((f) => f.name === binding.field) && !k.channels.some((b) => b.field === binding.field)) k.hidden.push(binding.field);
            dropAffordancesFor(k.id, binding.channel);
            actions.push({ code: issue.code, kind: k.id, action: `${binding.field} → ${binding.channel} 대응 제거` });
          }
        } else if (k && issue.code === 'UNKNOWN_FIELD') {
          const col = findCollection(schema, k.collection);
          const exists = (f?: string) => !!f && !!col?.fields.some((x) => x.name === f);
          if (k.labelField && !exists(k.labelField)) delete k.labelField;
          if (k.route) {
            if (!exists(k.route.from)) delete k.route.from;
            if (!exists(k.route.to)) delete k.route.to;
          }
          if (k.recency && !exists(k.recency.field)) delete k.recency;
          if (k.filter) delete k.filter;
          actions.push({ code: issue.code, kind: k.id, action: '존재하지 않는 필드 참조 제거' });
        }
        break;
      case 'ROUTE_NOT_REF':
        if (k?.route) {
          delete k.route;
          actions.push({ code: issue.code, kind: k.id, action: '참조가 아닌 경로 제거' });
        }
        break;
      case 'UNKNOWN_REGION':
        if (k) {
          k.region = g.regions[0]?.id ?? 'market';
          if (!g.regions.length) g.regions.push({ id: 'market', title: '시장', theme: 'market' });
          actions.push({ code: issue.code, kind: k.id, action: `지역을 ${k.region} 로` });
        }
        break;
      case 'UNKNOWN_COLLECTION':
        if (k) {
          g.kinds = g.kinds.filter((x) => x !== k);
          dropAffordancesFor(k.id);
          actions.push({ code: issue.code, kind: k.id, action: '없는 컬렉션의 종류 제거' });
        } else {
          g.invariants = g.invariants.filter((i) => findCollection(schema, i.collection));
          actions.push({ code: issue.code, action: '없는 컬렉션의 불변식 제거' });
        }
        break;
      case 'AFFORDANCE':
      case 'AFFORDANCE_UNBOUND':
      case 'AFFORDANCE_READONLY':
      case 'AFFORDANCE_EMPTY':
      case 'AFFORDANCE_TYPE':
      case 'UNKNOWN_KIND': {
        const before = g.affordances.length;
        g.affordances = g.affordances.filter((a) => !issue.message.includes(a.title) && !issue.message.includes(`'${a.title}'`));
        if (g.affordances.length !== before) actions.push({ code: issue.code, action: '법칙을 어기는 행동 제거' });
        break;
      }
      case 'DUPLICATE_ID': {
        const seen = new Set<string>();
        g.invariants = g.invariants.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
        const seenA = new Set<string>();
        g.affordances = g.affordances.filter((a) => (seenA.has(a.id) ? false : (seenA.add(a.id), true)));
        const seenK = new Set<string>();
        g.kinds = g.kinds.filter((x) => (seenK.has(x.id) ? false : (seenK.add(x.id), true)));
        actions.push({ code: issue.code, action: '중복 id 제거' });
        break;
      }
      default:
        if (k && binding) {
          (binding as { readOnly?: boolean }).readOnly = true;
          dropAffordancesFor(k.id, binding.channel);
          actions.push({ code: issue.code, kind: k.id, action: `${binding.field} 편집 차단(보수적 수리)` });
        }
    }
  }

  // 경고: 설명되지 않은 필드는 '숨김'으로 명시
  for (const issue of report.issues.filter((i) => i.code === 'UNACCOUNTED_FIELD')) {
    const k = kindOf(issue.kind);
    const m = /: (\S+) 는 그려지지도/.exec(issue.message);
    if (k && m && !k.hidden.includes(m[1])) {
      k.hidden.push(m[1]);
      actions.push({ code: issue.code, kind: k.id, action: `${m[1]} 를 숨김으로 명시` });
    }
  }
  return { grammar: g, actions };
}
