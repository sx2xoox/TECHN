import type { Diagnosis, Incident, Violation } from '@isomorph/core';
import { duration } from './incidents.ts';
import { redact, type IsomorphRuntime, type ViolationEvent } from './runtime.ts';

/**
 * 알림: 법칙이 새로 깨지면(그리고 풀리면) 웹훅으로 알린다. 받은 사람은 링크 하나로 그 개체·그 시점의 세계를 연다.
 *  - 묶음: batchMs 안에 생긴 것은 메시지 하나로.
 *  - 되풀이 억제: 같은 위반(법칙+행)이 cooldownMs 안에 다시 시작되면 다시 알리지 않는다(깜빡임).
 *  - 풀림: 알렸던 위반이 풀리면 '복구' 로 알린다.
 *  - 민감 값은 세계와 같은 규칙으로 가려져 있다(위반 값·진단 모두). 웹훅 주소는 로그에 남기지 않는다.
 */
export interface NotifyOptions {
  /** http(s) 웹훅 주소(Slack incoming webhook, Discord webhook, 또는 JSON 을 받는 아무 주소) */
  webhook: string;
  /** auto: 주소로 판단(hooks.slack.com → slack, discord.com/api/webhooks → discord, 그 밖 → json) */
  format?: 'auto' | 'slack' | 'discord' | 'json';
  /** 링크의 앞부분(예: https://isomorph.example.com). 없으면 링크를 싣지 않는다 */
  publicUrl?: string | null;
  /** 이 심각도 이상만(기본 warning). '추정' 법칙은 critical 일 때만 */
  minSeverity?: Violation['severity'];
  batchMs?: number;
  cooldownMs?: number;
  /** 풀림도 알릴지(기본 true) */
  resolved?: boolean;
  /** 시작할 때 이미 깨져 있던 것도 알릴지(기본 false: 다시 시작할 때마다 같은 알림이 쏟아지지 않게) */
  existing?: boolean;
  log?: (m: string) => void;
  /** 시험용 */
  fetchImpl?: typeof fetch;
}

export interface NotifyItem {
  phase: 'start' | 'end';
  at: number;
  title: string;
  severity: Violation['severity'];
  collection: string;
  pk: string;
  entityId: string | null;
  values: Violation['values'];
  diagnosis: Pick<Diagnosis, 'pattern' | 'title' | 'detail'> | null;
  link: string | null;
  /** 근본 원인 사슬의 끝(거슬러 오를 곳이 있을 때만) */
  root: { collection: string; pk: string; entityId: string | null; label: string; violation: string; crossSystem: boolean; hops: number; link: string | null } | null;
  /** 근본 원인(없으면 이 개체)이 위반 직전에 받은 변경: 세계에서 되돌릴 수 있다 */
  change: { field: string; now: unknown; to: unknown }[] | null;
}

export interface NotifyPayload {
  system: string;
  text: string;
  items: NotifyItem[];
  /** 한 메시지에 다 싣지 못한 수 */
  more?: number;
}

const SEV = { info: 0, warning: 1, critical: 2 } as const;

export function detectFormat(webhook: string): 'slack' | 'discord' | 'json' {
  const u = new URL(webhook);
  if (u.hostname === 'hooks.slack.com') return 'slack';
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  return 'json';
}

