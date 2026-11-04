import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresAdapter } from '@isomorph/adapters';
import { startShop } from '@isomorph/demo-shop';
import { IsomorphRuntime, serve } from '@isomorph/server';

/**
 * 종단 간 검증(E2E): 실제 브라우저로 킬러 데모 시나리오를 처음부터 끝까지 수행한다.
 *   1) 반짝 세일 → 경쟁 조건 → 유령 상자   2) 클릭 → 원인 진단
 *   3) 문 잠그기 드라이런 → 승인 → 실제 DB 반영 + 관측 검증   4) 되돌리기
 *   5) 범례 · 시간 여행 · 검증 보고서
 * 사용: npm run build && npm run e2e [-- --shots docs/screenshots]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shotsDir = (() => {
  const i = process.argv.indexOf('--shots');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
})();

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E 실패: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // playwright 는 선택 의존성(설치돼 있을 때만 E2E 실행)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    playwright = require('playwright');
  } catch {
    console.error('playwright 가 필요합니다: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
  const staticDir = path.join(root, 'packages/client/dist');
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) throw new Error('먼저 npm run build');

  const pgPort = 57000 + Math.floor(Math.random() * 900);
  const shop = await startShop({ httpPort: 0, pgPort, traffic: { firstFlashSaleMs: 3000, flashSaleEveryMs: 0, orderEveryMs: [500, 1200] } });
  const runtime = new IsomorphRuntime({ adapter: new PostgresAdapter({ connectionString: shop.pgUrl, system: 'demo-shop' }), writeMode: 'medium', pollMs: 400, numRuns: 100, compile: { mode: 'heuristic' } });
  assert((await runtime.start()) === 'running', '렌즈 검증 통과 후 세계가 열림');
  const srv = await serve(runtime, { port: 0, staticDir });
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir ? 2 : 1 });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  const shot = async (name: string) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  };
  type Iso = { state: any; town: any };
  const iso = () => (window as unknown as { __iso: Iso }).__iso;

  try {
    await page.goto(srv.url);
    await page.waitForFunction(`(${iso})()?.state?.world?.violations?.some((v) => v.invariantId === 'nonneg_products_stock')`, null, { timeout: 40_000 });
    assert(true, '반짝 세일의 경쟁 조건이 법칙 위반(유령 상자)으로 나타남');
    await page.waitForTimeout(1500);
    await shot('01-town');

    const target: string = await page.evaluate(`(() => { const s = (${iso})().state; const v = s.world.violations.find((x) => x.invariantId === 'nonneg_products_stock'); return s.world.entities.find((e) => e.source.collection === v.collection && String(e.source.pk) === String(v.pk)).id; })()`);
    await page.evaluate(`(${iso})().town.focus(${JSON.stringify(target)})`);
    await page.waitForTimeout(300);
    const pos = (await page.evaluate(`(${iso})().town.screenOf(${JSON.stringify(target)})`)) as { x: number; y: number };
    const stage = (await page.locator('#stage').boundingBox())!;
    await page.mouse.click(stage.x + pos.x, stage.y + pos.y + 20);
    await page.waitForSelector('#inspector:not(.hidden) .diagnosis', { timeout: 10_000 });
    const diag = await page.locator('#inspector .diagnosis strong').first().textContent();
    assert(diag?.includes('경쟁 조건'), `클릭한 창고(${target})의 원인 진단: ${diag}`);
    await page.waitForTimeout(500);
    await shot('02-inspector');

    await page.locator('#inspector button.act', { hasText: '문 잠그기' }).click();
    await page.waitForSelector('#modal-root .modal pre', { timeout: 10_000 });
    const sql = await page.locator('#modal-root .modal pre').textContent();
    assert(sql?.includes('SET "active" = false'), `드라이런 명령: ${sql?.trim()}`);
    const pk = Number(target.split(':')[1]);
    const before = (await shop.db.query<{ active: boolean }>('select active from products where id = $1', [pk])).rows[0].active;
    assert(before === true, '드라이런은 실제 시스템을 바꾸지 않음');
    await page.waitForTimeout(700);
    await shot('03-dryrun');

    await page.locator('#modal-root button', { hasText: '승인하고 실행' }).click();
    await page.waitForFunction(`document.querySelector('#actions .badge')?.textContent?.includes('확인')`, null, { timeout: 15_000 });
    const after = (await shop.db.query<{ active: boolean }>('select active from products where id = $1', [pk])).rows[0].active;
    assert(after === false, '승인 후 실제 DB 의 active=false, 다음 관측에서 반영 확인(PutGet)');
    const rejected = await shop.shop.placeOrder(1, pk);
    assert(rejected.status === 'rejected', '잠긴 창고로 온 주문은 거절됨');
    await page.waitForTimeout(800);
    await shot('04-verified');

    await page.locator('#actions button', { hasText: '되돌리기' }).first().click();
    await page.waitForFunction(`[...document.querySelectorAll('#actions .badge')].some((b) => b.textContent.includes('되돌림'))`, null, { timeout: 15_000 });
    const undone = (await shop.db.query<{ active: boolean }>('select active from products where id = $1', [pk])).rows[0].active;
    assert(undone === true, '되돌리기로 active=true 복구');

    await page.locator('#topbar button', { hasText: '범례' }).click();
    await page.waitForTimeout(400);
    await shot('05-legend');
    await page.locator('#topbar button', { hasText: '범례' }).click();

    const tl = (await page.locator('#timeline canvas').boundingBox())!;
    await page.mouse.click(tl.x + tl.width * 0.05, tl.y + tl.height / 2);
    await page.waitForSelector('#history-banner:not(.hidden)', { timeout: 10_000 });
    assert(true, '타임라인으로 과거 시점 이동(시간 여행)');
    await page.waitForTimeout(800);
    await shot('06-history');
    await page.locator('#timeline button.live').click();
    await page.waitForSelector('#history-banner.hidden', { state: 'attached', timeout: 10_000 });

    await page.locator('#topbar .chip.verify').click();
    await page.waitForSelector('#modal-root .modal h2', { timeout: 10_000 });
    assert((await page.locator('#modal-root .modal h2').textContent())?.includes('통과'), '검증 보고서: 렌즈 법칙 통과');
    await page.waitForTimeout(400);
    await shot('07-verification');
    assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    console.log('\nE2E 통과 ✅');
  } finally {
    await browser.close();
    await srv.close();
    await runtime.stop();
    await shop.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
