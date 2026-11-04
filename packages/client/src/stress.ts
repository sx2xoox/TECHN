import type { HelloMessage, WorldEntity, WorldGrammar, WorldState } from '@isomorph/core';

/**
 * 부하 시험(?stress=N): 서버 없이 N개 개체의 합성 세계를 만들어 렌더러 성능(FPS)을 잰다.
 * 건물 70%, 움직이는 주민 30%, 매초 일부 채널 값이 바뀐다.
 */
export function stressHello(): HelloMessage {
  const grammar: WorldGrammar = {
    version: 1,
    system: 'stress',
    title: '부하 시험 마을',
    theme: 'town',
    generatedBy: 'manual',
    notes: [],
    regions: [
      { id: 'market', title: '시장', theme: 'market' },
      { id: 'residential', title: '주택가', theme: 'residential' },
      { id: 'industrial', title: '공업지대', theme: 'industrial' },
    ],
    kinds: [
      { id: 'wh', title: '창고', collection: 'wh', archetype: 'building', sprite: 'warehouse', spritePrompt: '', region: 'market', channels: [], hidden: [] },
      { id: 'house', title: '집', collection: 'house', archetype: 'building', sprite: 'house', spritePrompt: '', region: 'residential', channels: [], hidden: [] },
      { id: 'fac', title: '공장', collection: 'fac', archetype: 'building', sprite: 'factory', spritePrompt: '', region: 'industrial', channels: [], hidden: [] },
      { id: 'npc', title: '상인', collection: 'npc', archetype: 'npc', sprite: 'merchant', spritePrompt: '', region: 'market', channels: [], hidden: [] },
    ],
    invariants: [],
    affordances: [],
  };
  return {
    type: 'hello',
    system: 'stress',
    source: 'synthetic',
    grammar,
    legend: [],
    verification: { ok: true, issues: [], checks: [], fidelity: { score: 0, lawPassRate: 0, injectivity: 1, accounted: 1, visualCoverage: 1, perKind: [] }, totalRuns: 0, durationMs: 0, seed: 0 },
    writeMode: 'read-only',
    assets: null,
    pollMs: 1000,
  };
}

export function stressWorld(n: number, tick: number): WorldState {
  const buildings = Math.round(n * 0.7);
  const npcs = n - buildings;
  const kinds = ['wh', 'house', 'fac'] as const;
  const sprites = { wh: 'warehouse', house: 'house', fac: 'factory' } as const;
  const counts = [0, 0, 0];
  const entities: WorldEntity[] = [];
  for (let i = 0; i < buildings; i++) {
    const k = i % 3;
    const slot = counts[k]++;
    const wobble = (i * 7 + tick) % 13;
    entities.push({
      id: `${kinds[k]}:${slot}`,
      kind: kinds[k],
      archetype: 'building',
      sprite: sprites[kinds[k]],
      label: `${slot}`,
      region: ['market', 'residential', 'industrial'][k],
      slot,
      visual: { stack: k === 0 ? (wobble % 6) - (i % 97 === 0 ? 2 : 0) : null, lit: wobble % 5 !== 0, tint: (['green', 'yellow', 'red', 'blue'] as const)[i % 4], fire: k === 2 && wobble === 3 ? 2 : 0, crowd: k === 1 ? wobble % 3 : 0 },
      outOfRange: [],
      links: [],
      source: { collection: kinds[k], pk: slot },
      anomalies: i % 97 === 0 ? [{ invariantId: 'x', kind: 'ghost', message: '시험용 위반', proposed: false, severity: 'critical' }] : [],
    });
  }
  for (let i = 0; i < npcs; i++) {
    entities.push({
      id: `npc:${i}`,
      kind: 'npc',
      archetype: 'npc',
      sprite: 'merchant',
      label: `${i}`,
      region: 'market',
      slot: i,
      visual: { tint: (['yellow', 'green', 'red'] as const)[(i + tick) % 3] },
      outOfRange: [],
      links: [
        { role: 'from', target: `house:${i % Math.max(1, counts[1])}`, missing: false },
        { role: 'to', target: `wh:${(i * 3) % Math.max(1, counts[0])}`, missing: false },
      ],
      source: { collection: 'npc', pk: i },
      anomalies: [],
    });
  }
  return { ts: Date.now(), system: 'stress', regions: stressHello().grammar.regions, entities, violations: [] };
}
