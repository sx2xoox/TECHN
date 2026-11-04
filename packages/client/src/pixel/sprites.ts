/**
 * 절차적 픽셀 아트. 외부 에셋 없이 코드로 그린 오리지널 16비트 풍 스프라이트.
 * (PixelLab 으로 생성한 에셋이 있으면 렌더러가 그것을 우선 사용한다)
 */
export type Ctx = CanvasRenderingContext2D;

export const OUT = '#2a1f2d';
const WIN_ON = '#ffe08a';
const WIN_ON_HI = '#fff6cf';
const WIN_OFF = '#33405f';
const WIN_OFF_HI = '#4b5b82';

export function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** 테두리 있는 사각형 */
function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, outline = OUT) {
  rect(ctx, x, y, w, h, outline);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

function shade(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  rect(ctx, x, y, w, h, color);
}

function windowAt(ctx: Ctx, x: number, y: number, w: number, h: number, lit: boolean) {
  box(ctx, x, y, w, h, lit ? WIN_ON : WIN_OFF);
  rect(ctx, x + 1, y + 1, Math.max(1, Math.floor((w - 2) / 2)), 1, lit ? WIN_ON_HI : WIN_OFF_HI);
  if (w >= 5) rect(ctx, x + Math.floor(w / 2), y + 1, 1, h - 2, OUT);
}

/** 계단식 박공 지붕 */
function gable(ctx: Ctx, cx: number, top: number, rows: number, startW: number, step: number, fill: string, dark: string, hi: string) {
  for (let r = 0; r < rows; r++) {
    const w = startW + r * step * 2;
    const x = cx - Math.floor(w / 2);
    rect(ctx, x - 1, top + r, w + 2, 1, OUT);
    rect(ctx, x, top + r, w, 1, r === rows - 1 ? dark : fill);
    if (r > 0 && r < rows - 1) rect(ctx, x, top + r, 2, 1, hi);
  }
}

function door(ctx: Ctx, x: number, y: number, w: number, h: number, open: boolean) {
  box(ctx, x, y, w, h, open ? '#3a2416' : '#7a4b2a');
  if (!open) {
    rect(ctx, x + 1, y + Math.floor(h / 2), w - 2, 1, '#5a361d');
    rect(ctx, x + w - 3, y + Math.floor(h / 2) + 1, 1, 1, '#f2c94c');
  } else {
    rect(ctx, x + 1, y + 1, w - 2, 1, '#ffd27a');
  }
}

export type BuildingKey =
  | 'house' | 'warehouse' | 'shop' | 'bank' | 'factory' | 'townhall' | 'library' | 'clinic' | 'school' | 'tower' | 'post' | 'farm'
  | 'theater' | 'station' | 'office' | 'signpost';

type Drawer = (ctx: Ctx, lit: boolean) => void;

const DRAW: Record<BuildingKey, { w: number; h: number; draw: Drawer }> = {
  house: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 21, 4, 4, 7, '#8c5a44');
      gable(ctx, 16, 5, 10, 6, 1, '#c8553d', '#913b2b', '#e8846b');
      box(ctx, 6, 14, 20, 16, '#f2e3c6');
      shade(ctx, 22, 15, 3, 14, '#d8c39f');
      windowAt(ctx, 8, 17, 5, 5, lit);
      windowAt(ctx, 19, 17, 5, 5, lit);
      door(ctx, 13, 22, 6, 8, lit);
      rect(ctx, 5, 29, 22, 1, OUT);
    },
  },
  warehouse: {
    w: 32, h: 32,
    draw(ctx, lit) {
      gable(ctx, 16, 5, 6, 18, 1, '#7d8e9c', '#596875', '#a7b6c2');
      box(ctx, 3, 11, 26, 19, '#a5733f');
      for (let x = 5; x < 28; x += 3) rect(ctx, x, 12, 1, 17, '#8a5c30');
      windowAt(ctx, 5, 13, 5, 4, lit);
      windowAt(ctx, 22, 13, 5, 4, lit);
      box(ctx, 10, 12, 12, 3, '#e8d39a');
      rect(ctx, 12, 13, 8, 1, '#9a6b44');
      if (lit) {
        box(ctx, 10, 17, 12, 13, '#2c1d14');
        box(ctx, 12, 23, 4, 4, '#c58b4a');
        box(ctx, 16, 25, 4, 4, '#b07a3c');
        rect(ctx, 11, 18, 10, 1, '#ffd27a');
      } else {
        box(ctx, 10, 17, 12, 13, '#6d4a2a');
        for (let y = 19; y < 29; y += 2) rect(ctx, 11, y, 10, 1, '#56391f');
        rect(ctx, 15, 22, 2, 3, '#c9ced6');
        rect(ctx, 15, 21, 2, 1, OUT);
      }
      rect(ctx, 2, 29, 28, 1, OUT);
    },
  },
  shop: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 4, 8, 24, 22, '#ecdcb4');
      box(ctx, 4, 5, 24, 4, '#7a4b2a');
      for (let i = 0; i < 6; i++) box(ctx, 3 + i * 4, 12, 5, 4, i % 2 ? '#f5f0e6' : '#d64545');
      windowAt(ctx, 6, 18, 9, 7, lit);
      door(ctx, 18, 19, 7, 11, lit);
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  bank: {
    w: 32, h: 32,
    draw(ctx, lit) {
      gable(ctx, 16, 4, 6, 6, 2, '#d7dade', '#a9aeb4', '#f1f2f4');
      box(ctx, 4, 10, 24, 3, '#c4c8cc');
      box(ctx, 4, 12, 24, 16, '#e3e5e8');
      for (const x of [6, 11, 19, 24]) box(ctx, x, 13, 3, 14, '#f4f5f7');
      windowAt(ctx, 15, 15, 3, 4, lit);
      door(ctx, 14, 21, 5, 7, lit);
      box(ctx, 2, 27, 28, 3, '#b9bec4');
      rect(ctx, 14, 6, 4, 2, '#f2c94c');
    },
  },
  factory: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 23, 1, 6, 16, '#7d3b32');
      rect(ctx, 23, 3, 6, 1, '#d7dade');
      for (let i = 0; i < 3; i++) {
        for (let r = 0; r < 5; r++) rect(ctx, 2 + i * 7, 8 + r, r + 2, 1, r === 0 ? OUT : '#66737c');
        rect(ctx, 2 + i * 7 + 6, 8, 1, 5, OUT);
      }
      box(ctx, 2, 12, 24, 18, '#a4493d');
      for (let y = 14; y < 29; y += 3) rect(ctx, 3, y, 22, 1, '#8a3a30');
      for (let x = 4; x < 24; x += 6) windowAt(ctx, x, 15, 4, 4, lit);
      door(ctx, 10, 21, 8, 9, lit);
      rect(ctx, 1, 29, 30, 1, OUT);
    },
  },
  townhall: {
    w: 48, h: 48,
    draw(ctx, lit) {
      rect(ctx, 23, 0, 1, 7, OUT);
      box(ctx, 19, 6, 10, 14, '#d9c9a3');
      box(ctx, 21, 8, 6, 6, '#f6f1e3');
      rect(ctx, 24, 9, 1, 3, OUT);
      rect(ctx, 24, 11, 2, 1, OUT);
      gable(ctx, 24, 18, 6, 26, 2, '#4f6d8f', '#384f69', '#7695b8');
      box(ctx, 5, 24, 38, 20, '#e6d7b4');
      for (const x of [8, 15, 30, 37]) box(ctx, x, 26, 3, 17, '#f6efdc');
      for (const x of [11, 33]) windowAt(ctx, x, 28, 4, 6, lit);
      windowAt(ctx, 19, 27, 4, 5, lit);
      windowAt(ctx, 25, 27, 4, 5, lit);
      door(ctx, 20, 34, 8, 10, lit);
      box(ctx, 3, 43, 42, 3, '#bcae8c');
      box(ctx, 7, 45, 34, 2, '#a89a79');
    },
  },
  library: {
    w: 32, h: 32,
    draw(ctx, lit) {
      for (let r = 0; r < 6; r++) {
        const w = 10 + r * 3;
        rect(ctx, 16 - Math.floor(w / 2) - 1, 4 + r, w + 2, 1, OUT);
        rect(ctx, 16 - Math.floor(w / 2), 4 + r, w, 1, r < 5 ? '#5e8c6a' : '#41664c');
      }
      box(ctx, 4, 10, 24, 20, '#9a7aa8');
      for (const x of [7, 14, 21]) {
        box(ctx, x, 13, 5, 8, lit ? WIN_ON : WIN_OFF);
        rect(ctx, x + 1, 13, 3, 1, OUT);
        rect(ctx, x + 2, 12, 1, 1, OUT);
      }
      door(ctx, 13, 23, 6, 7, lit);
      box(ctx, 7, 24, 4, 3, '#d64545');
      box(ctx, 21, 24, 4, 3, '#4a8fe7');
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  clinic: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 4, 7, 24, 4, '#4a7fb5');
      box(ctx, 4, 10, 24, 20, '#f4f4f2');
      box(ctx, 13, 12, 7, 7, '#ffffff');
      rect(ctx, 16, 13, 1, 5, '#e5533d');
      rect(ctx, 14, 15, 5, 1, '#e5533d');
      windowAt(ctx, 6, 13, 5, 5, lit);
      windowAt(ctx, 22, 13, 5, 5, lit);
      door(ctx, 13, 21, 7, 9, lit);
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  school: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 13, 1, 7, 8, '#c97a3d');
      rect(ctx, 15, 3, 3, 3, '#f2c94c');
      gable(ctx, 16, 8, 5, 18, 1, '#8c4b2f', '#6b3722', '#ad6844');
      box(ctx, 4, 13, 24, 17, '#e3a35f');
      for (const x of [6, 12, 21]) windowAt(ctx, x, 16, 5, 5, lit);
      door(ctx, 13, 22, 6, 8, lit);
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  tower: {
    w: 32, h: 32,
    draw(ctx, lit) {
      rect(ctx, 15, 0, 2, 4, OUT);
      rect(ctx, 15, 0, 2, 1, lit ? '#e5533d' : '#5a2a2a');
      for (let y = 4; y < 22; y++) {
        const half = 2 + Math.floor((y - 4) / 3);
        rect(ctx, 16 - half, y, 1, 1, OUT);
        rect(ctx, 16 + half - 1, y, 1, 1, OUT);
        if (y % 4 === 0) rect(ctx, 16 - half, y, half * 2, 1, '#8a8f98');
      }
      box(ctx, 20, 7, 6, 4, '#d7dade');
      box(ctx, 8, 21, 16, 9, '#c4b08a');
      windowAt(ctx, 10, 23, 4, 4, lit);
      door(ctx, 17, 23, 5, 7, lit);
      rect(ctx, 7, 29, 18, 1, OUT);
    },
  },
  post: {
    w: 32, h: 32,
    draw(ctx, lit) {
      gable(ctx, 16, 5, 7, 10, 1, '#c0392b', '#8e2a20', '#e0645a');
      box(ctx, 5, 12, 22, 18, '#f3e6c4');
      box(ctx, 12, 14, 8, 5, '#ffffff');
      rect(ctx, 13, 15, 3, 1, OUT);
      rect(ctx, 16, 15, 3, 1, OUT);
      rect(ctx, 15, 16, 2, 1, OUT);
      windowAt(ctx, 7, 20, 5, 5, lit);
      door(ctx, 18, 21, 6, 9, lit);
      box(ctx, 26, 22, 4, 7, '#d64545');
      rect(ctx, 4, 29, 24, 1, OUT);
    },
  },
  farm: {
    w: 32, h: 32,
    draw(ctx, lit) {
      gable(ctx, 16, 4, 8, 12, 1, '#7b2d26', '#5c211b', '#9c3d33');
      box(ctx, 4, 12, 24, 18, '#b5452f');
      box(ctx, 11, 17, 10, 13, '#f3e6c4');
      rect(ctx, 12, 18, 8, 11, lit ? '#7a4b2a' : '#4a2c18');
      for (let i = 0; i < 8; i++) {
        rect(ctx, 12 + i, 18 + Math.floor(i * 1.4), 1, 1, '#f3e6c4');
        rect(ctx, 19 - i, 18 + Math.floor(i * 1.4), 1, 1, '#f3e6c4');
      }
      windowAt(ctx, 6, 14, 4, 4, lit);
      windowAt(ctx, 22, 14, 4, 4, lit);
      box(ctx, 26, 24, 5, 6, '#e8c766');
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  /** 극장: 영화·음악·방송 같은 콘텐츠 */
  theater: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 4, 10, 24, 20, '#6b3f7a');
      box(ctx, 3, 4, 26, 7, '#2b2533');
      for (let x = 5; x < 28; x += 3) {
        rect(ctx, x, 5, 1, 1, lit ? '#ffd27a' : '#6d5d3f');
        rect(ctx, x, 9, 1, 1, lit ? '#ffd27a' : '#6d5d3f');
      }
      rect(ctx, 8, 7, 16, 1, '#e5533d');
      box(ctx, 6, 14, 5, 7, '#e8c766');
      box(ctx, 21, 14, 5, 7, '#5ce1e6');
      box(ctx, 12, 17, 8, 13, lit ? '#2c1d14' : '#4a2c18');
      for (let y = 18; y < 29; y++) {
        rect(ctx, 13, y, 2, 1, '#c0392b');
        rect(ctx, 17, y, 2, 1, '#c0392b');
      }
      rect(ctx, 3, 29, 26, 1, OUT);
    },
  },
  /** 역: 항공·철도·운송 */
  station: {
    w: 32, h: 32,
    draw(ctx, lit) {
      gable(ctx, 16, 5, 6, 24, 1, '#3f6f8f', '#2c5068', '#5e8fb0');
      box(ctx, 4, 11, 24, 15, '#d9cdb0');
      box(ctx, 13, 12, 6, 6, '#ffffff');
      rect(ctx, 16, 13, 1, 3, OUT);
      rect(ctx, 16, 15, 2, 1, OUT);
      windowAt(ctx, 6, 15, 5, 5, lit);
      windowAt(ctx, 21, 15, 5, 5, lit);
      door(ctx, 13, 19, 6, 7, lit);
      for (let x = 2; x < 30; x += 3) rect(ctx, x, 26, 1, 4, '#6b4a2a');
      rect(ctx, 1, 27, 30, 1, '#8a8f98');
      rect(ctx, 1, 29, 30, 1, '#8a8f98');
    },
  },
  /** 사무소: 회사·부서·팀·거래처 */
  office: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 6, 2, 20, 2, '#5f7184');
      box(ctx, 7, 3, 18, 27, '#8fa3b8');
      for (let y = 5; y < 22; y += 4) for (const x of [9, 14, 19]) windowAt(ctx, x, y, 3, 3, lit);
      door(ctx, 13, 23, 6, 7, lit);
      rect(ctx, 6, 29, 20, 1, OUT);
    },
  },
  /** 이정표: 분류·코드표·지역 같은 기준 정보 */
  signpost: {
    w: 32, h: 32,
    draw(ctx, lit) {
      box(ctx, 14, 2, 4, 4, lit ? '#ffd27a' : '#6d5d3f');
      box(ctx, 15, 6, 3, 22, '#7a4b2a');
      box(ctx, 5, 7, 15, 5, '#d9b26b');
      rect(ctx, 4, 9, 1, 1, OUT);
      rect(ctx, 7, 9, 10, 1, '#5a361d');
      box(ctx, 13, 14, 15, 5, '#c99a55');
      rect(ctx, 28, 16, 1, 1, OUT);
      rect(ctx, 15, 16, 10, 1, '#5a361d');
      box(ctx, 6, 21, 13, 4, '#d9b26b');
      rect(ctx, 8, 22, 8, 1, '#5a361d');
      box(ctx, 10, 27, 13, 3, '#8a8f98');
    },
  },
};

