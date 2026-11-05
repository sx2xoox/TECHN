import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startShop } from '@isomorph/demo-shop';
import { configFromTarget } from '../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('isomorph connect', () => {
  it('turns a single target into a safe, read-only, local config', () => {
    expect(configFromTarget(['postgres://u@db:5432/shop'], { schema: 'sales' })).toMatchObject({ adapter: { type: 'postgres', system: 'shop', schema: 'sales' }, writeMode: 'read-only', host: '127.0.0.1' });
    expect(configFromTarget(['https://api.example.com/v1/orders?limit=50', 'https://api.example.com/v1/products']).adapter).toMatchObject({ type: 'http', baseUrl: 'https://api.example.com', collections: [{ name: 'orders', path: '/v1/orders?limit=50' }, { name: 'products', path: '/v1/products' }] });
    expect(configFromTarget(['otel']).adapter).toMatchObject({ type: 'otel', port: 4318 });
    expect(configFromTarget(['k8s']).adapter).toEqual({ type: 'kubernetes' });
    expect(configFromTarget(['kubernetes'], { schema: 'shop', context: 'kind-isomorph' }).adapter).toEqual({ type: 'kubernetes', namespace: 'shop', context: 'kind-isomorph' });
    expect(() => configFromTarget(['https://a.example.com/x', 'https://b.example.com/y'])).toThrow(/같은 호스트/);
    expect(() => configFromTarget(['ftp://x'])).toThrow(/알 수 없는 대상/);
  });

  it('opens a verified world from one command against a real PostgreSQL wire endpoint', async () => {
    const shop = await startShop({ httpPort: 0, pgPort: 58500 + Math.floor(Math.random() * 300), traffic: { orderEveryMs: [400, 800], firstFlashSaleMs: 0, flashSaleEveryMs: 0 } });
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'packages/server/src/cli.ts'), 'connect', shop.pgUrl, '--port', '0'], { cwd: root, env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`시간 초과: ${out}`)), 40_000);
        child.stdout.on('data', (d) => {
          out += String(d);
          const m = /ISOMORPH 세계: (http:\/\/[^\s]+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on('exit', (code) => reject(new Error(`종료(${code}): ${out}`)));
      });
      let hello: { status?: string; writeMode?: string; verification?: { ok: boolean } } = {};
      for (let i = 0; i < 40 && hello.status !== 'running'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        hello = (await (await fetch(`${url}/api/hello`)).json()) as typeof hello;
      }
      expect(hello.status).toBe('running');
      expect(hello.writeMode).toBe('read-only');
      expect(hello.verification?.ok).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await shop.stop();
    }
  }, 60_000);
});
