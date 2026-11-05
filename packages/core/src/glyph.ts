/**
 * 색깔(tint) 채널의 모양 짝(글리프): 색만으로 구분하지 않도록 값마다 모양을 하나씩 더한다.
 * 색각 이상이 있는 사람, 흑백 인쇄, 작은 화면에서도 범주가 갈리게 하는 중복 부호화다.
 */
export const GLYPHS = ['check', 'cross', 'hourglass', 'warn', 'bar', 'dot', 'square', 'diamond', 'plus', 'corners'] as const;
export type GlyphName = (typeof GLYPHS)[number];

export const GLYPH_SYMBOL: Record<GlyphName, string> = { check: '✔', cross: '✖', hourglass: '⧗', warn: '△', bar: '−', dot: '●', square: '□', diamond: '◇', plus: '＋', corners: '⁘' };
export const GLYPH_KO: Record<GlyphName, string> = { check: '체크', cross: '엑스', hourglass: '모래시계', warn: '세모', bar: '막대', dot: '점', square: '네모', diamond: '마름모', plus: '십자', corners: '네 귀' };

/** 5×5 픽셀(깃발용) */
export const GLYPH_5: Record<GlyphName, string[]> = {
  check: ['.....', '....#', '...#.', '#.#..', '.#...'],
  cross: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  hourglass: ['#####', '.#.#.', '..#..', '.#.#.', '#####'],
  warn: ['..#..', '.#.#.', '.#.#.', '#...#', '#####'],
  bar: ['.....', '.....', '#####', '.....', '.....'],
  dot: ['.....', '.###.', '.###.', '.###.', '.....'],
  square: ['#####', '#...#', '#...#', '#...#', '#####'],
  diamond: ['..#..', '.#.#.', '#...#', '.#.#.', '..#..'],
  plus: ['..#..', '..#..', '#####', '..#..', '..#..'],
  corners: ['##.##', '#...#', '.....', '#...#', '##.##'],
};

/** 3×3 픽셀(걷는 주민의 옷용) */
export const GLYPH_3: Record<GlyphName, string[]> = {
  check: ['..#', '#.#', '.#.'],
  cross: ['#.#', '.#.', '#.#'],
  hourglass: ['###', '.#.', '###'],
  warn: ['.#.', '#.#', '###'],
  bar: ['...', '###', '...'],
  dot: ['...', '.#.', '...'],
  square: ['###', '#.#', '###'],
  diamond: ['.#.', '#.#', '.#.'],
  plus: ['.#.', '###', '.#.'],
  corners: ['#.#', '...', '#.#'],
};

/** 뜻이 있는 값은 뜻에 맞는 모양(성공 ✔, 실패 ✖, 대기 ⧗, 주의 △, 멈춤 −) */
const GLYPH_FAMILIES: [RegExp, GlyphName][] = [
  [/^(ok|active|paid|success|succeeded|running|completed?|done|delivered|open|online|healthy|approved|available|published|resolved|up|ready|stable)$/i, 'check'],
  [/^(failed|failing|failure|error|rejected|dead|exited|crashed|down|offline|unhealthy|blocked|banned|overdue|expired|critical|lost)$/i, 'cross'],
  [/^(pending|waiting|queued|created|processing|in_progress|new|draft|scheduled|starting|review|in_transit)$/i, 'hourglass'],
  [/^(degraded|warning|warn|unstable|slow|at_risk)$/i, 'warn'],
  [/^(cancelled|canceled|refunded|restarting|stopped|paused|suspended|archived|revoked|unset|unknown)$/i, 'bar'],
];
const NEUTRAL_GLYPHS: GlyphName[] = ['dot', 'square', 'diamond', 'plus', 'corners', 'check', 'cross', 'hourglass', 'warn', 'bar'];

/** 값마다 서로 다른 모양(단사): 뜻 있는 모양이 먼저, 나머지는 중립 모양 */
export function assignGlyphs(values: string[]): Record<string, GlyphName> {
  const used = new Set<GlyphName>();
  const out: Record<string, GlyphName> = {};
  for (const v of values.slice(0, GLYPHS.length)) {
    const want = GLYPH_FAMILIES.find(([re]) => re.test(v))?.[1];
    const g = want && !used.has(want) ? want : NEUTRAL_GLYPHS.find((x) => !used.has(x))!;
    out[v] = g;
    used.add(g);
  }
  return out;
}