export function drawBuilding(key: string, lit: boolean): HTMLCanvasElement {
  const d = DRAW[(key in DRAW ? key : 'shop') as BuildingKey];
  const [c, ctx] = canvas(d.w, d.h);
  d.draw(ctx, lit);
  return c;
}

export function buildingSize(key: string): { w: number; h: number } {
  const d = DRAW[(key in DRAW ? key : 'shop') as BuildingKey];
  return { w: d.w, h: d.h };
}

/* ───────────────────────────── 인물 ───────────────────────────── */

const SKIN = '#f1c27d';
const HAIR = '#3b2a20';
const PANTS = '#3c4a6b';

/** 12x16 걷는 인물(2프레임). shirt 는 tint 채널 색 */
export function drawWalker(kind: string, shirt: string, frame: 0 | 1, carrying = false): HTMLCanvasElement {
  const [c, ctx] = canvas(12, 16);
  if (kind === 'robot') {
    rect(ctx, 6, 0, 1, 2, OUT);
    rect(ctx, 6, 0, 1, 1, '#e5533d');
    box(ctx, 3, 2, 7, 5, '#9aa5b1');
    rect(ctx, 4, 4, 5, 1, '#5ce1e6');
    box(ctx, 2, 7, 9, 6, '#7f8a96');
    box(ctx, 4, 8, 5, 3, shirt);
    rect(ctx, frame ? 3 : 4, 13, 2, 3, OUT);
    rect(ctx, frame ? 8 : 7, 13, 2, 3, OUT);
    return c;
  }
  // 머리
  box(ctx, 3, 1, 6, 6, SKIN);
  rect(ctx, 3, 1, 6, 2, HAIR);
  rect(ctx, 4, 4, 1, 1, OUT);
  rect(ctx, 7, 4, 1, 1, OUT);
  if (kind === 'merchant') {
    rect(ctx, 2, 0, 8, 2, '#7a4b2a');
    rect(ctx, 1, 2, 10, 1, '#5a361d');
  } else if (kind === 'courier') {
    rect(ctx, 3, 0, 6, 2, '#4a8fe7');
    rect(ctx, 8, 2, 3, 1, '#2f6dbf');
  }
  // 몸통
  box(ctx, 2, 7, 8, 5, shirt);
  rect(ctx, 3, 8, 1, 3, 'rgba(255,255,255,0.35)');
  // 다리
  const l = frame ? 3 : 4;
  const r = frame ? 7 : 6;
  rect(ctx, l, 12, 2, 3, PANTS);
  rect(ctx, r, 12, 2, 3, PANTS);
  rect(ctx, l, 15, 2, 1, OUT);
  rect(ctx, r, 15, 2, 1, OUT);
  if (kind === 'merchant' && !carrying) box(ctx, 0, 7, 3, 4, '#c9a26b');
  if (kind === 'courier' && !carrying) box(ctx, 9, 8, 3, 3, '#c58b4a');
  if (carrying) {
    box(ctx, 3, 5, 6, 5, '#c58b4a');
    rect(ctx, 4, 7, 4, 1, '#8a5c30');
  }
  return c;
}

