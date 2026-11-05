import { Application, ColorMatrixFilter, Container, CullerPlugin, extensions, Graphics, Rectangle, Sprite, Texture, TilingSprite, TextureStyle } from 'pixi.js';
import { assignGlyphs, CVD_MATRIX, isCategorical, PALETTE, type ColorName, type GlyphName, type Vision, type WorldEntity, type WorldGrammar, type WorldState } from '@isomorph/core';
import { canvas, drawTile, type Ground } from '../pixel/sprites.ts';
import { TextureBank } from '../pixel/textures.ts';
import { computeLayout, pathBetween, plotFor, T, type KindCount, type Plot, type TownLayout } from './layout.ts';
import { BuildingView, NpcView, pixelText, type ViewContext } from './views.ts';

extensions.add(CullerPlugin);
TextureStyle.defaultOptions.scaleMode = 'nearest';

const ZOOMS = [0.05, 0.08, 0.12, 0.2, 0.3, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

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
  /** 고른 개체와 연결된 곳을 잇는 점선 */
  private linkLayer = new Graphics();
  private links: { from: string; to: { id: string; bad: boolean; cross: boolean }[] } | null = null;
  private views = new Map<string, BuildingView | NpcView>();
  private layout: TownLayout | null = null;
  private grammar: WorldGrammar | null = null;
  private world: WorldState | null = null;
  private zoomIndex = 10;
  private time = 0;
  private selected: string | null = null;
  private preview: BuildingView | null = null;
  private previewTag = pixelText('미래 장면 (드라이런)', '#ffffff', 10, '#1d4ed8');
  private sepia = new ColorMatrixFilter();
  private ctx: ViewContext = { bank: this.bank, showLabels: true };
  private dragging: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private speed = 1;
  /** 시맨틱 줌: 멀리서 보면 구역 요약으로 바뀐다 */
  private lod = false;
  private summaryLayer = new Container();
  private pendingWorld: WorldState | null = null;
  static readonly LOD_ZOOM = 0.5;

  constructor(private cb: TownCallbacks) {}

  async init(el: HTMLElement) {
    await this.app.init({ resizeTo: el, background: '#7fb069', antialias: false, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), roundPixels: true, preserveDrawingBuffer: true });
    el.appendChild(this.app.canvas);
    this.buildings.sortableChildren = true;
    this.npcs.sortableChildren = true;
    this.camera.addChild(this.groundLayer, this.labelsLayer, this.buildings, this.npcs, this.linkLayer, this.summaryLayer, this.overlay);
    this.summaryLayer.visible = false;
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
      if (!this.lod) for (const v of this.views.values()) v.animate(this.time, dt, this.speed);
      this.preview?.animate(this.time, dt);
      if (this.preview) this.preview.alpha = 0.55 + 0.3 * Math.sin(this.time * 5);
      this.drawLinks();
    });
  }

  /** 연결된 곳 표시(살펴보기에서 받은 목록). from 이 null 이면 지운다 */
  setLinks(from: string | null, to: { id: string; bad: boolean; cross: boolean }[]) {
    const fresh = !!from && from !== this.framedFor;
    this.links = from && to.length ? { from, to: to.slice(0, 12) } : null;
    this.framedFor = from;
    if (!this.links) this.linkLayer.clear();
    else if (fresh) this.frameLinks();
  }

  private framedFor: string | null = null;

  /** 새로 고른 개체와 '탈이 난' 연결 상대가 화면(살펴보기 창 왼쪽)에 함께 보이게 시야를 넓힌다 */
  private frameLinks() {
    if (!this.links) return;
    const sick = this.links.to.filter((t) => t.bad || t.cross).map((t) => this.centerOf(t.id));
    const pts = [this.centerOf(this.links.from), ...sick].filter((p): p is { x: number; y: number } => !!p);
    if (pts.length < 2) return;
    const { width, height } = this.app.screen;
    const narrow = width < 700;
    const area = { x0: 24, y0: 70, x1: narrow ? width - 24 : width - 410, y1: height - 70 };
    let z = ZOOMS[this.zoomIndex];
    const inView = (p: { x: number; y: number }) => {
      const sx = this.camera.x + p.x * z;
      const sy = this.camera.y + p.y * z;
      return sx >= area.x0 && sx <= area.x1 && sy >= area.y0 && sy <= area.y1;
    };
    if (pts.every(inView)) return;
    const minX = Math.min(...pts.map((p) => p.x)) - 40;
    const maxX = Math.max(...pts.map((p) => p.x)) + 40;
    const minY = Math.min(...pts.map((p) => p.y)) - 50;
    const maxY = Math.max(...pts.map((p) => p.y)) + 30;
    let idx = this.zoomIndex;
    while (idx > 0 && ((maxX - minX) * ZOOMS[idx] > area.x1 - area.x0 || (maxY - minY) * ZOOMS[idx] > area.y1 - area.y0)) idx--;
    this.zoomIndex = idx;
    z = ZOOMS[idx];
    this.camera.scale.set(z);
    this.camera.position.set(Math.round((area.x0 + area.x1) / 2 - ((minX + maxX) / 2) * z), Math.round((area.y0 + area.y1) / 2 - ((minY + maxY) / 2) * z));
    this.updateLabels();
  }

  private centerOf(id: string): { x: number; y: number } | null {
    const v = this.views.get(id);
    if (!v) return null;
    if (v instanceof NpcView) return { x: v.x, y: v.y };
    const b = v.box();
    return { x: b.x + b.w / 2, y: b.y + b.h * 0.6 };
  }

  private drawLinks() {
    const g = this.linkLayer;
    g.clear();
    if (!this.links || this.lod) return;
    const a = this.centerOf(this.links.from);
    if (!a) return;
    const phase = (this.time * 12) % 8;
    for (const t of this.links.to) {
      const b = this.centerOf(t.id);
      if (!b) continue;
      const color = t.bad ? 0xe61919 : t.cross ? 0x4aa3ff : 0xfff6d5;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      // 픽셀 점선이 고른 개체 쪽에서 상대 쪽으로 흘러간다
      for (let s = phase; s < len; s += 8) {
        const e = Math.min(len, s + 4);
        g.moveTo(a.x + (dx * s) / len, a.y + (dy * s) / len).lineTo(a.x + (dx * e) / len, a.y + (dy * e) / len);
      }
      g.stroke({ width: 2, color, alpha: 0.9 });
      g.circle(b.x, b.y, 5).stroke({ width: 2, color, alpha: 0.9 });
    }
  }

  get fps() {
    return this.app.ticker.FPS;
  }

  get entityCount() {
    return this.views.size;
  }

  /** 색각 이상 미리보기(근사): 세계 전체에 Machado(2009) 행렬을 씌운다 */
  private visionFilter = new ColorMatrixFilter();
  vision: Vision = 'normal';
  setVision(v: Vision) {
    this.vision = v;
    if (v === 'normal') {
      this.app.stage.filters = [];
      return;
    }
    const m = CVD_MATRIX[v];
    this.visionFilter.matrix = [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0];
    this.app.stage.filters = [this.visionFilter];
  }

  setGrammar(g: WorldGrammar) {
    this.grammar = g;
    // 색깔 채널의 색 → 모양(글리프). 문법에 모양이 없으면(이전 판·직접 쓴 문법) 값 순서로 정한다
    const glyphs = new Map<string, Map<string, GlyphName>>();
    for (const k of g.kinds) {
      const b = k.channels.find((c) => c.channel === 'tint');
      if (!b || !isCategorical(b)) continue;
      const byValue = b.glyphs ?? assignGlyphs(Object.keys(b.map));
      glyphs.set(k.id, new Map(Object.entries(b.map).map(([v, color]) => [color, byValue[v]] as [string, GlyphName])));
    }
    this.ctx.glyphOf = (e) => (typeof e.visual.tint === 'string' ? glyphs.get(e.kind)?.get(e.visual.tint) ?? null : null);
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

  /** 확대 수준에 따라 개체 표시 ↔ 구역 요약 전환 */
  private updateLod() {
    const want = ZOOMS[this.zoomIndex] <= Town.LOD_ZOOM && this.views.size > 0;
    if (want !== this.lod) {
      this.lod = want;
      // 숨긴 층은 렌더링·컬링 순회에서도 빠지게 renderable 까지 끈다
      this.buildings.visible = this.buildings.renderable = !want;
      this.npcs.visible = this.npcs.renderable = !want;
      this.summaryLayer.visible = want;
      if (!want && this.pendingWorld) {
        const w = this.pendingWorld;
        this.pendingWorld = null;
        this.setWorld(w);
      }
    }
    if (this.lod) this.renderSummaries();
  }

  private updateLabels() {
    this.updateLod();
    const on = ZOOMS[this.zoomIndex] >= 1.25 && this.views.size < 1500;
    if (on === this.ctx.showLabels) return;
    this.ctx.showLabels = on;
    for (const v of this.views.values()) if (v instanceof BuildingView) v.setLabels(on);
    this.labelsLayer.visible = ZOOMS[this.zoomIndex] >= 0.75;
  }

  select(id: string | null) {
    if (id !== this.links?.from) {
      this.setLinks(null, []);
      this.framedFor = null;
    }
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

    if (this.lod) {
      // 멀리서 볼 때는 개별 개체를 갱신하지 않고 요약만 다시 계산한다(가까이 가면 최신 상태로 한 번에 반영)
      this.pendingWorld = world;
      this.renderSummaries();
      return;
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
        // 화면 밖 건물은 상태만 맡겨 두고, 화면에 들어올 때 그린다(대규모 세계의 갱신 비용 절감)
        if (v instanceof BuildingView && v.culled && this.selected !== e.id && v.hasEntity) v.defer(e);
        else v.setEntity(e);
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

  /** 구역 요약: 종류별 개수, 상태 색 분포, 불 꺼짐·불길·법칙 위반 수 */
  private renderSummaries() {
    const L = this.layout;
    const g = this.grammar;
    const w = this.pendingWorld ?? this.world;
    for (const c of [...this.summaryLayer.children]) c.destroy({ children: true });
    if (!L || !g || !w) return;
    const z = ZOOMS[this.zoomIndex];
    const ui = 1 / z; // 화면에서 일정한 글자 크기
    let walkers = 0;
    const byDistrict = new Map<number, WorldEntity[]>();
    for (const e of w.entities) {
      if (e.archetype === 'npc') {
        walkers++;
        continue;
      }
      const di = L.kindRegion.get(e.kind);
      if (di === undefined) continue;
      const list = byDistrict.get(di) ?? [];
      list.push(e);
      byDistrict.set(di, list);
    }
    L.districts.forEach((d, di) => {
      const ents = byDistrict.get(di) ?? [];
      const box = new Container();
      const bg = new Graphics().rect(d.x + T, d.y, d.w - 2 * T, d.h).fill({ color: 0x1c1722, alpha: 0.72 });
      const anomalies = ents.filter((e) => e.anomalies.length).length;
      if (anomalies) bg.rect(d.x + T, d.y, d.w - 2 * T, d.h).stroke({ color: 0xff3b3b, width: 3 * ui, alpha: 0.9 });
      box.addChild(bg);
      // 상태 색 분포 막대
      const tints = new Map<string, number>();
      for (const e of ents) if (typeof e.visual.tint === 'string') tints.set(e.visual.tint, (tints.get(e.visual.tint) ?? 0) + 1);
      const total = [...tints.values()].reduce((a, b) => a + b, 0);
      const barW = d.w - 4 * T;
      const barH = 8 * ui;
      const barY = d.y + d.h - barH - 6 * ui;
      let x = d.x + 2 * T;
      if (total) {
        for (const [c, n] of [...tints].sort((a, b) => b[1] - a[1])) {
          const wpx = (n / total) * barW;
          bg.rect(x, barY, wpx, barH).fill({ color: parseInt((PALETTE[c as ColorName]?.hex ?? '#8a8f98').slice(1), 16) });
          x += wpx;
        }
      }
      const kinds = new Map<string, number>();
      for (const e of ents) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
      const dark = ents.filter((e) => e.visual.lit === false).length;
      const fire = ents.filter((e) => typeof e.visual.fire === 'number' && e.visual.fire > 0).length;
      const lines = [
        d.region.title,
        ...[...kinds].map(([k, n]) => `${g.kinds.find((x) => x.id === k)?.title ?? k} ${n.toLocaleString('ko-KR')}`),
        ...(dark ? [`불 꺼짐 ${dark.toLocaleString('ko-KR')}`] : []),
        ...(fire ? [`불길 ${fire.toLocaleString('ko-KR')}`] : []),
      ];
      let ty = d.y + 6 * ui;
      lines.forEach((line, i) => {
        const scale = ui * (i === 0 ? 1.6 : 1.3);
        const t = pixelText(line, i === 0 ? '#f2c94c' : '#f3ede2', i === 0 ? 11 : 10);
        t.scale.set(scale);
        t.position.set(d.x + 2 * T, ty);
        ty += (i === 0 ? 17 : 15) * scale;
        box.addChild(t);
      });
      if (anomalies) {
        const t = pixelText(`⚠ 법칙 위반 ${anomalies.toLocaleString('ko-KR')}`, '#ff6b57', 10);
        t.scale.set(ui * 1.4);
        t.position.set(d.x + 2 * T, barY - 22 * ui);
        box.addChild(t);
      }
      box.eventMode = 'static';
      box.cursor = 'zoom-in';
      box.hitArea = new Rectangle(d.x, d.y, d.w, d.h);
      box.on('pointertap', (ev) => {
        ev.stopPropagation();
        this.zoomToDistrict(di);
      });
      this.summaryLayer.addChild(box);
    });
    if (walkers) {
      const t = pixelText(`길 위의 주민 ${walkers.toLocaleString('ko-KR')}`, '#f3ede2', 10, '#1c1722');
      t.scale.set(ui * 1.3);
      t.position.set(2 * T, L.mainRoadY + T);
      this.summaryLayer.addChild(t);
    }
  }

  private zoomToDistrict(di: number) {
    const d = this.layout?.districts[di];
    if (!d) return;
    this.zoomIndex = ZOOMS.indexOf(1.25);
    const z = ZOOMS[this.zoomIndex];
    this.camera.scale.set(z);
    this.camera.position.set(Math.round(this.app.screen.width / 2 - (d.x + Math.min(d.w, this.app.screen.width / z) / 2) * z), Math.round(this.app.screen.height / 2 - (d.y + Math.min(d.h, this.app.screen.height / z) / 2) * z));
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
