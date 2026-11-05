import { Assets, Texture } from 'pixi.js';
import type { AssetManifest, ColorName } from '@isomorph/core';
import { PALETTE, type GlyphName } from '@isomorph/core';
import {
  buildingSize,
  drawBubble,
  drawBuilding,
  drawCrate,
  drawFlag,
  drawFlame,
  drawFountain,
  drawLamp,
  drawSmoke,
  drawTiny,
  drawTree,
  drawWalker,
} from './sprites.ts';

/** 캔버스 → 텍스처 캐시. PixelLab 생성 에셋이 있으면 그것을 우선한다. */
export class TextureBank {
  private cache = new Map<string, Texture>();
  private generated = new Map<string, Texture>();

  async loadGenerated(manifest: AssetManifest | null, base = '/generated/') {
    if (!manifest) return;
    for (const [key, entry] of Object.entries(manifest.assets)) {
      if (entry.source !== 'pixellab') continue;
      try {
        const tex = await Assets.load<Texture>({ src: `${base}${entry.file}`, data: { scaleMode: 'nearest' } });
        tex.source.scaleMode = 'nearest';
        this.generated.set(key, tex);
      } catch {
        /* 생성 에셋을 못 읽으면 절차적 스프라이트로 */
      }
    }
  }

  hasGenerated(key: string) {
    return this.generated.has(key);
  }

  private get(key: string, make: () => HTMLCanvasElement): Texture {
    let t = this.cache.get(key);
    if (!t) {
      t = Texture.from(make());
      t.source.scaleMode = 'nearest';
      this.cache.set(key, t);
    }
    return t;
  }

  building(sprite: string, lit: boolean): Texture {
    return this.generated.get(sprite) ?? this.get(`b:${sprite}:${lit}`, () => drawBuilding(sprite, lit));
  }

  buildingSize(sprite: string) {
    const g = this.generated.get(sprite);
    if (g) {
      const scale = 32 / Math.max(g.width, g.height);
      return { w: Math.round(g.width * scale), h: Math.round(g.height * scale), scale };
    }
    return { ...buildingSize(sprite), scale: 1 };
  }

  walker(sprite: string, color: ColorName | string | null, frame: 0 | 1, carrying = false, glyph: GlyphName | null = null): Texture {
    const hex = color && color in PALETTE ? PALETTE[color as ColorName].hex : '#8a8f98';
    return this.get(`w:${sprite}:${hex}:${frame}:${carrying}:${glyph}`, () => drawWalker(sprite, hex, frame, carrying, glyph));
  }

  tiny(colorIdx: number, frame: 0 | 1): Texture {
    const colors = ['#4a8fe7', '#e77fb3', '#5bbf4a', '#f08a3c', '#9b6bd6'];
    const c = colors[colorIdx % colors.length];
    return this.get(`t:${c}:${frame}`, () => drawTiny(c, frame));
  }

  crate(ghost = false) {
    return this.get(`crate:${ghost}`, () => drawCrate(ghost));
  }
  flame(frame: number) {
    return this.get(`flame:${frame % 3}`, () => drawFlame(frame));
  }
  smoke() {
    return this.get('smoke', drawSmoke);
  }
  bubble(symbol: '!' | '?' | '✕' | '⏱') {
    return this.get(`bubble:${symbol}`, () => drawBubble(symbol));
  }
  flag(color: ColorName | string, glyph: GlyphName | null = null) {
    const hex = color in PALETTE ? PALETTE[color as ColorName].hex : color;
    return this.get(`flag:${hex}:${glyph}`, () => drawFlag(hex, glyph));
  }
  tree(v: number) {
    return this.get(`tree:${v % 3}`, () => drawTree(v));
  }
  fountain() {
    return this.get('fountain', drawFountain);
  }
  lamp(on: boolean) {
    return this.get(`lamp:${on}`, () => drawLamp(on));
  }
}

/** 범례·인스펙터용 작은 미리보기 이미지(data URL) */
export function spriteDataUrl(sprite: string, archetype: string): string {
  const c = archetype === 'npc' ? drawWalker(sprite, PALETTE.blue.hex, 0) : drawBuilding(sprite, true);
  return c.toDataURL();
}
