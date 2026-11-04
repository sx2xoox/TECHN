import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudy, readStudyRecords, startStudyServer, studyReportMarkdown } from '@isomorph/server';

/**
 * 실험 도구의 자가 시험(하네스 시험). 실험 결과가 아니다.
 *  - 봇 참가자 3명이 실제 화면을 끝까지 진행한다(동의 → 배경 → 안내 → 연습 → 본 과제 → 설문).
 *  - 표 조건에서는 진짜 행을, 세계 조건에서는 캔버스 위 건물을 실제로 눌러 고른다.
 *  - 봇은 두 조건에서 똑같이 행동한다(시간 차이를 만들지 않는다) → 분석 수치는 의미가 없다.
 *  - 일부러 틀린 답 1개, 넘어가기 1개를 섞어 채점 경로를 확인한다.
 * 사용: npm run build && npm run study:selftest [-- --shots dir]
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shotsDir = (() => {
  const i = process.argv.indexOf('--shots');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
})();
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`자가 시험 실패: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const playwright: any = require('playwright');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isomorph-study-'));
const srv = await startStudyServer({ port: 0, staticDir: path.join(root, 'packages/client/dist'), dataDir, conditions: ['world', 'table'], perCondition: 5, practicePerCondition: 1, timeLimitMs: 30_000, exposeAnswers: true });
const browser = await playwright.chromium.launch();
type Hook = { phase: string; trial: { condition: string; practice: boolean; index: number; world: { entities: { id: string; source: { collection: string; pk: unknown }; archetype: string }[] }; oracle: { target: string | null; anomaly: string } } | null };
const errors: string[] = [];

try {
  for (let p = 0; p < 3; p++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir && p === 0 ? 2 : 1 });
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const phase = () => page.evaluate('window.__study?.phase') as Promise<string>;
    const waitPhase = async (not: string) => page.waitForFunction(`window.__study && window.__study.phase !== ${JSON.stringify(not)}`, null, { timeout: 20_000 });
    await page.goto(p === 2 ? `${srv.url}?pilot=1` : srv.url); // 세 번째 봇은 예비(파일럿) 참가자
    await page.waitForFunction("window.__study?.phase === 'consent'");
    await page.getByRole('button', { name: '동의하고 시작' }).click();
    await waitPhase('consent');
    await page.locator('select').first().selectOption('none');
    await page.getByRole('button', { name: '다음' }).click();
    let shotWorld = false;
    let shotTable = false;
    for (let guard = 0; guard < 80; guard++) {
      await page.waitForFunction("window.__study?.phase && !['background'].includes(window.__study.phase)", null, { timeout: 20_000 });
      const ph = await phase();
      if (ph === 'done') break;
      if (ph === 'error') throw new Error(`화면 오류: ${await page.locator('.study-screen').textContent()}`);
      const keyBefore = (await page.evaluate('window.__study.trial?.key ?? -1')) as number;
      if (process.env.DEBUG) console.log(`    [p${p}] ${ph} key=${keyBefore}`);
      if (ph.startsWith('intro:')) {
        await page.getByRole('button', { name: '연습 과제 시작' }).click();
      } else if (ph === 'feedback') {
        await page.getByRole('button', { name: '본 과제 시작' }).click();
      } else if (ph.startsWith('questionnaire:')) {
        await page.locator('input[name="effort"][value="4"]').check();
        await page.locator('input[name="confidence"][value="5"]').check();
        await page.getByRole('button', { name: '다음' }).click();
      } else if (ph === 'final') {
        await page.locator('select').first().selectOption('same');
        await page.getByRole('button', { name: '마치기' }).click();
      } else if (ph === 'practice' || ph === 'trial') {
        const t = (await page.evaluate('window.__study.trial')) as Hook['trial'];
        const { target, anomaly } = t!.oracle;
        await page.waitForTimeout(250);
        if (!t!.practice && t!.index === 2 && p === 0) {
          // 일부러 넘어가기
          await page.getByRole('button', { name: '모르겠어요(넘어가기)' }).click();
        } else {
          if (target) {
            if (t!.condition === 'table') {
              await page.locator(`tr[data-key="${target}"]`).first().click();
            } else {
              const e = t!.world.entities.find((x) => `${x.source.collection}:${x.source.pk}` === target)!;
              const pos = e.archetype === 'building' ? ((await page.evaluate(`(() => { const t = window.__study.town; t.focus(${JSON.stringify(e.id)}); return null; })()`), await page.waitForTimeout(300), await page.evaluate(`window.__study.town.screenOf(${JSON.stringify(e.id)})`)) as { x: number; y: number } | null) : null;
              if (pos) {
                const box = (await page.locator('#stage').boundingBox())!;
                await page.mouse.click(box.x + pos.x, box.y + pos.y + 20);
                await page.waitForTimeout(150);
              }
              const picked = await page.locator('.picked').textContent();
              // 걷는 주민(주문)은 움직여서 봇이 좌표로 누르기 어렵다 → 훅으로 고른다(사람은 직접 누른다)
              if (!picked?.includes(target.replace(':', ' #'))) await page.evaluate(`window.__study.select(${JSON.stringify(target)})`);
            }
          }
          const wrong = !t!.practice && t!.index === 1 && p === 0;
          await page.evaluate(`window.__study.choose(${JSON.stringify(wrong ? (anomaly === 'negative_stock' ? 'orphan_order' : 'negative_stock') : target ? anomaly : 'none')})`);
          if (shotsDir && p === 0 && !t!.practice && target && t!.condition === 'world' && !shotWorld) {
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(shotsDir, 'study-world.png') });
            shotWorld = true;
          }
          if (shotsDir && p === 0 && !t!.practice && target && t!.condition === 'table' && !shotTable) {
            await page.screenshot({ path: path.join(shotsDir, 'study-table.png') });
            shotTable = true;
          }
          await page.evaluate('window.__study.submit()');
        }
      }
      await page.waitForFunction(`window.__study.phase !== ${JSON.stringify(ph)} || (window.__study.trial?.key ?? -1) !== ${keyBefore}`, null, { timeout: 20_000 });
    }
    assert((await phase()) === 'done', `봇 참가자 ${p} 가 끝까지 진행`);
    await page.close();
  }

  const records = readStudyRecords(dataDir);
  const trials = records.filter((r) => r.type === 'trial');
  assert(fs.readdirSync(dataDir).filter((f) => f.endsWith('.jsonl')).length === 3, '참가자마다 기록 파일 1개');
  assert(trials.length === 3 * 12, `과제 기록 ${trials.length}개(참가자당 연습 2 + 본 과제 10)`);
  const main = trials.filter((t) => !t.practice);
  const byCond = (c: string) => main.filter((t) => t.condition === c);
  assert(byCond('world').length === 15 && byCond('table').length === 15, '조건마다 같은 수의 본 과제');
  const kinds = (c: string) => new Set(byCond(c).filter((t) => t.participant === 0).map((t) => t.anomaly));
  assert(kinds('world').size === 5 && kinds('table').size === 5, '한 참가자가 조건마다 위반 4종 + 없음을 한 번씩 봄');
  const p0 = main.filter((t) => t.participant === 0);
  assert(p0.some((t) => t.gaveUp), '넘어가기가 기록됨');
  assert(p0.some((t) => !t.gaveUp && !t.diagnoseCorrect), '일부러 틀린 답이 오답으로 채점됨');
  assert(main.filter((t) => !t.gaveUp && !(t.participant === 0 && (t as { index?: number }).index === 1)).every((t) => t.locateCorrect && t.diagnoseCorrect), '나머지 답은 모두 정답으로 채점됨(세계에서 건물을 실제로 눌러 고른 경우 포함)');
  const order = (pp: number) => main.filter((t) => t.participant === pp).map((t) => t.condition)[0];
  assert(order(0) !== order(1), '참가자마다 조건 순서가 번갈아 바뀜');
  const report = analyzeStudy(records);
  assert(report.participants === 2 && report.warnings.some((w) => w.includes('부족')), '분석이 돌아가고(예비 참가자는 빠짐), 표본이 작다는 경고를 냄');
  const adminPage = await browser.newPage();
  await adminPage.goto(srv.adminUrl);
  await adminPage.waitForFunction("document.querySelectorAll('#t tbody tr').length === 3 && document.getElementById('r').textContent.includes('참가자')", null, { timeout: 10_000 });
  assert((await adminPage.locator('#t tbody').textContent())?.includes('(예비)'), '진행자 화면에 참가자 3명과 예비 표시가 보임');
  if (shotsDir) await adminPage.screenshot({ path: path.join(shotsDir, 'study-admin.png') });
  await adminPage.close();
  console.log('\n' + studyReportMarkdown(report, '하네스 자가 시험 — 실험 결과가 아님(봇이 두 조건에서 똑같이 행동)'));
  assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\n실험 도구 자가 시험 통과 ✅ (이 수치는 실험 결과가 아닙니다)');
} finally {
  await browser.close();
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
