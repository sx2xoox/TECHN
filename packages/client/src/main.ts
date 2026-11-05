import './style.css';
import { VISION_KO, type DryRunMessage, type HelloMessage, type InspectMessage, type ServerMessage, type SimulationResult, type Vision, type WorldState } from '@isomorph/core';
import { loadFonts } from './fonts.ts';
import { embeddedBundle, LocalServer } from './local.ts';
import { Connection, wsUrl } from './net.ts';
import { stressHello, stressWorld } from './stress.ts';
import { h } from './ui/dom.ts';
import { LabPanel, SimPlayer } from './ui/lab.ts';
import { dryRunModal, ModalRoot, Screen, verificationModal } from './ui/modals.ts';
import { ActionLog, countViolations, Inspector, LegendPanel, Toasts, Tooltip, Topbar } from './ui/panels.ts';
import { Timeline } from './ui/timeline.ts';
import { Town } from './world/renderer.ts';

/** 클라이언트 상태 */
const state = {
  hello: null as HelloMessage | null,
  world: null as WorldState | null,
  mode: 'live' as 'live' | 'history',
  seekTs: null as number | null,
  selected: null as string | null,
  dryrun: null as DryRunMessage | null,
  violationCursor: 0,
};

const params = new URLSearchParams(location.search);
const stressN = Number(params.get('stress') ?? 0);
/** 알림 링크(?focus=개체&at=시각): 그 시점으로 되감고 그 개체를 연다 */
let deepLink: { id: string; at: number | null; seeking: boolean } | null = params.get('focus')
  ? { id: params.get('focus')!, at: Number(params.get('at')) || null, seeking: false }
  : null;

