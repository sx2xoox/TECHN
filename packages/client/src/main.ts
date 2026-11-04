import './style.css';
import type { DryRunMessage, HelloMessage, InspectMessage, ServerMessage, WorldState } from '@isomorph/core';
import { loadFonts } from './fonts.ts';
import { Connection, wsUrl } from './net.ts';
import { stressHello, stressWorld } from './stress.ts';
import { h } from './ui/dom.ts';
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

async function main() {
  await loadFonts();
  const app = document.getElementById('app')!;
  const stage = h('div', { id: 'stage' });
  const screen = new Screen();
  const modal = new ModalRoot();
  const toasts = new Toasts();
  const tooltip = new Tooltip();
  const legend = new LegendPanel();
  let conn: Connection | null = null;
  const send: Connection['send'] = (m) => conn?.send(m);

  const kindTitle = (kindId: string) => state.hello?.grammar.kinds.find((k) => k.id === kindId)?.title ?? kindId;

  const town = new Town({
    onSelect(id) {
      select(id);
    },
    onHover(id, x, y) {
      const e = id ? state.world?.entities.find((x) => x.id === id) : null;
      const r = stage.getBoundingClientRect();
      if (e) tooltip.show(e, kindTitle(e.kind), x + r.left, y + r.top);
      else tooltip.hide();
    },
  });

  const inspector = new Inspector({
    onClose: () => select(null),
    onAffordance: (entityId, affordanceId) => send({ type: 'dryrun', entityId, affordanceId }),
    onInvariant: (id, status) => send({ type: 'invariant', id, status }),
  });
  const actions = new ActionLog((id) => send({ type: 'undo', actionId: id }));
  const timeline = new Timeline(
    (ts) => send({ type: 'seek', ts }),
    () => send({ type: 'live' }),
  );
  const topbar = new Topbar({
    onLegend: () => legend.toggle(),
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

  app.append(topbar.el, stage, legend.el, inspector.el, actions.el, timeline.el, timeline.bannerEl, tooltip.el, toasts.el, modal.el, screen.el);
  await town.init(stage);

  function select(id: string | null) {
    state.selected = id;
    town.select(id);
    if (!id) return inspector.hide();
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
  }

  function onInspect(m: InspectMessage) {
    if (!state.hello) return;
    const e = m.entity;
    inspector.render(m, e ? kindTitle(e.kind) : '', state.hello.grammar.invariants, state.mode === 'history');
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
    if (ev.key === 'l') legend.toggle();
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

  screen.connecting();
  conn = new Connection(wsUrl(), onMessage, async (s) => {
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
  conn.connect();
  (window as unknown as { __iso: unknown }).__iso = { town, state, send };
}

main();
