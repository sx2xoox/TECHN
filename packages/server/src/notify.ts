import type { Diagnosis, Violation } from '@isomorph/core';
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
}

export interface NotifyPayload {
  system: string;
  text: string;
  items: NotifyItem[];
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

export function formatText(system: string, items: NotifyItem[], style: 'slack' | 'plain'): string {
  const starts = items.filter((i) => i.phase === 'start');
  const ends = items.filter((i) => i.phase === 'end');
  const head = [starts.length ? `법칙 위반 ${starts.length}건` : '', ends.length ? `복구 ${ends.length}건` : ''].filter(Boolean).join(' · ');
  const link = (url: string | null, label: string) => (!url ? '' : style === 'slack' ? ` <${url}|${label}>` : ` ${label}: ${url}`);
  // 데이터에서 온 글자는 Slack 문법(<!channel> 멘션, <링크|글>)으로 해석되지 않게 막는다
  const t = (s: string) => (style === 'slack' ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : s);
  const lines = [`ISOMORPH · ${t(system)} — ${head}`];
  for (const i of starts) {
    lines.push(`${i.severity === 'critical' ? '🔴' : '🟠'} ${t(i.title)} — ${t(i.collection)} #${t(i.pk)}${link(i.link, '세계에서 보기')}`);
    if (i.root) lines.push(`    근본 원인(${i.root.hops}단계 위): ${t(i.root.label)} — ${t(i.root.collection)} #${t(i.root.pk)} · ${t(i.root.violation)}${i.root.crossSystem ? ' [다른 시스템]' : ''}${link(i.root.link, '근본 원인 보기')}`);
    else if (i.diagnosis && i.diagnosis.pattern !== 'unknown') lines.push(`    원인 후보: ${t(i.diagnosis.title)} — ${t(clip(i.diagnosis.detail, 220))}`);
  }
  for (const i of ends) lines.push(`✅ 복구: ${t(i.title)} — ${t(i.collection)} #${t(i.pk)}${link(i.link, '보기')}`);
  return lines.join('\n');
}

export function formatPayload(format: 'slack' | 'discord' | 'json', p: NotifyPayload): unknown {
  if (format === 'slack') return { text: formatText(p.system, p.items, 'slack') };
  if (format === 'discord') return { content: clip(formatText(p.system, p.items, 'plain'), 1900), allowed_mentions: { parse: [] } };
  return { text: formatText(p.system, p.items, 'plain'), system: p.system, items: p.items };
}

export function attachNotifier(rt: IsomorphRuntime, opts: NotifyOptions) {
  const u = new URL(opts.webhook);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('알림 웹훅은 http(s) 주소여야 합니다');
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
    const items: NotifyItem[] = batch.map((e) => {
      const v = e.violation;
      if (e.phase === 'start') notified.set(key(v), e.ts);
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
      };
    });
    const payload = formatPayload(format, { system: rt.schema?.system ?? 'isomorph', text: '', items });
    inflight = inflight.then(async () => {
      try {
        const r = await doFetch(opts.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`응답 ${r.status}`);
        stats.sent++;
        log(`알림 보냄: ${items.length}건`);
      } catch (err) {
        stats.failed++;
        // 웹훅 주소는 비밀(토큰이 들어 있다): 오류 문구에서도 지운다
        log(`알림 실패(${format}): ${redact(String((err as Error).message ?? err).split(opts.webhook).join('(웹훅)'))}`);
      }
    });
    return inflight;
  };

  rt.on('violation', onViolation);
  return {
    stats,
    format,
    /** 기다리는 묶음을 바로 보낸다(종료·시험용) */
    flush,
    async stop() {
      rt.off('violation', onViolation);
      await flush();
    },
  };
}
