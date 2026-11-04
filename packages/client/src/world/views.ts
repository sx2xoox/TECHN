import { Container, Graphics, Rectangle, Sprite, Text, Texture } from 'pixi.js';
import { PALETTE, type AnomalyKind, type ColorName, type WorldEntity } from '@isomorph/core';
import type { TextureBank } from '../pixel/textures.ts';
import { pathLength, pointAt, T, type Plot, type Point } from './layout.ts';

/** 이름표·간판이 옆 건물과 겹치지 않게 줄인다(전체 값은 말풍선·인스펙터에 있다) */
const LABEL_MAX = 11;
const shorten = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

export const LABEL_FONT = 'Galmuri9';

export function pixelText(text: string, color = '#2a1f2d', size = 10, stroke?: string): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: LABEL_FONT,
      fontSize: size,
      fill: color,
      ...(stroke ? { stroke: { color: stroke, width: 2 } } : {}),
    },
    resolution: 2,
    textureStyle: { scaleMode: 'nearest' },
  });
  t.roundPixels = true;
  return t;
}

const GOOD: ColorName[] = ['green', 'teal'];

function hexNum(c: string): number {
  return parseInt(c.replace('#', ''), 16);
}

function rand(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967295;
}

function seedOf(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface ViewContext {
  bank: TextureBank;
  showLabels: boolean;
}

abstract class EntityView extends Container {
  entity!: WorldEntity;
  readonly outline = new Graphics();
  selected = false;
  hovered = false;
  protected rnd: () => number;
  protected anomalyKinds = new Set<AnomalyKind>();

  constructor(readonly id: string, protected ctx: ViewContext) {
    super();
    this.rnd = rand(seedOf(id));
    this.eventMode = 'static';
    this.cursor = 'pointer';
  }

  abstract setEntity(e: WorldEntity): void;
  abstract animate(t: number, dt: number, speed: number): void;
  abstract box(): { x: number; y: number; w: number; h: number };

  private outlineDrawn = false;

  protected drawOutline(t: number) {
    const anomalous = this.anomalyKinds.size > 0;
    if (!anomalous && !this.selected && !this.hovered) {
      if (this.outlineDrawn) {
        this.outline.clear();
        this.outlineDrawn = false;
      }
      return;
    }
    this.outlineDrawn = true;
    const b = this.box();
    const g = this.outline;
    g.clear();
    if (anomalous) {
      const pulse = 0.45 + 0.45 * Math.sin(t * 6);
      g.rect(b.x - 2, b.y - 2, b.w + 4, b.h + 4).stroke({ color: 0xff3b3b, width: 1, alpha: pulse });
    }
    if (this.selected) {
      const dash = Math.floor(t * 8) % 2;
      g.rect(b.x - 4, b.y - 4, b.w + 8, b.h + 8).stroke({ color: dash ? 0xffffff : 0x4a8fe7, width: 1 });
    } else if (this.hovered) {
      g.rect(b.x - 3, b.y - 3, b.w + 6, b.h + 6).stroke({ color: 0xffffff, width: 1, alpha: 0.8 });
    }
  }
}

/* ───────────────────────────── 건물 ───────────────────────────── */

export class BuildingView extends EntityView {
  private shadow = new Graphics();
  private body = new Container();
  private sprite = new Sprite();
  private slices: Sprite[] = [];
  private twin = new Sprite();
  private flag = new Sprite();
  private crates = new Container();
  private ghosts = new Container();
  private flames = new Container();
  private smoke: { s: Sprite; life: number }[] = [];
  private crowd: { s: Sprite; home: Point; target: Point; frame: number }[] = [];
  private crowdLayer = new Container();
  private fog = new Graphics();
  private bubble = new Sprite();
  private clock = new Sprite();
  private nameText: Text;
  private signText: Text;
  private overflow: Text;
  private bw = 32;
  private bh = 32;
  private glitchTimer = 0;
  private lit = true;
  private texLit!: Texture;
  private texDark!: Texture;

  constructor(id: string, ctx: ViewContext, readonly plot: Plot) {
    super(id, ctx);
    this.nameText = pixelText('', '#2a1f2d', 10, '#f6f1e3');
    this.signText = pixelText('', '#5a361d', 10, '#f6f1e3');
    this.overflow = pixelText('', '#e5533d', 10, '#ffffff');
    this.addChild(this.shadow, this.crowdLayer, this.twin, this.body, this.crates, this.ghosts, this.flag, this.flames, this.fog, this.clock, this.bubble, this.nameText, this.signText, this.overflow, this.outline);
    this.body.addChild(this.sprite);
    this.twin.visible = false;
    this.bubble.visible = false;
    this.clock.visible = false;
  }

  box() {
    return { x: this.sprite.x + this.body.x, y: this.sprite.y + this.body.y, w: this.bw, h: this.bh };
  }

  private sig = '';
  private deferred: WorldEntity | null = null;

  get hasEntity() {
    return !!this.entity;
  }

  /** 화면 밖일 때: 최신 상태만 기억해 둔다 */
  defer(e: WorldEntity) {
    this.deferred = e;
  }

  setEntity(e: WorldEntity) {
    this.deferred = null;
    // 바뀐 것이 없으면 다시 그리지 않는다(대규모 세계에서 매 관측마다 1만 개를 다시 그리는 비용 절약)
    const sig = JSON.stringify([e.visual, e.anomalies, e.outOfRange, e.label, e.sprite, this.ctx.showLabels]);
    if (sig === this.sig) {
      this.entity = e;
      return;
    }
    this.sig = sig;
    const prevSprite = this.entity?.sprite;
    this.entity = e;
    const bank = this.ctx.bank;
    const size = bank.buildingSize(e.sprite);
    const scale = typeof e.visual.size === 'number' ? Math.max(0.6, Math.min(1.8, e.visual.size)) : 1;
    this.bw = Math.round(size.w * scale);
    this.bh = Math.round(size.h * scale);
    const cx = this.plot.x + this.plot.w / 2;
    const baseY = this.plot.door.y;
    if (prevSprite !== e.sprite || !this.texLit) {
      this.texLit = bank.building(e.sprite, true);
      this.texDark = bank.building(e.sprite, false);
      this.slices.forEach((s) => s.destroy());
      this.slices = [];
    }
    this.lit = e.visual.lit !== false;
    this.sprite.texture = this.lit ? this.texLit : this.texDark;
    this.sprite.tint = this.lit || !bank.hasGenerated(e.sprite) ? 0xffffff : 0x8090b0;
    this.sprite.width = this.bw;
    this.sprite.height = this.bh;
    this.sprite.x = Math.round(cx - this.bw / 2);
    this.sprite.y = Math.round(baseY - this.bh);
    this.twin.texture = this.sprite.texture;
    this.twin.width = this.bw;
    this.twin.height = this.bh;
    this.twin.position.set(this.sprite.x + 5, this.sprite.y - 3);

    this.shadow.clear().ellipse(cx, baseY, this.bw * 0.55, 4).fill({ color: 0x000000, alpha: 0.22 });

    // 색깔(tint) → 지붕 깃발
    const tint = e.visual.tint;
    this.flag.visible = typeof tint === 'string';
    if (typeof tint === 'string') {
      this.flag.texture = bank.flag(tint);
      this.flag.position.set(this.sprite.x + this.bw - 6, this.sprite.y - 8);
    }

    // 상자(stack): 양수는 나무 상자, 음수(또는 범위 밖 음수)는 붉은 유령 상자
    const stack = typeof e.visual.stack === 'number' ? e.visual.stack : null;
    const outRange = e.outOfRange.includes('stack');
    const real = stack !== null ? Math.max(0, Math.min(10, stack)) : 0;
    const ghost = stack !== null && (stack < 0 || (outRange && stack <= 0)) ? Math.min(10, Math.max(1, Math.abs(stack))) : 0;
    this.layoutCrates(this.crates, real, false, cx + this.bw / 2 + 2, baseY);
    this.layoutCrates(this.ghosts, ghost, true, cx + this.bw / 2 + 2, baseY - Math.ceil(real / 2) * 6);
    // 10상자를 넘는 값은 잘라내지 않고 +N 으로 알린다
    this.overflow.text = stack !== null && stack > 10 ? `+${stack - 10}` : '';
    this.overflow.visible = !!this.overflow.text;
    this.overflow.position.set(cx + this.bw / 2 + 2, baseY - Math.ceil((real + ghost) / 2) * 6 - 22);

    // 불길(fire)
    const fire = typeof e.visual.fire === 'number' ? Math.max(0, Math.min(6, e.visual.fire)) : 0;
    while (this.flames.children.length > fire) this.flames.removeChildAt(this.flames.children.length - 1).destroy();
    while (this.flames.children.length < fire) {
      const f = new Sprite(bank.flame(0));
      const i = this.flames.children.length;
      f.position.set(this.sprite.x + 3 + ((i * 7) % Math.max(8, this.bw - 10)), this.sprite.y + 2 - (i % 2) * 3);
      this.flames.addChild(f);
    }

    // 인파(crowd)
    const crowd = typeof e.visual.crowd === 'number' ? Math.max(0, Math.min(16, e.visual.crowd)) : 0;
    while (this.crowd.length > crowd) this.crowd.pop()!.s.destroy();
    while (this.crowd.length < crowd) {
      const home = { x: this.plot.x + 6 + this.rnd() * (this.plot.w - 12), y: this.plot.streetY - 6 + this.rnd() * 8 };
      const s = new Sprite(bank.tiny(this.crowd.length, 0));
      s.anchor.set(0.5, 1);
      s.position.set(home.x, home.y);
      this.crowdLayer.addChild(s);
      this.crowd.push({ s, home, target: { ...home }, frame: 0 });
    }

    // 안개(fog)
    this.fog.clear();
    if (e.visual.fog === true) {
      this.fog.rect(this.sprite.x - 4, this.sprite.y - 4, this.bw + 8, this.bh + 8).fill({ color: 0x8e96a6, alpha: 0.55 });
    }

    // 이름표 & 간판
    // 긴 이름은 옆 건물과 겹치지 않게 줄인다(전체 이름은 말풍선·인스펙터에서 보인다)
    this.nameText.text = shorten(e.label);
    this.nameText.anchor.set(0.5, 0);
    this.nameText.position.set(Math.round(cx), Math.round(baseY + 1));
    this.nameText.visible = this.ctx.showLabels;
    const sign = typeof e.visual.sign === 'string' ? e.visual.sign : '';
    this.signText.text = shorten(sign);
    this.signText.anchor.set(0.5, 1);
    this.signText.position.set(Math.round(cx), Math.round(this.sprite.y - (this.flag.visible ? 9 : 1)));
    this.signText.visible = this.ctx.showLabels && !!sign;

    // 이상 현상
    this.anomalyKinds = new Set(e.anomalies.map((a) => a.kind));
    const severe = e.anomalies.some((a) => a.severity !== 'info');
    this.bubble.visible = e.anomalies.length > 0;
    this.bubble.texture = bank.bubble(severe ? '!' : '?');
    this.bubble.position.set(this.sprite.x - 12, this.sprite.y + 4);
    this.clock.visible = this.anomalyKinds.has('timewarp');
    this.clock.texture = bank.bubble('⏱');
    this.clock.anchor.set(0.5);
    this.clock.position.set(this.sprite.x + this.bw / 2, this.sprite.y - 10);
    this.twin.visible = this.anomalyKinds.has('doppelganger');
    this.twin.tint = 0x66e0ff;
    this.twin.alpha = 0.45;
    if (this.anomalyKinds.has('glitch') && !this.slices.length) this.makeSlices();
    this.sprite.visible = !this.anomalyKinds.has('glitch');
    for (const s of this.slices) {
      s.visible = this.anomalyKinds.has('glitch');
      s.texture = this.lit ? this.slicesTex(true, this.slices.indexOf(s)) : this.slicesTex(false, this.slices.indexOf(s));
    }
    const hitPad = 6;
    const top = this.sprite.y - 10;
    this.hitArea = new Rectangle(this.plot.x + hitPad, top, this.plot.w - hitPad * 2, this.plot.streetY - 2 - top);
    this.cullArea = new Rectangle(this.plot.x, this.plot.y - 24, this.plot.w, this.plot.h + 24);
  }

  private sliceCache = new Map<string, Texture>();
  private slicesTex(lit: boolean, i: number): Texture {
    const key = `${lit}:${i}`;
    let t = this.sliceCache.get(key);
    if (!t) {
      const base = lit ? this.texLit : this.texDark;
      const h = Math.floor(base.frame.height / 4);
      t = new Texture({ source: base.source, frame: new Rectangle(base.frame.x, base.frame.y + i * h, base.frame.width, i === 3 ? base.frame.height - 3 * h : h) });
      this.sliceCache.set(key, t);
    }
    return t;
  }

  private makeSlices() {
    for (let i = 0; i < 4; i++) {
      const s = new Sprite(this.slicesTex(this.lit, i));
      this.body.addChild(s);
      this.slices.push(s);
    }
  }

  private layoutCrates(layer: Container, n: number, ghost: boolean, x0: number, y0: number) {
    while (layer.children.length > n) layer.removeChildAt(layer.children.length - 1).destroy();
    while (layer.children.length < n) layer.addChild(new Sprite(this.ctx.bank.crate(ghost)));
    layer.children.forEach((c, i) => {
      c.position.set(Math.round(x0 + (i % 2) * 7), Math.round(y0 - 7 - Math.floor(i / 2) * 6));
    });
  }

  /** 움직일 것이 없는 건물은 프레임마다 아무 일도 하지 않는다 */
  private get idle() {
    return !this.ghosts.children.length && !this.flames.children.length && !this.smoke.length && !this.crowd.length && !this.anomalyKinds.size && !this.selected && !this.hovered && !this.twin.visible && this.body.y === 0;
  }

  animate(t: number, dt: number) {
    if (this.deferred && !this.culled) this.setEntity(this.deferred);
    if (this.idle || (this.culled && !this.selected)) {
      this.drawOutline(t);
      return;
    }
    // 유령 상자 깜빡임
    this.ghosts.alpha = 0.55 + 0.45 * Math.abs(Math.sin(t * 5));
    this.ghosts.children.forEach((g, i) => (g.x += Math.sin(t * 9 + i) * 0.05));
    // 불꽃
    const frame = Math.floor(t * 8);
    this.flames.children.forEach((f, i) => ((f as Sprite).texture = this.ctx.bank.flame(frame + i)));
    if (this.flames.children.length && this.rnd() < dt * this.flames.children.length * 2) {
      const s = new Sprite(this.ctx.bank.smoke());
      s.position.set(this.sprite.x + this.rnd() * this.bw, this.sprite.y - 4);
      s.alpha = 0.8;
      this.addChild(s);
      this.smoke.push({ s, life: 1.6 });
    }
    for (const p of this.smoke) {
      p.life -= dt;
      p.s.y -= dt * 12;
      p.s.x += Math.sin(t * 2 + p.s.y) * 0.1;
      p.s.alpha = Math.max(0, p.life / 1.6) * 0.8;
    }
    this.smoke = this.smoke.filter((p) => (p.life > 0 ? true : (p.s.destroy(), false)));
    // 인파: 필지 안에서 어슬렁
    for (const c of this.crowd) {
      const dx = c.target.x - c.s.x;
      const dy = c.target.y - c.s.y;
      const d = Math.hypot(dx, dy);
      if (d < 1) {
        if (this.rnd() < dt * 0.8) c.target = { x: c.home.x + (this.rnd() - 0.5) * 24, y: c.home.y + (this.rnd() - 0.5) * 6 };
      } else {
        c.s.x += (dx / d) * dt * 10;
        c.s.y += (dy / d) * dt * 10;
        c.s.scale.x = dx < 0 ? -1 : 1;
        c.frame += dt * 6;
        c.s.texture = this.ctx.bank.tiny(this.crowd.indexOf(c), (Math.floor(c.frame) % 2) as 0 | 1);
      }
    }
    // 공중부양
    const lev = this.anomalyKinds.has('levitate');
    this.body.y = lev ? -5 - Math.sin(t * 2.5) * 2 : 0;
    this.shadow.alpha = lev ? 0.25 : 1;
    // 화면 깨짐
    if (this.slices.length && this.anomalyKinds.has('glitch')) {
      this.glitchTimer -= dt;
      const h = Math.floor(this.bh / 4);
      this.slices.forEach((s, i) => {
        s.width = this.bw;
        s.height = i === 3 ? this.bh - 3 * h : h;
        s.y = this.sprite.y + i * h;
        if (this.glitchTimer <= 0) s.x = this.sprite.x + (this.rnd() < 0.5 ? Math.round((this.rnd() - 0.5) * 6) : 0);
        s.tint = this.rnd() < 0.08 ? 0xff5577 : 0xffffff;
      });
      if (this.glitchTimer <= 0) this.glitchTimer = 0.08 + this.rnd() * 0.25;
    }
    // 도플갱어
    if (this.twin.visible) this.twin.x = this.sprite.x + 5 + Math.sin(t * 3) * 2;
    if (this.clock.visible) this.clock.rotation = -t * 2;
    this.bubble.y = this.sprite.y + this.body.y + 4 + Math.sin(t * 4) * 1.5;
    this.drawOutline(t);
  }

  setLabels(on: boolean) {
    this.sig = '';
    this.nameText.visible = on;
    this.signText.visible = on && !!this.signText.text;
  }
}

/* ───────────────────────────── 움직이는 주민(NPC) ───────────────────────────── */

export class NpcView extends EntityView {
  private sprite = new Sprite();
  private shadow = new Graphics();
  private bubble = new Sprite();
  private path: Point[] = [];
  private length = 1;
  private dist = 0;
  private dirSign = 1;
  private frame = 0;
  private returning = false;
  private wander: Point | null = null;
  private wanderTarget: Point | null = null;
  private born = 0;
  private texKey = '';

  constructor(id: string, ctx: ViewContext) {
    super(id, ctx);
    this.sprite.anchor.set(0.5, 1);
    this.bubble.anchor.set(0.5, 1);
    this.bubble.visible = false;
    this.addChild(this.shadow, this.sprite, this.bubble, this.outline);
    this.shadow.ellipse(0, 0, 5, 2).fill({ color: 0x000000, alpha: 0.25 });
    this.hitArea = new Rectangle(-8, -18, 16, 20);
    this.cullArea = new Rectangle(-12, -32, 24, 36);
  }

  box() {
    return { x: -6, y: -16, w: 12, h: 16 };
  }

  setRoute(path: Point[], fresh: boolean) {
    const same = this.path.length === path.length && this.path.every((p, i) => p.x === path[i].x && p.y === path[i].y);
    if (same) return;
    this.path = path;
    this.length = Math.max(1, pathLength(path));
    if (fresh) {
      this.dist = 0;
      this.born = performance.now();
    } else {
      this.dist = Math.min(this.dist, this.length);
    }
  }

  setEntity(e: WorldEntity) {
    this.entity = e;
    this.anomalyKinds = new Set(e.anomalies.map((a) => a.kind));
    const tint = (e.visual.tint as ColorName | undefined) ?? null;
    const orphan = this.anomalyKinds.has('orphan') || e.links.some((l) => l.missing);
    this.alpha = orphan ? 0.75 : 1;
    const cancelled = tint === 'gray';
    // 말풍선은 법칙 위반에만 쓴다(상태는 옷 색깔이 이미 말해준다)
    const violated = this.anomalyKinds.size > 0;
    this.bubble.visible = orphan || violated;
    this.bubble.texture = this.ctx.bank.bubble(orphan ? '?' : '!');
    this.returning = tint !== null && GOOD.includes(tint);
    if (cancelled) this.alpha = 0.6;
    this.sprite.tint = this.anomalyKinds.size && !orphan ? 0xffb0b0 : 0xffffff;
  }

  animate(t: number, dt: number, speed: number) {
    const e = this.entity;
    const tint = (e.visual.tint as ColorName | undefined) ?? null;
    if (this.culled && !this.selected) {
      // 화면 밖: 위치만 진행시키고 그리기 작업은 생략
      const goal = this.returning ? 0 : this.length;
      const v0 = 28 * speed * (typeof e.visual.speed === 'number' ? e.visual.speed : 1);
      if (Math.abs(this.dist - goal) > 0.5) this.dist += Math.sign(goal - this.dist) * Math.min(Math.abs(goal - this.dist), v0 * dt);
      const at = pointAt(this.path, this.dist);
      this.position.set(Math.round(at.p.x), Math.round(at.p.y));
      return;
    }
    const orphan = this.anomalyKinds.has('orphan') || e.links.some((l) => l.missing);
    const v = 28 * speed * (typeof e.visual.speed === 'number' ? e.visual.speed : 1);
    let moving = false;
    let pos: Point;
    if (orphan && this.path.length) {
      // 목적지를 잃은 주민은 출발지 근처를 서성인다
      this.wander ??= { ...this.path[Math.min(1, this.path.length - 1)] };
      if (!this.wanderTarget || Math.hypot(this.wanderTarget.x - this.wander.x, this.wanderTarget.y - this.wander.y) < 1) {
        this.wanderTarget = { x: this.path[1]?.x + (this.rnd() - 0.5) * 40, y: (this.path[1]?.y ?? 0) + (this.rnd() - 0.5) * 6 };
      }
      const dx = this.wanderTarget.x - this.wander.x;
      const dy = this.wanderTarget.y - this.wander.y;
      const d = Math.max(0.001, Math.hypot(dx, dy));
      this.wander.x += (dx / d) * dt * 12;
      this.wander.y += (dy / d) * dt * 12;
      this.dirSign = dx < 0 ? -1 : 1;
      pos = this.wander;
      moving = true;
    } else {
      const goal = this.returning ? 0 : this.length;
      if (Math.abs(this.dist - goal) > 0.5) {
        this.dist += Math.sign(goal - this.dist) * Math.min(Math.abs(goal - this.dist), v * dt);
        moving = true;
      }
      const at = pointAt(this.path, this.dist);
      if (at.dir) this.dirSign = this.returning ? -at.dir : at.dir;
      pos = at.p;
    }
    this.position.set(Math.round(pos.x), Math.round(pos.y));
    this.zIndex = pos.y;
    if (moving) this.frame += dt * 7;
    const carrying = this.returning && tint !== null && GOOD.includes(tint);
    const key = `${tint}:${Math.floor(this.frame) % 2}:${carrying}`;
    if (key !== this.texKey) {
      this.texKey = key;
      this.sprite.texture = this.ctx.bank.walker(e.sprite, tint, (Math.floor(this.frame) % 2) as 0 | 1, carrying);
    }
    this.sprite.scale.x = this.dirSign < 0 ? -1 : 1;
    this.sprite.y = moving ? -Math.abs(Math.sin(this.frame * Math.PI)) : 0;
    const age = (performance.now() - this.born) / 1000;
    if (age < 0.4) this.alpha = Math.min(this.alpha, age / 0.4);
    this.bubble.y = -18 + Math.sin(t * 5) * 1;
    this.drawOutline(t);
  }
}

export function colorHex(c: string | null | undefined): number {
  return c && c in PALETTE ? hexNum(PALETTE[c as ColorName].hex) : 0x8a8f98;
}

export const TILE = T;