/** 6x9 작은 구경꾼(인파 채널) */
export function drawTiny(color: string, frame: 0 | 1): HTMLCanvasElement {
  const [c, ctx] = canvas(6, 9);
  box(ctx, 1, 0, 4, 4, SKIN);
  rect(ctx, 1, 0, 4, 1, HAIR);
  box(ctx, 1, 4, 4, 3, color);
  rect(ctx, frame ? 1 : 2, 7, 1, 2, PANTS);
  rect(ctx, frame ? 4 : 3, 7, 1, 2, PANTS);
  return c;
}

/* ───────────────────────────── 소품·효과 ───────────────────────────── */

export function drawCrate(ghost = false): HTMLCanvasElement {
  const [c, ctx] = canvas(7, 7);
  if (ghost) {
    ctx.globalAlpha = 0.75;
    box(ctx, 0, 0, 7, 7, '#ff5a5a', '#ffd0d0');
    rect(ctx, 1, 1, 5, 5, 'rgba(255,90,90,0.45)');
    for (let i = 1; i < 6; i++) rect(ctx, i, i, 1, 1, '#ffe2e2');
  } else {
    box(ctx, 0, 0, 7, 7, '#c58b4a', '#6b4226');
    for (let i = 1; i < 6; i++) {
      rect(ctx, i, i, 1, 1, '#8a5c30');
      rect(ctx, 6 - i, i, 1, 1, '#8a5c30');
    }
  }
  return c;
}

