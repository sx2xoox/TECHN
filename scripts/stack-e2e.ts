import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompositeAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { attachNotifier, IsomorphRuntime, serve, type NotifyItem } from '@isomorph/server';
import { startFakeKube } from '../packages/adapters/test/fake-kube.ts';
import { startTwoServices } from '../examples/otel/two-services.ts';

/**
 * 한 세계에 클러스터와 서비스: 브라우저로 끝까지.
 *   npm run build && npx tsx scripts/stack-e2e.ts [--shots dir] [--keep]
 * 클러스터는 실제 응답 모양의 시험용 Kubernetes API, 서비스는 진짜 OpenTelemetry SDK 로 계측한 두 서비스(web → payments).
 * 줄거리: payments 파드가 준비를 잃음 → 뒤이어 payments 호출이 실패 → 실패한 서비스를 누르면 진단이 클러스터 쪽을 가리킨다.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const shotsDir = arg('shots') ? path.resolve(arg('shots')!) : null;
const keep = process.argv.includes('--keep');
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`한 세계 시험 실패: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const kube = await startFakeKube();
kube.addDeployment('payments', 'shop', 2);
// payments 가 실제로 부르는 뒷단: 클러스터의 payments 파드가 하나라도 준비돼 있어야 응답한다(실패를 꾸미지 않는다)
const backend = http.createServer((_req, res) => res.writeHead(kube.readyOf('shop/payments') > 0 ? 200 : 503).end());
await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()));
const otel = new OtelAdapter({ port: 0 });
await otel.connect();
const app = await startTwoServices({ endpoint: otel.endpoint, paymentsBackend: `http://127.0.0.1:${(backend.address() as { port: number }).port}/` });
const traffic = setInterval(() => void app.hit(3, 3), 400);
await app.hit(6);
const rt = new IsomorphRuntime({
  adapter: new CompositeAdapter({ parts: [{ name: 'k8s', adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }) }, { name: 'otel', adapter: otel }] }),
  writeMode: 'high',
  pollMs: 1000,
  numRuns: 40,
  compile: { mode: 'heuristic' },
});
const srv = await serve(rt, { port: Number(arg('port') ?? 0), staticDir: path.join(root, 'packages/client/dist') });
// 알림을 받는 쪽(Slack 대신 작은 웹훅)
const alerts: NotifyItem[] = [];
const hook = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    alerts.push(...(JSON.parse(b) as { items: NotifyItem[] }).items);
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
const notifier = attachNotifier(rt, { webhook: `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`, publicUrl: srv.url, batchMs: 200 });
await rt.start();
console.log(`세계: ${srv.url}`);
const browser = await require('playwright').chromium.launch();
try {
  assert(rt.report?.ok, '클러스터와 서비스가 한 세계로 열리고 렌즈 검증 통과');
  const linkField = rt.schema!.collections.find((c) => c.name === 'k8s_deployments')!.fields.find((f) => f.ref?.crossSystem);
  assert(linkField?.ref?.collection === 'otel_services', '디플로이먼트 이름 ↔ service.name 이 자동으로 이어짐');

  await new Promise((r) => setTimeout(r, 1500));
  // 1) 누군가 payments 에 나쁜 이미지를 배포한다 → 파드가 준비를 잃는다 → 2) 그래서 호출이 실제로 실패한다
  kube.deployImage('shop/payments', 'registry.example/app:2.0-broken');
  const has = (c: string, pk: string) => rt.world!.violations.some((v) => v.collection === c && v.pk === pk);
  for (let i = 0; i < 40 && !has('k8s_deployments', 'shop/payments'); i++) await new Promise((r) => setTimeout(r, 250));
  assert(has('k8s_deployments', 'shop/payments'), '나쁜 이미지 배포 뒤 payments 디플로이먼트의 준비된 복제본 부족이 법칙 위반으로 보임');
  for (let i = 0; i < 80 && !(has('otel_services', 'payments') && has('otel_services', 'web')); i++) await new Promise((r) => setTimeout(r, 250));
  assert(has('otel_services', 'payments') && has('otel_services', 'web'), '그 결과 payments 와 그것을 부르는 web 이 실제로 실패함');

  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir ? 2 : 1 });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(srv.url);
  await page.waitForFunction('window.__iso?.state?.world?.entities?.length > 0', null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: path.join(shotsDir, '23-stack.png') });
  }
  const id = 'otel_services:payments';
  await page.evaluate(`window.__iso.town.focus(${JSON.stringify(id)})`);
  await page.waitForTimeout(300);
  const pos = (await page.evaluate(`window.__iso.town.screenOf(${JSON.stringify(id)})`)) as { x: number; y: number };
  const stage = (await page.locator('#stage').boundingBox())!;
  await page.mouse.click(stage.x + pos.x, stage.y + pos.y + 20);
  await page.waitForSelector('#inspector:not(.hidden) .diagnosis', { timeout: 10_000 });
  const diag = (await page.locator('#inspector .diagnosis').textContent()) ?? '';
  if (!diag.includes('다른 시스템')) {
    const ins = rt.inspect('otel_services:payments');
    console.log(JSON.stringify({ diag, d: ins.diagnosis, causes: ins.causes.map((c) => [c.ts, c.relation, c.collection, c.pk, c.summary, c.broke]) }, null, 1).slice(0, 4000));
  }
  assert(diag.includes('다른 시스템의 연결된 곳이 먼저 법칙을 어김') && diag.includes('shop/payments'), '실패한 서비스를 누르면 진단이 클러스터의 payments 디플로이먼트를 가리킴');
  await page.waitForSelector('#inspector .related li.cross.sick', { timeout: 10_000 });
  assert(((await page.locator('#inspector .related li.cross.sick').first().textContent()) ?? '').includes('준비된 복제본'), "'연결된 곳' 에 다른 시스템의 위반이 보임");
  // 연결된 곳을 누르면 그쪽(클러스터의 관리소)을 살펴본다
  await page.waitForTimeout(800);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '24-stack-inspect.png') });
  await page.locator('#inspector .related li.cross button.link').first().click();
  await page.waitForFunction(`window.__iso.state.selected === 'k8s_deployments:shop/payments'`, null, { timeout: 5000 });
  await page.waitForSelector('#inspector .related li.cross', { timeout: 10_000 });
  assert(true, "연결된 곳을 누르면 상대 시스템의 개체로 건너감");
  const dep = rt.inspect('k8s_deployments:shop/payments').diagnosis;
  assert(dep?.pattern !== 'linked', '반대 방향(나중에 실패한 서비스)은 원인으로 삼지 않음');

  // 근본 원인 사슬: web 을 누르면 web ← payments(오류가 시작된 곳) ← 클러스터의 payments(먼저 법칙을 어김)
  await page.evaluate(`window.__iso.town.focus('otel_services:web')`);
  await page.waitForTimeout(300);
  const wpos = (await page.evaluate(`window.__iso.town.screenOf('otel_services:web')`)) as { x: number; y: number };
  await page.mouse.click(stage.x + wpos.x, stage.y + wpos.y + 20);
  await page.waitForFunction(`window.__iso.state.selected === 'otel_services:web'`, null, { timeout: 5000 });
  await page.waitForSelector('#inspector .chain li.root', { timeout: 10_000 });
  const chainText = (await page.locator('#inspector .chain').textContent()) ?? '';
  assert(chainText.includes('오류가 시작된 곳') && chainText.includes('payments') && chainText.includes('먼저 법칙을 어김') && chainText.includes('근본 원인'), '실패한 web 을 누르면 근본 원인 사슬이 클러스터의 payments 디플로이먼트까지 이어짐');
  assert(((await page.locator('#inspector .chain li.root').textContent()) ?? '').includes('다른 시스템'), '사슬의 끝(근본 원인)은 다른 시스템');
  await page.waitForTimeout(900);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '26-root-chain.png') });

  // 알림: 서비스가 실패하자 웹훅으로 진단과 링크가 왔다 → 링크를 열면 그 개체·그 시점
  await notifier.flush();
  const alert = alerts.find((a) => a.phase === 'start' && a.entityId === 'otel_services:payments');
  assert(alert?.link && alert.diagnosis?.pattern === 'linked', `알림이 진단(다른 시스템 원인)과 링크를 싣고 옴 (${alerts.length}건)`);
  const webAlert = alerts.find((a) => a.phase === 'start' && a.entityId === 'otel_services:web');
  assert(webAlert?.root?.collection === 'k8s_deployments' && webAlert.root.pk === 'shop/payments' && webAlert.root.hops === 2, 'web 의 알림에는 근본 원인(2단계 위, 클러스터의 payments)이 실림');
  assert(webAlert?.change?.[0]?.field === 'image' && webAlert.change[0].now === 'registry.example/app:2.0-broken', "알림에 근본 원인의 '직전 변경'(나쁜 이미지)도 실림");
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: shotsDir ? 2 : 1 });
  page2.on('pageerror', (e: Error) => errors.push(e.message));
  await page2.goto(alert.link);
  await page2.waitForFunction(`window.__iso?.state?.selected === 'otel_services:payments'`, null, { timeout: 30_000 });
  await page2.waitForSelector('#history-banner:not(.hidden)', { timeout: 10_000 });
  await page2.waitForSelector('#inspector:not(.hidden) .diagnosis', { timeout: 10_000 });
  assert(((await page2.locator('#inspector .diagnosis').textContent()) ?? '').includes('다른 시스템'), '알림 링크를 열면 위반이 시작된 시점으로 되감기고 그 개체의 진단이 열림');
  assert((await page2.evaluate('window.__iso.state.seekTs')) === alert.at, '되감은 시점 = 위반이 시작된 시각');
  await page2.waitForTimeout(800);
  if (shotsDir) await page2.screenshot({ path: path.join(shotsDir, '25-alert-link.png') });
  // '링크' 버튼은 지금 보고 있는 개체·시점으로 오는 같은 링크를 만든다
  await page2.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page2.locator('#inspector .copy-link').click();
  const copied = String(await page2.evaluate('navigator.clipboard.readText()'));
  assert(copied.includes('focus=otel_services%3Apayments') && copied.includes(`at=${alert.at}`), "'링크' 버튼이 같은 개체·시점의 링크를 복사");
  // 근본 원인에서 바로 고치기: web 의 사슬 끝(클러스터의 payments)으로 가서 '직전 변경 되돌리기'
  await page.bringToFront();
  await page.evaluate(`window.__iso.town.focus('otel_services:web')`);
  await page.locator('#inspector .chain li.root button.link').click();
  await page.waitForFunction(`window.__iso.state.selected === 'k8s_deployments:shop/payments'`, null, { timeout: 5000 });
  await page.waitForSelector('#inspector .revert', { timeout: 10_000 });
  assert(((await page.locator('#inspector .revert').textContent()) ?? '').includes('registry.example/app:2.0-broken'), "근본 원인의 살펴보기에 '위반 직전의 변경'(나쁜 이미지)이 보임");
  await page.waitForTimeout(500);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '27-revert.png') });
  await page.locator('#inspector .revert button').click();
  await page.waitForSelector('#modal-root .modal pre', { timeout: 10_000 });
  const cmd = (await page.locator('#modal-root .modal pre').textContent()) ?? '';
  assert(cmd.includes(`kubectl set image deployment/payments -n shop app=${kube.goodImage}`), `드라이런이 실제로 실행할 명령을 보여 줌: ${cmd.trim()}`);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, '28-revert-dryrun.png') });
  await page.locator('#modal-root button', { hasText: '승인하고 실행' }).click();
  for (let i = 0; i < 40 && kube.imageOf('shop/payments') !== kube.goodImage; i++) await new Promise((r) => setTimeout(r, 100));
  assert(kube.imageOf('shop/payments') === kube.goodImage, '승인하자 클러스터의 이미지가 원래대로 돌아감');
  for (let i = 0; i < 40 && has('k8s_deployments', 'shop/payments'); i++) await new Promise((r) => setTimeout(r, 250));
  assert(!has('k8s_deployments', 'shop/payments'), '파드가 다시 준비되어 디플로이먼트가 회복');
  for (let i = 0; i < 40 && rt.getActions()[0]?.status !== 'verified'; i++) await new Promise((r) => setTimeout(r, 250));
  assert(rt.getActions()[0]?.status === 'verified', '실행한 변경을 다음 관측에서 확인(verified)');
  // 서비스는 오류 비율이 1분 창에서 내려가야 회복한다: 호출이 다시 성공하는지 본다
  const after = await app.hit(6);
  assert(after.failed === 0, `되돌린 뒤 payments·web 호출이 다시 성공(실패 ${after.failed}/6)`);
  await notifier.flush();
  assert(alerts.some((a) => a.phase === 'end' && a.entityId === 'k8s_deployments:shop/payments'), "알림으로 근본 원인의 '복구' 가 감");
  assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\n한 세계 시험 통과 ✅');
  if (keep) await new Promise(() => {});
} finally {
  clearInterval(traffic);
  await notifier.stop();
  hook.close();
  backend.close();
  await browser.close();
  await app.close();
  await srv.close();
  await rt.stop();
  await kube.close();
}
process.exit(0);
