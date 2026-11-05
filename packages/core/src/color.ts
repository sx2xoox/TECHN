import { PALETTE, type ColorName } from './grammar.ts';

/**
 * 색각 이상 시뮬레이션과 색 차이(CIEDE2000).
 * 세계의 '색깔' 채널이 색각 이상이 있는 사람에게도 구분되는지 재기 위해 쓴다.
 *  - Machado, Oliveira & Fernandes (2009), 심도 1.0 행렬(선형 RGB 에 적용)
 *  - CIEDE2000 (Sharma, Wu & Dalal 2005 구현 노트)
 */
export type Vision = 'normal' | 'protan' | 'deutan' | 'tritan';
export const VISIONS: Vision[] = ['normal', 'protan', 'deutan', 'tritan'];
export const VISION_KO: Record<Vision, string> = { normal: '일반 색각', protan: '적색맹(1형)', deutan: '녹색맹(2형)', tritan: '청색맹(3형)' };

/** 선형 RGB 에 곱하는 3×3 행렬(행 우선) */
export const CVD_MATRIX: Record<Exclude<Vision, 'normal'>, number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** 색각 유형으로 본 sRGB(0~1) */
export function simulateVision(rgb: [number, number, number], vision: Vision): [number, number, number] {
  if (vision === 'normal') return rgb;
  const m = CVD_MATRIX[vision];
  const [r, g, b] = rgb.map(toLinear);
  return [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b].map((x) => toGamma(clamp01(x))) as [number, number, number];
}

function rgbToLab([r0, g0, b0]: [number, number, number]): [number, number, number] {
  const [r, g, b] = [r0, g0, b0].map(toLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 색 차이(sRGB 0~1 입력) */
export function deltaE2000(a: [number, number, number], b: [number, number, number]): number {
  return deltaE2000Lab(rgbToLab(a), rgbToLab(b));
}

/** CIEDE2000 색 차이(CIELAB 입력) — Sharma(2005) 시험 자료로 검증 */
export function deltaE2000Lab([L1, a1, b1]: [number, number, number], [L2, a2, b2]: [number, number, number]): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (ap: number, bb: number) => {
    if (ap === 0 && bb === 0) return 0;
    const v = Math.atan2(bb, ap) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lmp = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hmp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hmp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hmp = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hmp - 30) * rad) + 0.24 * Math.cos(2 * hmp * rad) + 0.32 * Math.cos((3 * hmp + 6) * rad) - 0.2 * Math.cos((4 * hmp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hmp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lmp - 50) ** 2) / Math.sqrt(20 + (Lmp - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** 팔레트 두 색이 그 색각 유형에서 얼마나 달라 보이는가 */
export function colorDistance(a: ColorName, b: ColorName, vision: Vision): number {
  return deltaE2000(simulateVision(hexToRgb(PALETTE[a].hex), vision), simulateVision(hexToRgb(PALETTE[b].hex), vision));
}

/** 작은 스프라이트에서 범주를 나눠 보기 위한 최소 색 차이(보수적 기준) */
export const MIN_DISTINGUISHABLE_DE = 12;

/** 색 묶음에서 가장 헷갈리는 한 쌍(색각 유형별) */
export function closestPair(colors: ColorName[], vision: Vision): { a: ColorName; b: ColorName; de: number } | null {
  let best: { a: ColorName; b: ColorName; de: number } | null = null;
  for (let i = 0; i < colors.length; i++)
    for (let j = i + 1; j < colors.length; j++) {
      const de = colorDistance(colors[i], colors[j], vision);
      if (!best || de < best.de) best = { a: colors[i], b: colors[j], de };
    }
  return best;
}