export function drawFlame(frame: number): HTMLCanvasElement {
  const [c, ctx] = canvas(8, 10);
  const f = frame % 3;
  const outer = [
    [3, 0, 2, 1], [2, 1, 4, 2], [1, 3, 6, 4], [1, 7, 6, 2], [2, 9, 4, 1],
  ];
  for (const [x, y, w, h] of outer) rect(ctx, x + (f === 1 && y < 3 ? 1 : 0), y + (f === 2 ? 1 : 0), w, h, '#e5533d');
  rect(ctx, 2, 4, 4, 4, '#ff8c1a');
  rect(ctx, 3, f === 0 ? 3 : 4, 2, 4, '#ffdd57');
  rect(ctx, 3, 6, 2, 2, '#fff3b0');
  return c;
}

export function drawSmoke(): HTMLCanvasElement {
  const [c, ctx] = canvas(6, 6);
  rect(ctx, 1, 0, 4, 6, '#9aa0a8');
  rect(ctx, 0, 1, 6, 4, '#9aa0a8');
  rect(ctx, 1, 1, 2, 2, '#c4c8ce');
  return c;
}

export function drawBubble(symbol: '!' | '?' | '✕' | '⏱', color = '#ffffff'): HTMLCanvasElement {
  const [c, ctx] = canvas(11, 12);
  box(ctx, 0, 0, 11, 9, color);
  rect(ctx, 3, 9, 3, 1, OUT);
  rect(ctx, 4, 10, 1, 1, OUT);
  rect(ctx, 4, 9, 1, 1, color);
  const ink = symbol === '!' ? '#e5533d' : OUT;
  if (symbol === '!') {
    rect(ctx, 5, 2, 1, 3, ink);
    rect(ctx, 5, 6, 1, 1, ink);
  } else if (symbol === '?') {
    rect(ctx, 4, 2, 3, 1, ink);
    rect(ctx, 7, 3, 1, 1, ink);
    rect(ctx, 6, 4, 1, 1, ink);
    rect(ctx, 5, 5, 1, 1, ink);
    rect(ctx, 5, 7, 1, 1, ink);
  } else if (symbol === '✕') {
    for (let i = 0; i < 5; i++) {
      rect(ctx, 3 + i, 2 + i, 1, 1, '#e5533d');
      rect(ctx, 7 - i, 2 + i, 1, 1, '#e5533d');
    }
  } else {
    rect(ctx, 3, 2, 5, 5, '#ffffff');
    rect(ctx, 3, 2, 5, 1, OUT);
    rect(ctx, 3, 6, 5, 1, OUT);
    rect(ctx, 3, 2, 1, 5, OUT);
    rect(ctx, 7, 2, 1, 5, OUT);
    rect(ctx, 5, 3, 1, 2, OUT);
    rect(ctx, 4, 4, 1, 1, OUT);
  }
  return c;
}

