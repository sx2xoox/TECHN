import type { Region } from '@isomorph/core';

/** 마을 배치: 지역 = 구역(district), 건물 = 필지(plot), 길 = 경로 계산의 뼈대 */
export const T = 16;
export const PLOT_W = 5;
export const PLOT_H = 5;
const LANDMARK_W = 8;
const LANDMARK_H = 6;
const TOP = 3;
const LEFT = 2;

export interface Point {
  x: number;
  y: number;
}

export interface Plot {
  district: number;
  /** 필지 왼쪽 위 (px) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 건물 바닥 중앙(문 앞) */
  door: Point;
  /** 필지 아래 골목의 y (px, 중앙) */
  streetY: number;
}

export interface District {
  region: Region;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  plotW: number;
  plotH: number;
  capacity: number;
  landmark: boolean;
  /** 구역 왼쪽 세로길 x (px, 중앙) */
  roadX: number;
}

export interface TownLayout {
  width: number;
  height: number;
  districts: District[];
  mainRoadY: number;
  /** kind → 같은 구역 안에서의 필지 시작 번호 */
  kindOffset: Map<string, number>;
  kindRegion: Map<string, number>;
  kindCapacity: Map<string, number>;
  /** 배치를 다시 계산해야 하는지 판단하는 열쇠 */
  key: string;
}

export interface KindCount {
  kind: string;
  region: string;
  count: number;
  landmark: boolean;
}

/** 여유 공간을 둔 수용량: 행이 조금 늘어도 배치가 흔들리지 않게 */
function capacityFor(n: number) {
  return Math.max(4, n + Math.ceil(n * 0.2));
}

export function computeLayout(regions: Region[], kinds: KindCount[]): TownLayout {
  const districts: District[] = [];
  const kindOffset = new Map<string, number>();
  const kindRegion = new Map<string, number>();
  const kindCapacity = new Map<string, number>();
  let x = LEFT * T;
  let maxH = 0;
  const keyParts: string[] = [];

  for (const region of regions) {
    const ks = kinds.filter((k) => k.region === region.id);
    if (!ks.length) continue;
    const landmark = ks.every((k) => k.landmark);
    let capacity = 0;
    for (const k of ks) {
      kindOffset.set(k.kind, capacity);
      const cap = landmark ? Math.max(1, k.count) : capacityFor(k.count);
      kindCapacity.set(k.kind, cap);
      capacity += cap;
      keyParts.push(`${k.kind}:${cap}`);
    }
    const plotW = landmark ? LANDMARK_W : PLOT_W;
    const plotH = landmark ? LANDMARK_H : PLOT_H;
    const cols = landmark ? Math.max(1, Math.min(capacity, 3)) : Math.max(2, Math.ceil(Math.sqrt(capacity * 2.2)));
    const rows = Math.ceil(capacity / cols);
    const w = (1 + cols * plotW + 1) * T;
    const h = rows * plotH * T;
    const index = districts.length;
    for (const k of ks) kindRegion.set(k.kind, index);
    districts.push({ region, x, y: TOP * T, w, h, cols, rows, plotW, plotH, capacity, landmark, roadX: x + T / 2 });
    maxH = Math.max(maxH, h);
    x += w + T;
  }
  const mainRoadY = TOP * T + maxH + T;
  const width = x + LEFT * T;
  const height = mainRoadY + 4 * T;
  return { width, height, districts, mainRoadY, kindOffset, kindRegion, kindCapacity, key: keyParts.join('|') };
}

export function plotFor(layout: TownLayout, kind: string, slot: number): Plot | null {
  const di = layout.kindRegion.get(kind);
  if (di === undefined) return null;
  const d = layout.districts[di];
  const index = Math.min((layout.kindOffset.get(kind) ?? 0) + slot, d.capacity - 1);
  const col = index % d.cols;
  const row = Math.floor(index / d.cols);
  const px = d.x + T + col * d.plotW * T;
  const py = d.y + row * d.plotH * T;
  const streetY = py + (d.plotH - 1) * T + T / 2;
  return { district: di, x: px, y: py, w: d.plotW * T, h: d.plotH * T, door: { x: px + (d.plotW * T) / 2, y: py + (d.plotH - 1) * T - 1 }, streetY };
}

/** 문 A → 골목 → 세로길 → 큰길 → 세로길 → 골목 → 문 B */
export function pathBetween(layout: TownLayout, a: Plot | null, b: Plot | null): Point[] {
  const edgeL: Point = { x: 0, y: layout.mainRoadY };
  const edgeR: Point = { x: layout.width, y: layout.mainRoadY };
  const out = (p: Plot): Point[] => {
    const d = layout.districts[p.district];
    return [p.door, { x: p.door.x, y: p.streetY }, { x: d.roadX, y: p.streetY }, { x: d.roadX, y: layout.mainRoadY }];
  };
  if (!a && !b) return [edgeL, edgeR];
  if (!a) return [edgeL, ...out(b!).reverse()];
  if (!b) return [...out(a), edgeR];
  if (a.district === b.district) {
    if (a.streetY === b.streetY) return [a.door, { x: a.door.x, y: a.streetY }, { x: b.door.x, y: b.streetY }, b.door];
    const d = layout.districts[a.district];
    return [a.door, { x: a.door.x, y: a.streetY }, { x: d.roadX, y: a.streetY }, { x: d.roadX, y: b.streetY }, { x: b.door.x, y: b.streetY }, b.door];
  }
  return [...out(a), ...out(b).reverse()];
}

export function pathLength(path: Point[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
  return n;
}

export function pointAt(path: Point[], dist: number): { p: Point; dir: number } {
  let left = dist;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (left <= seg || i === path.length - 1) {
      const t = seg === 0 ? 1 : Math.min(1, left / seg);
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: Math.sign(b.x - a.x) };
    }
    left -= seg;
  }
  return { p: path.at(-1)!, dir: 0 };
}
