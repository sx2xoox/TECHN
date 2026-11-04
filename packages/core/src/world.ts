import type { AnomalyKind, Archetype, ChannelName, Region, SpriteKey } from './grammar.ts';
import type { Pk, Row } from './schema.ts';

/** 세계 쪽 상태. lens.get 의 결과이며 렌더러가 그리는 유일한 입력이다. */
export type VisualValue = number | string | boolean | null;

export interface WorldLink {
  role: 'from' | 'to';
  /** 대상 엔티티 id. 참조 값이 비어 있으면 null */
  target: string | null;
  /** 참조 값은 있는데 대상이 세계에 없음(=길 잃음) */
  missing: boolean;
}

export interface EntityAnomaly {
  invariantId: string;
  kind: AnomalyKind;
  message: string;
  proposed: boolean;
  severity: 'info' | 'warning' | 'critical';
}

export interface WorldEntity {
  id: string;
  kind: string;
  archetype: Archetype;
  sprite: SpriteKey;
  label: string;
  region: string;
  /** 지역 안에서의 안정적인 자리 번호 */
  slot: number;
  visual: Partial<Record<ChannelName, VisualValue>>;
  /** 선언된 범위를 벗어난 값을 가진 채널(절대 조용히 잘라내지 않는다) */
  outOfRange: ChannelName[];
  links: WorldLink[];
  source: { collection: string; pk: Pk };
  anomalies: EntityAnomaly[];
}

export interface Violation {
  invariantId: string;
  collection: string;
  pk: Pk;
  title: string;
  kind: AnomalyKind;
  severity: 'info' | 'warning' | 'critical';
  proposed: boolean;
  values: Row;
}

export interface WorldState {
  ts: number;
  system: string;
  regions: Region[];
  entities: WorldEntity[];
  violations: Violation[];
}
