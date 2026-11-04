import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 원클릭 데모: 버그 있는 쇼핑몰(:4100 HTTP, :5433 Postgres) + ISOMORPH 세계(:4000)
 *   npm run demo
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const children: ReturnType<typeof spawn>[] = [];

function run(name: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(tsx, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`${name} │ ${l}`));
  p.stdout.on('data', prefix);
  p.stderr.on('data', (d) => d.toString().includes('ExperimentalWarning') || d.toString().includes('trace-warnings') ? null : prefix(d));
  p.on('exit', (code) => {
    console.log(`${name} │ 종료 (${code})`);
    shutdown();
  });
  children.push(p);
  return p;
}

function shutdown() {
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (!fs.existsSync(path.join(root, 'packages/client/dist/index.html'))) {
  console.log('클라이언트가 아직 빌드되지 않았습니다. 먼저 `npm run build` 를 실행하세요.');
  process.exit(1);
}
fs.rmSync(path.join(root, '.data'), { recursive: true, force: true });

run('shop', ['apps/demo-shop/src/main.ts']);
// 쇼핑몰이 응답할 때까지 기다린 뒤 세계를 연다
const shopUrl = `http://127.0.0.1:${process.env.SHOP_HTTP_PORT ?? 4100}/api/products`;
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(shopUrl)).ok) break;
  } catch {
    /* 아직 */
  }
  await new Promise((r) => setTimeout(r, 500));
}
run('world', ['packages/server/src/cli.ts', 'serve', '--config', 'isomorph.config.json'], { NODE_NO_WARNINGS: '1' });
console.log('\n  ▶ 브라우저에서 http://127.0.0.1:4000 을 여세요\n');
