import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeEvent, HelloMessage, Row, Snapshot, SystemSchema, TimelineMarker } from '@isomorph/core';
import type { IsomorphRuntime } from './runtime.ts';

/**
 * 공유본: 최근 몇 분의 세계를 HTML 파일 하나로 묶는다.
 *  - 서버도, 시스템 접근 권한도 없이 열린다(브라우저가 사건 기록에서 세계를 다시 계산한다).
 *  - 보기 전용: 행동은 모두 막힌다.
 *  - 민감 필드는 공유본마다 새로 만든 비밀 키로 가명화한다(같은 값은 같은 가명 → '중복' 같은 법칙은 그대로 보이고, 원래 값은 남지 않는다).
 */
export interface WorldBundle {
  version: 1;
  createdAt: number;
  hello: HelloMessage;
  schema: SystemSchema;
  base: Snapshot;
  events: ChangeEvent[];
  start: number;
  end: number;
  markers: TimelineMarker[];
}

export function buildWorldBundle(rt: IsomorphRuntime, opts: { minutes?: number } = {}): WorldBundle {
  if (!rt.grammar || !rt.schema) throw new Error('세계가 아직 열리지 않았습니다');
  const range = rt.store.range();
  if (!range) throw new Error('기록이 아직 없습니다');
  const end = range.end;
  const start = Math.max(range.start, end - (opts.minutes ?? 10) * 60_000);
  const base = rt.store.snapshotAt(start, rt.schema);
  if (!base) throw new Error('그 시점의 기록이 없습니다');
  const events = rt.store.eventsBetween(start, end).filter((e) => e.ts > start);

  // 가명화: 이 공유본 하나에만 쓰는 키(저장하지 않는다)
  const key = randomBytes(32);
  const sensitive = new Map(rt.schema.collections.map((c) => [c.name, new Set(c.fields.filter((f) => f.sensitive).map((f) => f.name))]));
  const pseudo = (v: unknown) => (v === null || v === undefined ? v : `•${createHmac('sha256', key).update(JSON.stringify(v)).digest('hex').slice(0, 10)}`);
  const clean = (collection: string, row: Row | null): Row | null => {
    const s = sensitive.get(collection);
    if (!row || !s?.size) return row;
    const out: Row = { ...row };
    for (const f of s) if (f in out) out[f] = pseudo(out[f]) as Row[string];
    return out;
  };
  const cleanBase: Snapshot = {
    ts: base.ts,
    collections: Object.fromEntries(Object.entries(base.collections).map(([c, rows]) => [c, rows.map((r) => clean(c, r)!)])),
    ...(rt.lastSnapshot?.outside ? { outside: rt.lastSnapshot.outside } : {}),
  };
  const cleanEvents = events.map((e) => ({ ...e, before: clean(e.collection, e.before), after: clean(e.collection, e.after) }));
  const hello: HelloMessage = { ...rt.hello(), writeMode: 'read-only', role: 'viewer', push: false, assets: null };
  return { version: 1, createdAt: Date.now(), hello, schema: rt.schema, base: cleanBase, events: cleanEvents, start, end, markers: rt.timeline().markers.filter((m) => m.ts >= start && m.ts <= end) };
}

/**
 * 한 파일짜리 보기 화면(클라이언트의 snapshot 빌드)에 공유본 자료를 끼워 넣는다.
 * viewerDir: packages/client/dist-snapshot (npm run build 가 만든다)
 */
export function renderSnapshotHtml(bundle: WorldBundle, viewerDir: string): string {
  const html = fs.readFileSync(path.join(viewerDir, 'snapshot.html'), 'utf8');
  const inline = html
    .replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/g, (_m, f: string) => `<script type="module">${fs.readFileSync(path.join(viewerDir, f), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`)
    .replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/g, (_m, f: string) => `<style>${fs.readFileSync(path.join(viewerDir, f), 'utf8')}</style>`);
  if (/src="\.\/assets\//.test(inline) || /href="\.\/assets\//.test(inline)) throw new Error('보기 화면을 한 파일로 묶지 못했습니다(npm run build 를 다시 해 보세요)');
  // 자료는 JSON 으로: '</' 를 막아 스크립트 블록을 빠져나가지 못하게 한다
  const data = JSON.stringify(bundle).replace(/</g, '\\u003c');
  const title = `${bundle.hello.grammar.title} — 공유본 ${new Date(bundle.end).toLocaleString('ko-KR')}`.replace(/[<>&"]/g, '');
  return inline.replace('<title>', `<title>${title} · `).replace('</head>', `<script id="isomorph-snapshot" type="application/json">${data}</script>\n</head>`);
}
