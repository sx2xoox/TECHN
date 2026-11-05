import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompositeAdapter, KubernetesAdapter, OtelAdapter } from '@isomorph/adapters';
import { IsomorphRuntime, serve } from '@isomorph/server';
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
const otel = new OtelAdapter({ port: 0 });
await otel.connect();
const healthy = await startTwoServices({ endpoint: otel.endpoint, failRate: 0.02 });
let failing: Awaited<ReturnType<typeof startTwoServices>> | null = null;
const traffic = setInterval(() => {
  void healthy.hit(2, 2);
  if (failing) void failing.hit(3, 3);
}, 400);
await healthy.hit(6);
const rt = new IsomorphRuntime({
  adapter: new CompositeAdapter({ parts: [{ name: 'k8s', adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }) }, { name: 'otel', adapter: otel }] }),
  writeMode: 'low',
  pollMs: 1000,
  numRuns: 40,
  compile: { mode: 'heuristic' },
});
await rt.start();
const srv = await serve(rt, { port: Number(arg('port') ?? 0), staticDir: path.join(root, 'packages/client/dist') });
console.log(`세계: ${srv.url}`);
const browser = await require('playwright').chromium.launch();
try {
  assert(rt.report?.ok, '클러스터와 서비스가 한 세계로 열리고 렌즈 검증 통과');
  const linkField = rt.schema!.collections.find((c) => c.name === 'k8s_deployments')!.fields.find((f) => f.ref?.crossSystem);
  assert(linkField?.ref?.collection === 'otel_services', '디플로이먼트 이름 ↔ service.name 이 자동으로 이어짐');

  await new Promise((r) => setTimeout(r, 1500));
  kube.setReady('shop/payments', 0); // 1) 파드가 준비를 잃는다
  for (let i = 0; i < 40 && !rt.world!.violations.some((v) => v.collection === 'k8s_deployments' && v.pk === 'shop/payments'); i++) await new Promise((r) => setTimeout(r, 250));
  assert(rt.world!.violations.some((v) => v.collection === 'k8s_deployments' && v.pk === 'shop/payments'), 'payments 디플로이먼트의 준비된 복제본 부족이 법칙 위반으로 보임');
  await new Promise((r) => setTimeout(r, 1200));
  failing = await startTwoServices({ endpoint: otel.endpoint, failRate: 1 }); // 2) 그 뒤 호출이 실패한다
  for (let i = 0; i < 60 && !rt.world!.violations.some((v) => v.collection === 'otel_services' && v.pk === 'payments'); i++) await new Promise((r) => setTimeout(r, 250));
  assert(rt.world!.violations.some((v) => v.collection === 'otel_services' && v.pk === 'payments'), 'payments 서비스의 실패가 법칙 위반으로 보임');

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
  assert(errors.length === 0, `브라우저 오류 없음${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('\n한 세계 시험 통과 ✅');
  if (keep) await new Promise(() => {});
} finally {
  clearInterval(traffic);
  await browser.close();
  await healthy.close();
  await failing?.close();
  await srv.close();
  await rt.stop();
  await kube.close();
}
process.exit(0);
