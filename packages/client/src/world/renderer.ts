import { Application, ColorMatrixFilter, Container, CullerPlugin, extensions, Graphics, Sprite, Texture, TilingSprite, TextureStyle } from 'pixi.js';
import type { WorldEntity, WorldGrammar, WorldState } from '@isomorph/core';
import { canvas, drawTile, type Ground } from '../pixel/sprites.ts';
import { TextureBank } from '../pixel/textures.ts';
import { computeLayout, pathBetween, plotFor, T, type KindCount, type Plot, type TownLayout } from './layout.ts';
import { BuildingView, NpcView, pixelText, type ViewContext } from './views.ts';

extensions.add(CullerPlugin);
TextureStyle.defaultOptions.scaleMode = 'nearest';

const ZOOMS = [0.2, 0.3, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

export interface TownCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null, x: number, y: number): void;
}

/** 픽셀 마을 렌더러: 세계 상태(WorldState)만 보고 그린다. */
export class Town {
  app = new Application();
  readonly bank = new TextureBank();
  private camera = new Container();
  private groundLayer = new Container();
  private labelsLayer = new Container();
  private buildings = new Container();
  private npcs = new Container();
  private overlay = new Container();
  private views = new Map<string, BuildingView | NpcView>();
  private layout: TownLayout | null = null;
  private grammar: WorldGrammar | null = null;
  private world: WorldState | null = null;
  private zoomIndex = 7;
  private time = 0;
  private selected: string | null = null;
  private preview: BuildingView | null = null;
  private previewTag = pixelText('미래 장면 (드라이런)', '#ffffff', 10, '#1d4ed8');
  private sepia = new ColorMatrixFilter();
  private ctx: ViewContext = { bank: this.bank, showLabels: true };
  private dragging: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private speed = 1;

  constructor(private cb: TownCallbacks) {}