/** 세계의 그 자리로 가는 링크: 개체를 고르고, 그 시점으로 되감는다 */
export function deepLink(publicUrl: string, entityId: string | null, at?: number): string {
  const u = new URL(publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`);
  if (entityId) u.searchParams.set('focus', entityId);
  if (at) u.searchParams.set('at', String(at));
  return u.toString();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 데이터 속 마크다운이 Discord 에서 링크·강조가 되지 않게(우리가 다는 링크는 그대로) */
const discordSafe = (s: string) => s.replace(/[\\*_~`|>#[\]()]/g, (c) => `\\${c}`);

export function formatText(system: string, items: NotifyItem[], style: 'slack' | 'plain' | 'discord', more = 0): string {
  const starts = items.filter((i) => i.phase === 'start');
  const ends = items.filter((i) => i.phase === 'end');
  const head = [starts.length ? `법칙 위반 ${starts.length}건` : '', ends.length ? `복구 ${ends.length}건` : ''].filter(Boolean).join(' · ');
  const link = (url: string | null, label: string) => (!url ? '' : style === 'slack' ? ` <${url}|${label}>` : ` ${label}: ${url}`);
  // 데이터에서 온 글자는 Slack 문법(<!channel> 멘션, <링크|글>)으로 해석되지 않게 막는다
  const t = (s: string) => (style === 'slack' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : style === 'discord' ? discordSafe(s) : s);
  const lines = [`ISOMORPH · ${t(system)} — ${head}${more ? ` (그 밖에 ${more}건은 세계에서 확인)` : ''}`];
  for (const i of starts) {
    lines.push(`${i.severity === 'critical' ? '🔴' : '🟠'} ${t(i.title)} — ${t(i.collection)} #${t(i.pk)}${link(i.link, '세계에서 보기')}`);
    if (i.root) lines.push(`    근본 원인(${i.root.hops}단계 위): ${t(i.root.label)} — ${t(i.root.collection)} #${t(i.root.pk)} · ${t(i.root.violation)}${i.root.crossSystem ? ' [다른 시스템]' : ''}${link(i.root.link, '근본 원인 보기')}`);
    else if (i.diagnosis && i.diagnosis.pattern !== 'unknown') lines.push(`    원인 후보: ${t(i.diagnosis.title)} — ${t(clip(i.diagnosis.detail, 220))}`);
    if (i.change?.length) lines.push(`    직전 변경: ${i.change.map((c) => `${t(c.field)} ${t(clip(JSON.stringify(c.to), 60))} → ${t(clip(JSON.stringify(c.now), 60))}`).join(', ')} (세계에서 되돌릴 수 있음)`);
  }
  for (const i of ends) lines.push(`✅ 복구: ${t(i.title)} — ${t(i.collection)} #${t(i.pk)}${link(i.link, '보기')}`);
  return lines.join('\n');
}

export function formatPayload(format: 'slack' | 'discord' | 'json', p: NotifyPayload): unknown {
  if (format === 'slack') return { text: formatText(p.system, p.items, 'slack', p.more) };
  if (format === 'discord') return { content: clip(formatText(p.system, p.items, 'discord', p.more), 1900), allowed_mentions: { parse: [] } };
  return { text: formatText(p.system, p.items, 'plain', p.more), system: p.system, items: p.items, ...(p.more ? { more: p.more } : {}) };
}

export function formatIncidentText(system: string, inc: Incident, report: string | null, style: 'slack' | 'plain' | 'discord'): string {
  const t = (s: string) => (style === 'slack' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : style === 'discord' ? discordSafe(s) : s);
  const took = inc.closedAt ? duration(inc.closedAt - inc.openedAt) : '';
  const places = new Set(inc.violations.map((v) => `${v.collection}:${v.pk}`)).size;
  const fixes = inc.actions.filter((a) => a.status === 'verified' || a.status === 'applied').map((a) => `${t(a.title)}${a.status === 'verified' ? '(확인됨)' : ''}`);
  const lines = [`✅ 장애 종료(${took}) — ISOMORPH · ${t(system)}`];
  lines.push(`    근본 원인: ${t(inc.root.label)} — ${t(inc.root.collection)} #${t(inc.root.pk)} · ${t(inc.root.violation)}${inc.root.crossSystem ? ' [다른 시스템]' : ''}`);
  lines.push(`    영향 ${places}곳 · 조치: ${fixes.length ? fixes.join(', ') : '없음(저절로 회복)'}`);
  if (report) lines.push(style === 'slack' ? `    <${report}|사후 보고서>` : `    사후 보고서: ${report}`);
  return lines.join('\n');
}

export function formatPayloadIncident(format: 'slack' | 'discord' | 'json', system: string, inc: Incident, report: string | null): unknown {
  if (format === 'slack') return { text: formatIncidentText(system, inc, report, 'slack') };
  if (format === 'discord') return { content: clip(formatIncidentText(system, inc, report, 'discord'), 1900), allowed_mentions: { parse: [] } };
  return { text: formatIncidentText(system, inc, report, 'plain'), system, incident: { id: inc.id, openedAt: inc.openedAt, closedAt: inc.closedAt, root: inc.root, change: inc.change, actions: inc.actions.map((a) => ({ title: a.title, status: a.status, at: a.at })), report } };
}

const MAX_ITEMS = 20;

/** 주소 검사(오류 문구에 주소를 싣지 않는다: 웹훅 주소에는 비밀 토큰이 들어 있다) */
function httpUrl(value: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${what}가 올바른 주소가 아닙니다(https://… 형태여야 합니다)`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${what}는 http(s) 주소여야 합니다`);
  return u;
}

export function attachNotifier(rt: IsomorphRuntime, opts: NotifyOptions) {
  httpUrl(opts.webhook, '알림 웹훅');
  if (opts.publicUrl) httpUrl(opts.publicUrl, '공개 주소(--public-url)');
  const format = !opts.format || opts.format === 'auto' ? detectFormat(opts.webhook) : opts.format;
  const log = opts.log ?? (() => {});
  const min = SEV[opts.minSeverity ?? 'warning'];
  const batchMs = opts.batchMs ?? 3000;
  const cooldownMs = opts.cooldownMs ?? 10 * 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const pending: ViolationEvent[] = [];
  /** 알린 위반 → 마지막으로 시작을 알린 시각 */
  const notified = new Map<string, number>();
  const stats = { sent: 0, failed: 0, suppressed: 0 };
  let timer: NodeJS.Timeout | null = null;
  let inflight: Promise<void> = Promise.resolve();
  const key = (v: Violation) => `${v.invariantId}:${String(v.pk)}`;

  const onViolation = (e: ViolationEvent) => {
    const v = e.violation;
    if (e.phase === 'start') {
      if (SEV[v.severity] < min || (v.proposed && v.severity !== 'critical')) return;
      if (e.initial && !opts.existing) {
        // 알리지는 않지만 '알린 것' 으로 쳐서 풀리면 복구는 알린다(되풀이 억제 시계는 돌리지 않는다)
        notified.set(key(v), Number.NEGATIVE_INFINITY);
        stats.suppressed++;
        return;
      }
      const last = notified.get(key(v));
      if (last !== undefined && e.ts - last < cooldownMs) {
        stats.suppressed++;
        return;
      }
    } else if (opts.resolved === false || !notified.has(key(v))) return;
    pending.push(e);
    if (!timer) timer = setTimeout(() => void flush(), batchMs);
  };

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending.splice(0);
    if (!batch.length) return inflight;
    for (const e of batch) if (e.phase === 'start') notified.set(key(e.violation), e.ts);
    // 한꺼번에 많이 깨지면: 시작을 먼저, 메시지 하나에 MAX_ITEMS 개까지만 싣고(진단 계산도 그만큼만) 나머지는 수로
    const ordered = [...batch.filter((e) => e.phase === 'start'), ...batch.filter((e) => e.phase === 'end')];
    const shown = ordered.slice(0, MAX_ITEMS);
    const more = ordered.length - shown.length;
    let items: NotifyItem[];
    try {
      items = shown.map((e) => {
        const v = e.violation;
        // 진단·근본 원인은 지금 세계에서 계산한다(살펴보기와 같은 결과, 민감 값은 가려짐)
        const ins = e.phase === 'start' && e.entityId ? rt.inspect(e.entityId) : null;
        const diag = ins?.diagnosis ?? null;
        const last = ins?.chain?.at(-1);
        const root = last
          ? { collection: last.collection, pk: String(last.pk), entityId: last.entityId, label: last.label, violation: last.violation, crossSystem: ins!.chain!.some((s) => s.crossSystem), hops: ins!.chain!.length, link: opts.publicUrl && last.entityId ? deepLink(opts.publicUrl, last.entityId, e.ts) : null }
          : null;
        return {
          phase: e.phase,
          at: e.ts,
          title: v.title,
          severity: v.severity,
          collection: v.collection,
          pk: String(v.pk),
          entityId: e.entityId,
          values: v.values,
          diagnosis: diag ? { pattern: diag.pattern, title: diag.title, detail: diag.detail } : null,
          link: opts.publicUrl ? deepLink(opts.publicUrl, e.entityId, e.phase === 'start' ? e.ts : undefined) : null,
          root,
          change: (last?.entityId ? rt.inspect(last.entityId).revert?.changes : ins?.revert?.changes) ?? null,
        };
      });
    } catch (err) {
      // 알림 준비가 실패해도 세계(서버)는 멈추지 않는다
      stats.failed++;
      log(`알림 준비 실패: ${redact(String((err as Error)?.message ?? err))}`);
      return inflight;
    }
    return post(formatPayload(format, { system: rt.schema?.system ?? 'isomorph', text: '', items, more }), `${items.length}건${more ? ` 외 ${more}건` : ''}`);
  };

  const post = (payload: unknown, what: string) => {
    inflight = inflight.then(async () => {
      try {
        const r = await doFetch(opts.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`응답 ${r.status}`);
        stats.sent++;
        log(`알림 보냄: ${what}`);
      } catch (err) {
        stats.failed++;
        // 웹훅 주소는 비밀(토큰이 들어 있다): 오류 문구에서도 지운다
        log(`알림 실패(${format}): ${redact(String((err as Error).message ?? err).split(opts.webhook).join('(웹훅)'))}`);
      }
    });
    return inflight;
  };

  /** 장애가 닫히면 요약: 얼마나 갔는지, 근본 원인, 조치, 사후 보고서 링크(알렸던 위반이 있었던 장애만) */
  const onIncidentClosed = (inc: Incident) => {
    if (!inc.violations.some((v) => notified.has(v.key))) return;
    const report = opts.publicUrl ? new URL(`api/incidents/${inc.id}.md`, opts.publicUrl.endsWith('/') ? opts.publicUrl : `${opts.publicUrl}/`).toString() : null;
    // 같은 순간의 '복구' 알림이 먼저 가도록: 이번 관측의 사건이 다 쌓인 뒤 묶음을 보내고, 그 다음에 요약
    const job = () => {
      summaries.delete(timer);
      void flush();
      try {
        void post(formatPayloadIncident(format, rt.schema?.system ?? 'isomorph', inc, report), '장애 종료 요약');
      } catch (err) {
        stats.failed++;
        log(`알림 준비 실패: ${redact(String((err as Error)?.message ?? err))}`);
      }
    };
    const timer = setTimeout(job, 0);
    summaries.set(timer, job);
  };
  const summaries = new Map<NodeJS.Timeout, () => void>();

  rt.on('violation', onViolation);
  rt.on('incident-closed', onIncidentClosed);
  return {
    stats,
    format,
    /** 기다리는 묶음을 바로 보낸다(종료·시험용) */
    flush,
    async stop() {
      rt.off('violation', onViolation);
      rt.off('incident-closed', onIncidentClosed);
      // 기다리던 요약은 버리지 않고 지금 보낸 뒤 끝낸다
      for (const [t, job] of summaries) {
        clearTimeout(t);
        job();
      }
      await flush();
    },
  };
}
