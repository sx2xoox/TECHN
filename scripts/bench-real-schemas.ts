import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PostgresAdapter } from '@isomorph/adapters';
import { IsomorphRuntime, serve } from '@isomorph/server';

/**
 * 남이 만든 공개 예제 DB 로 '처음 보는 시스템' 을 시험한다.
 *   - 컴파일러를 만든 사람이 쓰지 않은 스키마·데이터
 *   - 사람 개입 없이: 연결 → 스키마 읽기 → 컴파일 → 렌즈 검증 → 세계
 *   - 깨끗한(것으로 알려진) 데이터에서 법칙 위반이 몇 개 켜지는가 = 거짓 경보 후보
 *
 * 사용: REAL_PG_URL=postgres://user@127.0.0.1:5432 npx tsx scripts/bench-real-schemas.ts [--shots dir] [--json out.json]
 * 데이터베이스 목록은 DATABASES="northwind:public,chinook:public,pagila:public,demo:bookings" 로 바꿀 수 있다.
 */
const base = process.env.REAL_PG_URL;
if (!base) {
  console.error('REAL_PG_URL 이 필요합니다(예: postgres://samples@127.0.0.1:55432)');
  process.exit(2);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
};
const shotsDir = arg('--shots');
const jsonOut = arg('--json');
const targets = (process.env.DATABASES ?? 'northwind:public,chinook:public,pagila:public,demo:bookings').split(',').map((s) => {
  const [db, schema = 'public'] = s.split(':');
  return { db, schema };
});

interface Result {
  db: string;
  schema: string;
  tables: number;
  rows: number;
  status: string;
  ms: number;
  fidelity: number | null;
  kinds: number;
  /** 규칙 기반 어휘에 없는 이름이라 '건물'·'주민' 같은 일반 은유로 남은 종류 */
  genericKinds: string[];
  channels: number;
  affordances: number;
  invariants: { confirmed: number; proposed: number };
  entities: number;
  violations: { id: string; title: string; source: string; status: string; count: number; sample: unknown }[];
  error?: string;
}

const results: Result[] = [];
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any = null;
if (shotsDir) {
  browser = await require('playwright').chromium.launch();
  fs.mkdirSync(shotsDir, { recursive: true });
}

for (const t of targets) {
  const url = `${base.replace(/\/$/, '')}/${t.db}`;
  const started = Date.now();
  const rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: url, schema: t.schema, system: t.db }), pollMs: 60_000, numRuns: 60, compile: { mode: 'heuristic' } });
  const r: Result = { db: t.db, schema: t.schema, tables: 0, rows: 0, status: 'error', ms: 0, fidelity: null, kinds: 0, genericKinds: [], channels: 0, affordances: 0, invariants: { confirmed: 0, proposed: 0 }, entities: 0, violations: [] };
  try {
    r.status = await rt.start();
    r.ms = Date.now() - started;
    r.tables = rt.schema?.collections.length ?? 0;
    r.rows = Object.values(rt.lastSnapshot?.collections ?? {}).reduce((a, rows) => a + rows.length, 0);
    r.fidelity = rt.report?.fidelity.score ?? null;
    const g = rt.grammar;
    if (g) {
      r.kinds = g.kinds.length;
      r.genericKinds = g.kinds.filter((k) => /^(건물|주민)(\(|$)/.test(k.title)).map((k) => k.collection);
      r.channels = g.kinds.reduce((a, k) => a + k.channels.length, 0);
      r.affordances = g.affordances.length;
      r.invariants = { confirmed: g.invariants.filter((i) => i.status === 'confirmed').length, proposed: g.invariants.filter((i) => i.status === 'proposed').length };
    }
    const w = rt.world;
    if (w) {
      r.entities = w.entities.length;
      const by = new Map<string, Result['violations'][number]>();
      for (const v of w.violations) {
        const inv = g?.invariants.find((i) => i.id === v.invariantId);
        const cur = by.get(v.invariantId) ?? { id: v.invariantId, title: v.title, source: inv?.source ?? '?', status: inv?.status ?? '?', count: 0, sample: { pk: v.pk, ...v.values } };
        cur.count++;
        by.set(v.invariantId, cur);
      }
      r.violations = [...by.values()].sort((a, b) => b.count - a.count);
    }
    if (browser && r.status === 'running') {
      const staticDir = path.resolve('packages/client/dist');
      const srv = await serve(rt, { port: 0, staticDir });
      const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
      await page.goto(srv.url);
      await page.waitForFunction('window.__iso?.state?.world?.entities?.length > 0', null, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(shotsDir!, `${t.db}.png`) });
      await page.close();
      await srv.close();
    }
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
  } finally {
    await rt.stop().catch(() => undefined);
  }
  results.push(r);
  console.log(`\n■ ${t.db} (${t.schema}): ${r.status} · 테이블 ${r.tables} · 행 ${r.rows} · ${r.ms}ms · 충실도 ${r.fidelity ?? '-'} · 개체 종류 ${r.kinds}(일반 은유 ${r.genericKinds.length}) · 채널 ${r.channels} · 행동 ${r.affordances} · 법칙 확정 ${r.invariants.confirmed}/추정 ${r.invariants.proposed} · 위반 ${r.violations.reduce((a, v) => a + v.count, 0)}`);
  if (r.error) console.log(`  오류: ${r.error}`);
  for (const v of r.violations) console.log(`  - [${v.status}·${v.source}] ${v.title} ×${v.count}  예: ${JSON.stringify(v.sample).slice(0, 160)}`);
}
if (browser) await browser.close();
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
const opened = results.filter((r) => r.status === 'running').length;
const kinds = results.reduce((a, r) => a + r.kinds, 0);
const generic = results.reduce((a, r) => a + r.genericKinds.length, 0);
console.log(`\n세계가 열림: ${opened}/${results.length} · 법칙 위반(깨끗한 데이터의 거짓 경보 후보) ${results.reduce((a, r) => a + r.violations.reduce((b, v) => b + v.count, 0), 0)}개 · 일반 은유로 남은 종류 ${generic}/${kinds}`);
process.exit(0);
