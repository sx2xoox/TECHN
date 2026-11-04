import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OtelAdapter } from '@isomorph/adapters';
import { IsomorphRuntime, serve } from '@isomorph/server';
import { startTwoServices } from '../examples/otel/two-services.ts';

/**
 * OpenTelemetry 데모: 진짜 OTel SDK 로 계측한 서비스 두 개(web → payments)의 트레이스를 세계로.
 *   npm run build && npm run demo:otel
 * 세계: http://127.0.0.1:4000 · OTLP 수신: http://127.0.0.1:4318/v1/traces (다른 앱도 여기로 보낼 수 있다)
 * 스크린숏만: npm run demo:otel -- --shots docs/screenshots
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = (() => {
  const i = process.argv.indexOf('--shots');
  return i >= 0 ? path.resolve(process.argv[i + 1]) : null;
})();
const adapter = new OtelAdapter({ port: shots ? 0 : Number(process.env.OTLP_PORT ?? 4318), system: 'otel-demo' });
await adapter.connect();
const app = await startTwoServices({ endpoint: adapter.endpoint, failRate: Number(process.env.FAIL_RATE ?? 0.25) });
await app.hit(6);
const rt = new IsomorphRuntime({ adapter, pollMs: 2000, numRuns: 60, compile: { mode: 'heuristic' }, log: (m) => console.log(m) });
console.log(`렌즈 검증: ${await rt.start()}`);
const srv = await serve(rt, { port: shots ? 0 : Number(process.env.PORT ?? 4000), staticDir: path.join(root, 'packages/client/dist') });
console.log(`세계: ${srv.url}\nOTLP 수신(JSON): ${adapter.endpoint}`);
const traffic = setInterval(() => void app.hit(2, 2), 600);

if (shots) {
  const require = createRequire(import.meta.url);
  const browser = await require('playwright').chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await page.goto(srv.url);
  await page.waitForFunction('window.__iso?.state?.world?.entities?.some((e) => e.source.collection === "spans")', null, { timeout: 20_000 });
  await page.waitForTimeout(5000);
  await page.evaluate(`(() => { const s = window.__iso.state; const e = s.world.entities.find((e) => e.source.collection === 'services' && e.source.pk === 'payments'); if (e) window.__iso.town.focus(e.id); })()`);
  await page.waitForTimeout(1500);
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, '17-otel.png') });
  await browser.close();
  clearInterval(traffic);
  await app.close();
  await srv.close();
  await rt.stop();
  process.exit(0);
}