export function drawFlag(color: string): HTMLCanvasElement {
  const [c, ctx] = canvas(8, 10);
  rect(ctx, 0, 0, 1, 10, OUT);
  box(ctx, 1, 0, 7, 5, color);
  rect(ctx, 2, 1, 2, 1, 'rgba(255,255,255,0.5)');
  return c;
}

export function drawTree(variant: number): HTMLCanvasElement {
  const [c, ctx] = canvas(16, 22);
  const greens = [['#3f8f4f', '#2f6e3c', '#62b36f'], ['#4d9a45', '#386f33', '#79c26c'], ['#2f7d5b', '#235f45', '#4fa47e']][variant % 3];
  rect(ctx, 7, 14, 3, 7, '#6b4226');
  rect(ctx, 7, 14, 1, 7, '#8a5c30');
  for (const [x, y, w, h] of [[3, 2, 10, 12], [1, 5, 14, 7], [5, 0, 6, 15]]) rect(ctx, x, y, w, h, OUT);
  for (const [x, y, w, h] of [[4, 3, 8, 10], [2, 6, 12, 5], [6, 1, 4, 13]]) rect(ctx, x, y, w, h, greens[0]);
  rect(ctx, 3, 9, 10, 3, greens[1]);
  rect(ctx, 5, 3, 3, 2, greens[2]);
  rect(ctx, 4, 5, 2, 2, greens[2]);
  return c;
}

