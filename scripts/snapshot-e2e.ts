import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgresAdapter } from '@isomorph/adapters';
import { startShop } from '@isomorph/demo-shop';
import { IsomorphRuntime, serve } from '@isomorph/server';

/**
 * 공유본 종단 간 시험: 데모 쇼핑몰의 세계를 HTML 한 파일로 내려받아, 네트워크를 모두 막은 채 file:// 로 연다.
 *   npm run build && npx tsx scripts/snapshot-e2e.ts [--shots dir]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shotsDir = (() => {
  const i = process.argv.indexOf('--shots');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
})();
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`공유본 시험 실패: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const shop = await startShop({ httpPort: 0, pgPort: 0, traffic: { firstFlashSaleMs: 2500, flashSaleEveryMs: 0, orderEveryMs: [300, 700] } });
const rt = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop', changeFeed: 'log', feedMs: 50 }), pollMs: 1000, numRuns: 40, compile: { mode: 'heuristic' } });
await rt.start();
const srv = await serve(rt, { port: 0, staticDir: path.join(root, 'packages/client/dist') });
const browser = await require('playwright').chromium.launch();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isomorph-share-'));
try {
  // 반짝 세일의 경쟁 조건(재고 음수)이 생길 때까지 기다린다
  for (let i = 0; i < 60 && !rt.world?.violations.some((v) => v.invariantId === 'nonneg_products_stock'); i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 4000));
  const emails = (await shop.db.query<{ email: string }>('select email from customers')).rows.map((r) => r.email).filter(Boolean);

  const res = await fetch(`${srv.url}/api/snapshot?minutes=5`);
  assert(res.status === 200 && /attachment/.test(res.headers.get('content-disposition') ?? ''), '운영자가 공유본을 내려받음');
  const html = await res.text();
  const file = path.join(dir, 'world.html');
  fs.writeFileSync(file, html);
  assert(emails.length > 0 && emails.every((e) => !html.includes(e)), `민감 정보(이메일 ${emails.length}개)가 파일 어디에도 없음`);
  console.log(`    파일 크기 ${(html.length / 1024 / 1024).toFixed(1)}MB`);

  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir ? 2 : 1 });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  const network: string[] = [];
  await page.route('**/*', (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
    const u = route.request().url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    network.push(u);
    return route.abort();
  });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction('window.__iso?.state?.world?.entities?.length > 0', null, { timeout: 30_000 });
  assert(await page.evaluate('window.__iso.shared === true'), '서버 없이 공유본 모드로 열림');
  assert(((await page.locator('#topbar').textContent()) ?? '').includes('공유본'), '상단에 공유본·보기 전용 표시');
  const neg = (await page.evaluate('window.__iso.state.world.violations.filter((v) => v.invariantId === "nonneg_products_stock").length')) as number;
  assert(neg >= 1, `내려받을 때의 법칙 위반(재고 음수 ${neg}건)이 그대로 보임`);
  await page.waitForTimeout(1200);
  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: path.join(shotsDir, '20-shared.png') });
  }

  // 시간 여행
  const tl = (await page.locator('#timeline canvas').boundingBox())!;
  await page.mouse.click(tl.x + tl.width * 0.05, tl.y + tl.height / 2);
  await page.waitForSelector('#history-banner:not(.hidden)', { timeout: 10_000 });
  assert(true, '타임라인으로 과거 시점 이동');
  await page.locator('#timeline button.live').click();

  // 살펴보기: 위반 창고를 눌러 원인 진단까지
  const target = (await page.evaluate(`(() => { const s = window.__iso.state; const v = s.world.violations.find((x) => x.invariantId === 'nonneg_products_stock'); return s.world.entities.find((e) => e.source.collection === v.collection && String(e.source.pk) === String(v.pk)).id; })()`)) as string;
  await page.evaluate(`window.__iso.send({ type: 'inspect', entityId: ${JSON.stringify(target)} })`);
  await page.evaluate(`(() => { window.__iso.town.focus(${JSON.stringify(target)}); })()`);
  await page.waitForTimeout(300);
  const pos = (await page.evaluate(`window.__iso.town.screenOf(${JSON.stringify(target)})`)) as { x: number; y: number };
  const stage = (await page.locator('#stage').boundingBox())!;
  await page.mouse.click(stage.x + pos.x, stage.y + pos.y + 20);
  await page.waitForSelector('#inspector:not(.hidden) .diagnosis', { timeout: 10_000 });
  assert(((await page.locator('#inspector .diagnosis').textContent()) ?? '').includes('경쟁 조건'), '살펴보기와 원인 진단이 파일 안에서 계산됨');
  assert((await page.locator('#inspector button.act:not([disabled])').count()) === 0, '행동 버튼은 모두 잠김');
  await page.evaluate(`window.__iso.send({ type: 'dryrun', entityId: ${JSON.stringify(target)}, affordanceId: 'x' })`);
  await page.waitForFunction(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('보기 전용'))`, null, { timeout: 5000 });
  assert(true, '시스템을 바꾸는 요청은 거절됨');

  // 가설 실험실도 브라우저 안에서
  await page.locator('#topbar button', { hasText: '가설 실험실' }).click();
  await page.waitForSelector('#lab:not(.hidden) .rules li', { timeout: 15_000 });
  assert(((await page.locator('#lab .rules').textContent()) ?? '').includes('stock'), '가설 실험실이 공유본의 기록으로 규칙을 배움');

  assert(network.length === 0, `네트워크 요청 없음${network.length ? `: ${network.slice(0, 3).join(', ')}` : ''}`);
  assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\n공유본 시험 통과 ✅');
} finally {
  await browser.close();
  await srv.close();
  await rt.stop();
  await shop.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