  async init(el: HTMLElement) {
    await this.app.init({ resizeTo: el, background: '#7fb069', antialias: false, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), roundPixels: true, preserveDrawingBuffer: true });
    el.appendChild(this.app.canvas);
    this.buildings.sortableChildren = true;
    this.npcs.sortableChildren = true;
    this.camera.addChild(this.groundLayer, this.labelsLayer, this.buildings, this.npcs, this.overlay);
    this.app.stage.addChild(this.camera);
    this.sepia.sepia(false);
    this.previewTag.anchor.set(0.5, 1);
    this.previewTag.visible = false;
    this.overlay.addChild(this.previewTag);

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => {
      this.dragging = { x: e.global.x, y: e.global.y, cx: this.camera.x, cy: this.camera.y, moved: false };
    });
    stage.on('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.global.x - this.dragging.x;
      const dy = e.global.y - this.dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.dragging.moved = true;
      if (this.dragging.moved) this.camera.position.set(Math.round(this.dragging.cx + dx), Math.round(this.dragging.cy + dy));
    });
    const end = (e: { target: unknown }) => {
      if (this.dragging && !this.dragging.moved && e.target === stage) this.cb.onSelect(null);
      this.dragging = null;
    };
    stage.on('pointerup', end);
    stage.on('pointerupoutside', () => (this.dragging = null));
    this.app.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = this.app.canvas.getBoundingClientRect();
      this.zoomAt(ev.deltaY < 0 ? 1 : -1, ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });

    this.app.ticker.add((tk) => {
      const dt = Math.min(0.1, tk.deltaMS / 1000);
      this.time += dt;
      for (const v of this.views.values()) v.animate(this.time, dt, this.speed);
      this.preview?.animate(this.time, dt);
      if (this.preview) this.preview.alpha = 0.55 + 0.3 * Math.sin(this.time * 5);
    });
  }

  get fps() {
    return this.app.ticker.FPS;
  }

  get entityCount() {
    return this.views.size;
  }

  setGrammar(g: WorldGrammar) {
    this.grammar = g;
  }

  private zoomAt(dir: number, sx: number, sy: number) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIndex + dir));
    if (next === this.zoomIndex) return;
    const before = ZOOMS[this.zoomIndex];
    const after = ZOOMS[next];
    const wx = (sx - this.camera.x) / before;
    const wy = (sy - this.camera.y) / before;
    this.zoomIndex = next;
    this.camera.scale.set(after);
    this.camera.position.set(Math.round(sx - wx * after), Math.round(sy - wy * after));
    this.updateLabels();
  }

  zoom(dir: number) {
    this.zoomAt(dir, this.app.screen.width / 2, this.app.screen.height / 2);
  }

  fit() {
    if (!this.layout) return;
    const { width, height } = this.app.screen;
    let idx = 0;
    for (let i = 0; i < ZOOMS.length; i++) if (this.layout.width * ZOOMS[i] <= width - 20 && this.layout.height * ZOOMS[i] <= height - 20) idx = i;
    this.zoomIndex = idx;
    const z = ZOOMS[idx];
    this.camera.scale.set(z);
    this.camera.position.set(Math.round((width - this.layout.width * z) / 2), Math.round((height - this.layout.height * z) / 2));
    this.updateLabels();
  }

  focus(id: string) {
    const v = this.views.get(id);
    if (!v) return;
    if (ZOOMS[this.zoomIndex] < 2.5) {
      this.zoomIndex = ZOOMS.indexOf(2.5);
      this.camera.scale.set(2.5);
    }
    const z = ZOOMS[this.zoomIndex];
    const b = v.box();
    const wx = v instanceof NpcView ? v.x : b.x + b.w / 2;
    const wy = v instanceof NpcView ? v.y : b.y + b.h / 2;
    this.camera.position.set(Math.round(this.app.screen.width * 0.42 - wx * z), Math.round(this.app.screen.height / 2 - wy * z));
    this.updateLabels();
  }

  private updateLabels() {
    const on = ZOOMS[this.zoomIndex] >= 1.25 && this.views.size < 1500;
    if (on === this.ctx.showLabels) return;
    this.ctx.showLabels = on;
    for (const v of this.views.values()) if (v instanceof BuildingView) v.setLabels(on);
    this.labelsLayer.visible = ZOOMS[this.zoomIndex] >= 0.75;
  }

  select(id: string | null) {
    if (this.selected) {
      const prev = this.views.get(this.selected);
      if (prev) prev.selected = false;
    }
    this.selected = id;
    if (id) {
      const v = this.views.get(id);
      if (v) v.selected = true;
    }
  }

  setHistory(on: boolean) {
    if (on) {
      this.sepia.sepia(false);
      this.camera.filters = [this.sepia];
    } else {
      this.camera.filters = [];
    }
  }

  /** 드라이런 미래 장면: 현재 건물 위에 반투명하게 겹쳐 보여준다 */
  showPreview(preview: WorldEntity | null) {
    if (this.preview) {
      this.preview.destroy({ children: true });
      this.preview = null;
    }
    this.previewTag.visible = false;
    if (!preview) return;
    const v = this.views.get(preview.id);
    if (!(v instanceof BuildingView)) return;
    const pv = new BuildingView(`${preview.id}#preview`, this.ctx, v.plot);
    pv.eventMode = 'none';
    pv.setEntity(preview);
    pv.selected = true;
    this.overlay.addChildAt(pv, 0);
    this.preview = pv;
    const b = pv.box();
    this.previewTag.position.set(b.x + b.w / 2, b.y - 14);
    this.previewTag.visible = true;
  }

  private plotOf(e: WorldEntity): Plot | null {
    return this.layout ? plotFor(this.layout, e.kind, e.slot) : null;
  }

  setWorld(world: WorldState) {
    this.world = world;
    const g = this.grammar;
    if (!g) return;
    const buildingsOnly = world.entities.filter((e) => e.archetype !== 'npc');
    const counts = new Map<string, KindCount>();
    for (const k of g.kinds) if (k.archetype !== 'npc') counts.set(k.id, { kind: k.id, region: k.region, count: 0, landmark: k.archetype === 'landmark' });
    for (const e of buildingsOnly) {
      const c = counts.get(e.kind);
      if (c) c.count = Math.max(c.count, e.slot + 1);
    }
    const prevKey = this.layout?.key;
    // 수용량 안이면 배치 유지(건물이 흔들리지 않게)
    const fits = !!this.layout && [...counts.values()].every((c) => c.count <= (this.layout!.kindCapacity.get(c.kind) ?? -1));
    if (!fits) {
      this.layout = computeLayout(g.regions, [...counts.values()]);
      if (this.layout.key !== prevKey) {
        this.renderGround();
        for (const v of this.views.values()) if (v instanceof BuildingView) {
          this.views.delete(v.id);
          v.destroy({ children: true });
        }
        if (!prevKey) queueMicrotask(() => this.fit());
      }
    }

    const seen = new Set<string>();
    const byId = new Map(world.entities.map((e) => [e.id, e] as const));
    let speed = 1;
    for (const e of world.entities) {
      seen.add(e.id);
      if (e.archetype !== 'npc') {
        if (e.archetype === 'landmark' && typeof e.visual.speed === 'number') speed = e.visual.speed;
        const plot = this.plotOf(e);
        if (!plot) continue;
        let v = this.views.get(e.id);
        if (v instanceof BuildingView && (v.plot.x !== plot.x || v.plot.y !== plot.y)) {
          v.destroy({ children: true });
          this.views.delete(e.id);
          v = undefined;
        }
        if (!v) {
          v = new BuildingView(e.id, this.ctx, plot);
          v.cullable = true;
          this.attach(v);
          this.buildings.addChild(v);
          this.views.set(e.id, v);
        }
        v.zIndex = plot.y;
        v.setEntity(e);
      }
    }
    this.speed = speed;
    for (const e of world.entities) {
      if (e.archetype !== 'npc') continue;
      let v = this.views.get(e.id) as NpcView | undefined;
      const fresh = !v;
      if (!v) {
        v = new NpcView(e.id, this.ctx);
        v.cullable = true;
        this.attach(v);
        this.npcs.addChild(v);
        this.views.set(e.id, v);
      }
      const fromL = e.links.find((l) => l.role === 'from');
      const toL = e.links.find((l) => l.role === 'to');
      const fromE = fromL?.target ? byId.get(fromL.target) : undefined;
      const toE = toL?.target ? byId.get(toL.target) : undefined;
      if (this.layout) v.setRoute(pathBetween(this.layout, fromE ? this.plotOf(fromE) : null, toE ? this.plotOf(toE) : null), fresh);
      v.setEntity(e);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.destroy({ children: true });
        this.views.delete(id);
      }
    }
    if (this.selected) this.select(this.selected);
    this.updateLabels();
  }

  private attach(v: BuildingView | NpcView) {
    v.on('pointertap', (ev) => {
      ev.stopPropagation();
      this.cb.onSelect(v.id);
    });
    v.on('pointerover', (ev) => {
      v.hovered = true;
      this.cb.onHover(v.id, ev.global.x, ev.global.y);
    });
    v.on('pointermove', (ev) => this.cb.onHover(v.id, ev.global.x, ev.global.y));
    v.on('pointerout', () => {
      v.hovered = false;
      this.cb.onHover(null, 0, 0);
    });
  }

  /** 바닥(풀밭·구역 바닥·길)과 장식(나무·분수·지역 이름)을 한 번에 그린다 */
  private renderGround() {
    const L = this.layout!;
    for (const c of [...this.groundLayer.children]) c.destroy({ children: true });
    for (const c of [...this.labelsLayer.children]) c.destroy({ children: true });
    const big = L.width * L.height > 12_000_000;
    if (big) {
      const [gc, gctx] = canvas(64, 64);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) drawTile(gctx, 'grass', x * 16, y * 16, x, y);
      const grass = new TilingSprite({ texture: Texture.from(gc), width: L.width, height: L.height });
      const gr = new Graphics();
      for (const d of L.districts) gr.rect(d.x + T, d.y, d.w - 2 * T, d.h).fill({ color: 0xd8c7a0 });
      gr.rect(0, L.mainRoadY - T, L.width, 2 * T).fill({ color: 0x7d7468 });
      this.groundLayer.addChild(grass, gr);
    } else {
      const [c, ctx] = canvas(L.width, L.height);
      const tilesX = Math.ceil(L.width / T);
      const tilesY = Math.ceil(L.height / T);
      for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) drawTile(ctx, 'grass', tx * T, ty * T, tx, ty);
      for (const d of L.districts) {
        const floor = (d.region.theme in { market: 1, residential: 1, finance: 1, industrial: 1, civic: 1, plaza: 1, farmland: 1 } ? d.region.theme : 'market') as Ground;
        for (let ty = d.y / T; ty < (d.y + d.h) / T; ty++) {
          for (let tx = (d.x + T) / T; tx < (d.x + d.w - T) / T; tx++) {
            const localRow = (ty - d.y / T) % d.plotH;
            drawTile(ctx, localRow === d.plotH - 1 ? 'road' : floor, tx * T, ty * T, tx, ty);
          }
        }
        for (let ty = d.y / T; ty < L.mainRoadY / T; ty++) drawTile(ctx, 'road', d.x, ty * T, d.x / T, ty);
        // 보도 테두리
        for (let tx = d.x / T; tx < (d.x + d.w) / T; tx++) drawTile(ctx, 'sidewalk', tx * T, d.y - T, tx, d.y / T - 1);
      }
      for (let tx = 0; tx < tilesX; tx++) {
        drawTile(ctx, 'road', tx * T, L.mainRoadY - T / 2, tx, 999);
        drawTile(ctx, 'sidewalk', tx * T, L.mainRoadY + T / 2, tx, 998);
      }
      // 큰길 중앙선
      ctx.fillStyle = '#e8d38a';
      for (let x = 4; x < L.width; x += 14) ctx.fillRect(x, L.mainRoadY, 6, 1);
      const tex = Texture.from(c);
      tex.source.scaleMode = 'nearest';
      this.groundLayer.addChild(new Sprite(tex));
      // 장식 나무(데이터와 무관)
      const deco = new Container();
      for (let x = 8; x < L.width - 16; x += 22) {
        const t1 = new Sprite(this.bank.tree(x));
        t1.position.set(x, L.mainRoadY + T * 1.6);
        deco.addChild(t1);
      }
      for (const d of L.districts) {
        if (d.landmark) {
          const f = new Sprite(this.bank.fountain());
          f.position.set(d.x + d.w - T * 3.2, d.y + d.h - T * 3);
          deco.addChild(f);
        }
      }
      this.groundLayer.addChild(deco);
    }
    for (const d of L.districts) {
      const sign = pixelText(d.region.title, '#ffffff', 10, '#5a361d');
      sign.anchor.set(0, 1);
      sign.position.set(d.x + T + 2, d.y - 3);
      this.labelsLayer.addChild(sign);
    }
  }

  screenOf(id: string): { x: number; y: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    const b = v.box();
    const p = v instanceof NpcView ? v.getGlobalPosition() : this.camera.toGlobal({ x: b.x + b.w / 2, y: b.y });
    return { x: p.x, y: p.y };
  }

  thumbnail(): string {
    return this.app.canvas.toDataURL();
  }
}
