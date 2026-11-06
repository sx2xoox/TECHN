import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudy, readStudyRecords, startStudyServer, studyReportMarkdown } from '@isomorph/server';

/**
 * '근본 원인 찾기' 과제의 자가 시험(하네스 시험). 실험 결과가 아니다.
 *  - 봇 참가자 2명이 세 조건(세계 · 표 · 표+위반 강조)을 실제 화면으로 끝까지 진행한다.
 *  - 세계·표+위반 강조: 실패한 frontend 를 눌러 살펴보기를 열고, 엔진이 계산한 근본 원인 사슬의 끝을 눌러 고른다
 *    (사람이 쓰는 그 버튼으로). 세계에서는 frontend 건물을 캔버스 위에서 실제로 누른다.
 *  - 표: 오른쪽 변경 기록에서 근본 원인의 줄을 눌러 고른다(기록 → 표의 행 선택).
 *  - 일부러 증상(frontend)을 근본 원인으로 고른 답 1개로 채점 경로를 확인한다.
 *  - 봇은 조건마다 똑같이 빠르다 → 분석 수치는 의미가 없다.
 * 사용: npm run build && npm run study:selftest:rca [-- --shots dir]
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'isomorph-study-rca-'));
const conditions = ['world', 'table', 'table+alerts'] as const;
const srv = await startStudyServer({ port: 0, staticDir: path.join(root, 'packages/client/dist'), dataDir, task: 'rca', conditions: [...conditions], practicePerCondition: 1, timeLimitMs: 60_000, exposeAnswers: true });
const browser = await playwright.chromium.launch();
type Trial = { key: number; condition: string; practice: boolean; index: number; symptom: string; world: { entities: { id: string; source: { collection: string; pk: unknown }; archetype: string }[] } | null; oracle: { target: string; anomaly: string } };
const errors: string[] = [];
const usedChain: string[] = [];

try {
  for (let p = 0; p < 2; p++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir && p === 0 ? 2 : 1 });
    page.on('pageerror', (e: Error) => errors.push(e.message));
    const phase = () => page.evaluate('window.__study?.phase') as Promise<string>;
    // 서버가 바로 답하는지 먼저 본다(CI 에서 한 번 페이지 'load' 를 30초 넘게 기다린 적이 있다: 다시 나면 어느 쪽이 느린지 남긴다)
    const t0 = Date.now();
    const probe = await fetch(srv.url).then((r) => r.status).catch((e) => String(e));
    if (Date.now() - t0 > 2000 || probe !== 200) console.log(`  (진단) 실험 서버 응답 ${probe}, ${Date.now() - t0}ms`);
    // 'load'(모든 하위 자원)가 아니라 화면이 실제로 준비된 것(동의 단계)을 기다린다
    await page.goto(srv.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction("window.__study?.phase === 'consent'", null, { timeout: 60_000 });
    assert((await page.locator('.study-screen').textContent())?.includes('근본 원인'), `봇 ${p}: 동의 화면이 근본 원인 과제를 설명함`);
    await page.getByRole('button', { name: '동의하고 시작' }).click();
    await page.waitForFunction("window.__study.phase === 'background'");
    await page.locator('select').first().selectOption('none');
    await page.getByRole('button', { name: '다음' }).click();
    const shot = new Set<string>();
    for (let guard = 0; guard < 80; guard++) {
      await page.waitForFunction("window.__study?.phase && window.__study.phase !== 'background'", null, { timeout: 20_000 });
      const ph = await phase();
      if (ph === 'done') break;
      if (ph === 'error') throw new Error(`화면 오류: ${await page.locator('.study-screen').textContent()}`);
      const keyBefore = (await page.evaluate('window.__study.trial?.key ?? -1')) as number;
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
        const t = (await page.evaluate('window.__study.trial')) as Trial;
        const { target, anomaly } = t.oracle;
        await page.waitForTimeout(250);
        const logCount = await page.locator('.log-item').count();
        if (logCount < 10) throw new Error(`변경 기록이 비어 있음(${t.condition})`);
        const hasInsight = (await page.locator('.insight').count()) > 0;
        if (hasInsight !== (t.condition !== 'table')) throw new Error(`살펴보기 유무가 조건과 다름: ${t.condition}`);
        const wrong = !t.practice && t.index === 1 && p === 0;
        if (wrong) {
          // 일부러 증상(실패한 고객 화면)을 근본 원인으로 고른다
          await page.evaluate(`window.__study.select(${JSON.stringify(t.symptom)})`);
        } else if (t.condition === 'table') {
          // 표: 변경 기록에서 근본 원인의 줄을 눌러 고른다
          await page.locator(`.log-item[data-key="${target}"]:not(.gone)`).first().click();
        } else {
          // 살펴보기: 실패한 frontend 를 고르고, 엔진이 계산한 근본 원인 사슬의 끝을 누른다
          if (t.condition === 'world') {
            const e = t.world!.entities.find((x) => `${x.source.collection}:${x.source.pk}` === t.symptom)!;
            await page.evaluate(`window.__study.town.focus(${JSON.stringify(e.id)})`);
            await page.waitForTimeout(300);
            const pos = (await page.evaluate(`window.__study.town.screenOf(${JSON.stringify(e.id)})`)) as { x: number; y: number } | null;
            const box = (await page.locator('#stage').boundingBox())!;
            if (pos) await page.mouse.click(box.x + pos.x, box.y + pos.y + 20);
            await page.waitForTimeout(150);
            if (!(await page.locator('.picked').textContent())?.includes('frontend')) await page.evaluate(`window.__study.select(${JSON.stringify(t.symptom)})`);
          } else {
            await page.locator(`tr[data-key="${t.symptom}"]`).first().click();
          }
          await page.waitForFunction("document.querySelector('.insight-body')?.textContent.includes('근본 원인 사슬')", null, { timeout: 5000 });
          if (shotsDir && p === 0 && !t.practice && !shot.has(t.condition)) {
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(shotsDir, `study-rca-${t.condition === 'world' ? 'world' : 'alerts'}.png`) });
            shot.add(t.condition);
          }
          await page.locator('.insight-body .chain li button').last().click();
          usedChain.push(t.condition);
        }
        await page.waitForTimeout(100);
        const picked = await page.locator('.picked').textContent();
        const expectKey = wrong ? t.symptom : target;
        const pk = expectKey.slice(expectKey.indexOf(':') + 1);
        if (!picked?.includes(pk)) throw new Error(`선택이 화면에 반영되지 않음: ${picked} (기대 ${expectKey}, ${t.condition})`);
        if (shotsDir && p === 0 && !t.practice && t.condition === 'table' && !shot.has('table')) {
          await page.screenshot({ path: path.join(shotsDir, 'study-rca-table.png') });
          shot.add('table');
        }
        await page.evaluate(`window.__study.choose(${JSON.stringify(anomaly)})`);
        await page.evaluate('window.__study.submit()');
      }
      await page.waitForFunction(`window.__study.phase !== ${JSON.stringify(ph)} || (window.__study.trial?.key ?? -1) !== ${keyBefore}`, null, { timeout: 20_000 });
    }
    assert((await phase()) === 'done', `봇 참가자 ${p} 가 끝까지 진행`);
    await page.close();
  }

  const records = readStudyRecords(dataDir);
  const trials = records.filter((r) => r.type === 'trial') as unknown as { participant: number; practice: boolean; condition: string; anomaly: string; index: number; locateCorrect: boolean; diagnoseCorrect: boolean; task?: string }[];
  assert(trials.length === 2 * 3 * 4, `과제 기록 ${trials.length}개(참가자당 조건 3 × (연습 1 + 본 과제 3))`);
  assert(trials.every((t) => t.task === 'rca'), '모든 기록에 과제 종류(rca)가 남음');
  const main = trials.filter((t) => !t.practice);
  for (const c of conditions) assert(new Set(main.filter((t) => t.participant === 0 && t.condition === c).map((t) => t.anomaly)).size === 3, `참가자 0 이 ${c} 에서 원인 3종을 한 번씩 봄`);
  const wrong = main.filter((t) => t.participant === 0 && t.index === 1);
  assert(wrong.length === 1 && !wrong[0].locateCorrect, '증상(frontend)을 근본 원인으로 고른 답은 오답으로 채점됨');
  assert(main.filter((t) => !(t.participant === 0 && t.index === 1)).every((t) => t.locateCorrect && t.diagnoseCorrect), '나머지 답(사슬·변경 기록·캔버스로 고른 것)은 모두 정답으로 채점됨');
  assert(usedChain.includes('world') && usedChain.includes('table+alerts'), '세계와 표+위반 강조에서 살펴보기의 근본 원인 사슬로 골랐음');
  const report = analyzeStudy(records, { task: 'rca' });
  assert(report.participants === 2 && report.conditions.length === 3, '근본 원인 과제로 분석이 돌아감(세 조건)');
  assert(analyzeStudy(records).participants === 0, '위반 찾기 분석에는 섞이지 않음');
  console.log('\n' + studyReportMarkdown(report, '하네스 자가 시험(근본 원인 찾기) — 실험 결과가 아님(봇이 조건마다 똑같이 행동)'));
  assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\n근본 원인 찾기 자가 시험 통과 ✅ (이 수치는 실험 결과가 아닙니다)');
} finally {
  await browser.close();
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