async function main() {
  await loadFonts();
  const app = document.getElementById('app')!;
  const stage = h('div', { id: 'stage' });
  const screen = new Screen();
  const modal = new ModalRoot();
  const toasts = new Toasts();
  const tooltip = new Tooltip();
  const legend = new LegendPanel();
  let conn: { send(m: import('@isomorph/core').ClientMessage): void } | null = null;
  const send: Connection['send'] = (m) => conn?.send(m);

  const kindTitle = (kindId: string) => state.hello?.grammar.kinds.find((k) => k.id === kindId)?.title ?? kindId;
  /** 지금 화면에 보이는 세계(가상 재생 중이면 그 장면) */
  const shownWorld = () => (player.active ? player.frame()?.world ?? null : state.world);

  const town = new Town({
    onSelect(id) {
      select(id);
    },
    onHover(id, x, y) {
      const e = id ? shownWorld()?.entities.find((x) => x.id === id) : null;
      const r = stage.getBoundingClientRect();
      if (e) tooltip.show(e, kindTitle(e.kind), x + r.left, y + r.top);
      else tooltip.hide();
    },
  });

  const inspector = new Inspector({
    onClose: () => select(null),
    onSelect: (id) => {
      select(id);
      town.focus(id);
    },
    onCopyLink: (id) => {
      const u = new URL(location.href);
      u.search = '';
      u.hash = '';
      u.searchParams.set('focus', id);
      if (state.mode === 'history' && state.seekTs) u.searchParams.set('at', String(state.seekTs));
      const link = u.toString();
      const done = () => toasts.show('success', '이 개체로 오는 링크를 복사했습니다');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => window.prompt('링크', link));
      else window.prompt('링크', link);
    },
    onAffordance: (entityId, affordanceId) => send({ type: 'dryrun', entityId, affordanceId }),
    onInvariant: (id, status) => send({ type: 'invariant', id, status }),
  });
  const actions = new ActionLog((id) => send({ type: 'undo', actionId: id }));
  const timeline = new Timeline(
    (ts) => send({ type: 'seek', ts }),
    () => send({ type: 'live' }),
  );
  const lab = new LabPanel({
    onClose: () => lab.toggle(false),
    onSimulate: (hyp) => send({ type: 'simulate', hypothesis: hyp }),
    onPlay: (r) => startSim(r),
  });
  const player = new SimPlayer({
    onFrame: () => {
      const f = player.frame();
      if (!f) return;
      town.setWorld(f.world);
      const { n, critical } = countViolations(f.world);
      topbar.setViolations(n, critical);
      if (state.selected) {
        const e = f.world.entities.find((x) => x.id === state.selected);
        if (e) inspector.virtual(e, kindTitle(e.kind), f.t);
      }
    },
    onExit: () => exitSim(),
  });

  function startSim(r: SimulationResult) {
    if (state.mode === 'history') send({ type: 'live' });
    select(null);
    stage.classList.add('virtual');
    timeline.el.classList.add('hidden');
    player.start(r);
  }

  function exitSim() {
    player.stop();
    stage.classList.remove('virtual');
    timeline.el.classList.remove('hidden');
    select(null);
    if (state.world) onWorld(state.world, 'live');
  }

  const topbar = new Topbar({
    onShare: () => {
      const a = document.createElement('a');
      a.href = '/api/snapshot?minutes=10';
      a.download = '';
      a.click();
    },
    onVision: () => {
      const order: Vision[] = ['normal', 'protan', 'deutan', 'tritan'];
      const next = order[(order.indexOf(town.vision) + 1) % order.length];
      town.setVision(next);
      topbar.setVision(next === 'normal' ? '일반' : VISION_KO[next], next !== 'normal');
    },
    onLab: () => {
      const open = !lab.visible;
      legend.toggle(false);
      lab.toggle(open);
      if (open) send({ type: 'lab' });
    },
    onLegend: () => {
      lab.toggle(false);
      legend.toggle();
    },
    onFit: () => town.fit(),
    onZoom: (d) => town.zoom(d),
    onVerification: async () => {
      if (!state.hello) return;
      let extra = null;
      try {
        extra = await (await fetch('/api/hello')).json();
      } catch {
        /* 부하 시험 등 */
      }
      modal.open(verificationModal(state.hello.verification, extra));
    },
    onNextViolation: () => {
      const v = state.world?.violations ?? [];
      if (!v.length) return;
      const target = v[state.violationCursor++ % v.length];
      const e = state.world!.entities.find((x) => x.source.collection === target.collection && String(x.source.pk) === String(target.pk));
      if (e) {
        town.focus(e.id);
        select(e.id);
      }
    },
  });

  app.append(topbar.el, stage, legend.el, lab.el, inspector.el, actions.el, timeline.el, timeline.bannerEl, player.el, tooltip.el, toasts.el, modal.el, screen.el);
  await town.init(stage);

  function select(id: string | null) {
    state.selected = id;
    town.select(id);
    if (!id) return inspector.hide();
    if (player.active) {
      const f = player.frame();
      const e = f?.world.entities.find((x) => x.id === id);
      if (e && f) inspector.virtual(e, kindTitle(e.kind), f.t);
      return;
    }
    const e = state.world?.entities.find((x) => x.id === id);
    if (e) inspector.loading(e, kindTitle(e.kind));
    send({ type: 'inspect', entityId: id });
  }

  function onHello(m: HelloMessage) {
    state.hello = m;
    topbar.setHello(m);
    if (state.mode === 'live') topbar.setConnection('live');
    legend.render(m);
    town.setGrammar(m.grammar);
    void town.bank.loadGenerated(m.assets);
    if (!m.verification.ok) screen.refused(m);
  }

  function onWorld(w: WorldState, mode: 'live' | 'history') {
    state.world = w;
    if (state.hello?.verification.ok) screen.hide();
    if (player.active) return; // 가상 세계를 재생하는 동안 실제 세계는 뒤에서만 갱신
    town.setWorld(w);
    const { n, critical } = countViolations(w);
    topbar.setViolations(n, critical);
    if (mode !== state.mode || mode === 'history') {
      state.mode = mode;
      state.seekTs = mode === 'history' ? w.ts : null;
      town.setHistory(mode === 'history');
      timeline.setMode(mode, w.ts);
      topbar.setConnection(mode, w.ts);
    }
    if (state.selected && mode === 'live' && Math.random() < 0.34) send({ type: 'inspect', entityId: state.selected });
    if (state.selected && mode === 'history') send({ type: 'inspect', entityId: state.selected });
    openDeepLink(w, mode);
  }

  /** 알림 링크로 왔으면: 그 시점으로 되감은 뒤 그 개체를 고르고 화면 가운데로 */
  function openDeepLink(w: WorldState, mode: 'live' | 'history') {
    if (!deepLink) return;
    if (deepLink.at && !deepLink.seeking) {
      deepLink.seeking = true;
      send({ type: 'seek', ts: deepLink.at });
      return;
    }
    if (deepLink.at && mode !== 'history') return; // 되감은 세계를 기다린다
    const { id } = deepLink;
    deepLink = null;
    if (w.entities.some((e) => e.id === id)) {
      town.focus(id);
      select(id);
    } else toasts.show('warning', '링크의 개체가 이 시점의 세계에 없습니다');
  }

  function onInspect(m: InspectMessage) {
    if (!state.hello) return;
    const e = m.entity;
    inspector.render(m, e ? kindTitle(e.kind) : '', state.hello.grammar.invariants, state.mode === 'history');
    if (m.entityId === state.selected)
      town.setLinks(
        m.entityId,
        (m.related ?? []).filter((r) => r.entityId).map((r) => ({ id: r.entityId!, bad: r.violations.length > 0, cross: r.crossSystem })),
        (m.chain ?? []).filter((s) => s.entityId).map((s) => s.entityId!),
      );
  }

  function onDryRun(m: DryRunMessage) {
    state.dryrun = m;
    town.showPreview(m.preview);
    modal.open(
      dryRunModal(m, state.hello?.writeMode ?? 'read-only', () => {
        if (m.planId) send({ type: 'approve', planId: m.planId });
        state.dryrun = null;
        town.showPreview(null);
        modal.close();
      }, () => modal.close()),
      () => {
        if (state.dryrun?.planId) send({ type: 'cancel', planId: state.dryrun.planId });
        state.dryrun = null;
        town.showPreview(null);
      },
      true,
    );
  }

  function onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'hello':
        return onHello(m);
      case 'world':
        return onWorld(m.world, m.mode);
      case 'timeline':
        return timeline.setData(m);
      case 'inspect':
        return onInspect(m);
      case 'dryrun':
        return onDryRun(m);
      case 'actions':
        return actions.render(m.actions);
      case 'lab':
        return lab.setLab(m.model, m.hypotheses);
      case 'simulation-progress':
        return lab.setProgress(m.hypothesisId, m.done, m.total);
      case 'simulation':
        lab.addResult(m.result);
        return startSim(m.result);
      case 'grammar':
        if (state.hello) {
          state.hello = { ...state.hello, grammar: m.grammar, legend: m.legend };
          legend.render(state.hello);
          town.setGrammar(m.grammar);
        }
        return;
      case 'toast': {
        const focusable = m.level === 'warning' && /법칙 위반: .* \((\w+) #([\w-]+)\)/.exec(m.message);
        return toasts.show(m.level, m.message, focusable ? { label: '보기', run: () => {
          const e = state.world?.entities.find((x) => x.source.collection === focusable[1] && String(x.source.pk) === focusable[2]);
          if (e) {
            town.focus(e.id);
            select(e.id);
          }
        } } : undefined);
      }
    }
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === 'Escape' && player.active) exitSim();
    if (ev.key === 'l') legend.toggle();
    if (ev.key === 'v') topbar.el.querySelector<HTMLButtonElement>('button[title^="색각"]')?.click();
    if (ev.key === 'f') town.fit();
    if (ev.key === '+' || ev.key === '=') town.zoom(1);
    if (ev.key === '-') town.zoom(-1);
  });

  if (stressN > 0) {
    // 부하 시험 모드
    onHello(stressHello());
    let tick = 0;
    onWorld(stressWorld(stressN, tick), 'live');
    topbar.setConnection('stress');
    setInterval(() => onWorld(stressWorld(stressN, ++tick), 'live'), 1000);
    setInterval(() => topbar.setFps(town.fps, town.entityCount), 500);
    (window as unknown as { __iso: unknown }).__iso = { town, fps: () => town.fps };
    return;
  }

  // 공유본(HTML 한 파일)으로 열렸으면 서버 대신 브라우저 안의 작은 서버와 이야기한다
  const bundle = embeddedBundle();
  if (bundle) {
    topbar.setShared(bundle.end);
    const local = new LocalServer(bundle, onMessage);
    conn = local;
    local.connect();
    (window as unknown as { __iso: unknown }).__iso = { town, state, send, player, shared: true };
    return;
  }

  screen.connecting();
  const ws = new Connection(wsUrl(), onMessage, async (s) => {
    topbar.setConnection(s === 'open' ? 'live' : 'offline');
    if (s === 'open') {
      try {
        const info = await (await fetch('/api/hello')).json();
        if (info.status === 'error') screen.error(info.error ?? '알 수 없는 오류');
      } catch {
        /* 무시 */
      }
    }
  });
  conn = ws;
  ws.connect();
  (window as unknown as { __iso: unknown }).__iso = { town, state, send, player };
}

main();