export function drawFountain(): HTMLCanvasElement {
  const [c, ctx] = canvas(32, 24);
  box(ctx, 2, 10, 28, 12, '#b9bec4');
  rect(ctx, 4, 12, 24, 8, '#4a8fe7');
  rect(ctx, 6, 13, 6, 1, '#9cc6ff');
  rect(ctx, 18, 16, 6, 1, '#9cc6ff');
  box(ctx, 13, 4, 6, 10, '#d7dade');
  rect(ctx, 15, 0, 2, 5, '#9cc6ff');
  rect(ctx, 12, 2, 2, 2, '#9cc6ff');
  rect(ctx, 18, 2, 2, 2, '#9cc6ff');
  return c;
}

export function drawLamp(on: boolean): HTMLCanvasElement {
  const [c, ctx] = canvas(5, 16);
  rect(ctx, 2, 4, 1, 12, OUT);
  box(ctx, 0, 0, 5, 5, on ? '#ffe08a' : '#5b6170');
  rect(ctx, 1, 15, 3, 1, OUT);
  return c;
}

/* ───────────────────────────── 바닥 타일 ───────────────────────────── */

export type Ground = 'grass' | 'market' | 'residential' | 'finance' | 'industrial' | 'civic' | 'plaza' | 'farmland' | 'road' | 'sidewalk';

function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 16x16 타일 하나를 그린다(좌표 기반 결정적 변형) */
export function drawTile(ctx: Ctx, kind: Ground, ox: number, oy: number, tx: number, ty: number) {
  const r = hash(tx, ty);
  switch (kind) {
    case 'grass': {
      rect(ctx, ox, oy, 16, 16, '#7fb069');
      for (let i = 0; i < 4; i++) {
        const x = Math.floor(hash(tx, ty, i) * 15);
        const y = Math.floor(hash(ty, tx, i + 7) * 14);
        rect(ctx, ox + x, oy + y, 1, 2, '#6a9b57');
      }
      if (r > 0.86) {
        const fx = Math.floor(hash(tx, ty, 9) * 12) + 2;
        const fy = Math.floor(hash(tx, ty, 11) * 12) + 2;
        const colors = ['#f2c94c', '#ffffff', '#e77fb3', '#9b6bd6'];
        rect(ctx, ox + fx, oy + fy, 2, 2, colors[Math.floor(r * 40) % colors.length]);
      }
      break;
    }
    case 'road':
      rect(ctx, ox, oy, 16, 16, '#7d7468');
      if (r > 0.6) rect(ctx, ox + Math.floor(r * 12), oy + Math.floor(hash(ty, tx) * 12), 2, 1, '#6c645a');
      break;
    case 'sidewalk':
      rect(ctx, ox, oy, 16, 16, '#c9bfa8');
      rect(ctx, ox, oy + 15, 16, 1, '#b3a990');
      rect(ctx, ox + 15, oy, 1, 16, '#b3a990');
      break;
    case 'market':
      rect(ctx, ox, oy, 16, 16, '#d8c7a0');
      for (let y = 0; y < 16; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < 16; x += 4) rect(ctx, ox + x, oy + y, 3, 3, '#cbb88f');
      break;
    case 'residential':
      rect(ctx, ox, oy, 16, 16, '#8cbc72');
      if (r > 0.7) rect(ctx, ox + 5, oy + 6, 2, 2, '#f7f3e8');
      break;
    case 'finance':
      rect(ctx, ox, oy, 16, 16, '#d5d8dc');
      rect(ctx, ox, oy, 16, 1, '#c3c7cc');
      rect(ctx, ox, oy, 1, 16, '#c3c7cc');
      rect(ctx, ox + 8, oy, 1, 16, '#c9cdd2');
      break;
    case 'industrial':
      rect(ctx, ox, oy, 16, 16, '#9d968a');
      for (let i = 0; i < 6; i++) rect(ctx, ox + Math.floor(hash(tx, ty, i) * 15), oy + Math.floor(hash(ty, tx, i) * 15), 1, 1, '#857e72');
      break;
    case 'civic':
      rect(ctx, ox, oy, 16, 16, '#c98b6b');
      for (let y = 0; y < 16; y += 4) {
        rect(ctx, ox, oy + y, 16, 1, '#b07558');
        rect(ctx, ox + ((y / 4) % 2 ? 4 : 12), oy + y, 1, 4, '#b07558');
      }
      break;
    case 'plaza':
      rect(ctx, ox, oy, 16, 16, '#e3d9c2');
      if ((tx + ty) % 2 === 0) rect(ctx, ox + 1, oy + 1, 14, 14, '#ebe3cf');
      break;
    case 'farmland':
      rect(ctx, ox, oy, 16, 16, '#a67c52');
      for (let y = 2; y < 16; y += 5) rect(ctx, ox, oy + y, 16, 2, '#8a6440');
      if (r > 0.5) rect(ctx, ox + 6, oy + 1, 1, 2, '#6fae4f');
      break;
  }
}
