import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startShop } from '@isomorph/demo-shop';
import { configFromTarget, loadConfig } from '../src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('isomorph connect', () => {
  it('turns a single target into a safe, read-only, local config', () => {
    expect(configFromTarget(['postgres://u@db:5432/shop'], { schema: 'sales' })).toMatchObject({ adapter: { type: 'postgres', system: 'shop', schema: 'sales' }, writeMode: 'read-only', host: '127.0.0.1' });
    expect(configFromTarget(['https://api.example.com/v1/orders?limit=50', 'https://api.example.com/v1/products']).adapter).toMatchObject({ type: 'http', baseUrl: 'https://api.example.com', collections: [{ name: 'orders', path: '/v1/orders?limit=50' }, { name: 'products', path: '/v1/products' }] });
    expect(configFromTarget(['otel']).adapter).toMatchObject({ type: 'otel', port: 4318 });
    expect(configFromTarget(['k8s']).adapter).toEqual({ type: 'kubernetes' });
    expect(configFromTarget(['kubernetes'], { schema: 'shop', context: 'kind-isomorph' }).adapter).toEqual({ type: 'kubernetes', namespace: 'shop', context: 'kind-isomorph' });
    // 종류가 다른 대상 여럿 → 한 세계(시스템마다 짧은 이름)
    expect(configFromTarget(['postgres://u@db:5432/shop', 'otel', 'k8s'], { namespace: 'shop' }).adapter).toMatchObject({
      type: 'composite',
      parts: [
        { name: 'db', adapter: { type: 'postgres', system: 'shop' } },
        { name: 'otel', adapter: { type: 'otel' } },
        { name: 'k8s', adapter: { type: 'kubernetes', namespace: 'shop' } },
      ],
    });
    expect(configFromTarget(['https://a.example.com/x', 'https://b.example.com/y', 'https://a.example.com/z']).adapter).toMatchObject({
      type: 'composite',
      parts: [{ name: 'api', adapter: { baseUrl: 'https://a.example.com', collections: [{ name: 'x' }, { name: 'z' }] } }, { name: 'api2', adapter: { baseUrl: 'https://b.example.com' } }],
    });
    expect(() => configFromTarget(['ftp://x'])).toThrow(/알 수 없는 대상/);
    // 설정 파일로 여러 시스템 묶기: 예시가 그대로 읽힌다
    expect(loadConfig(path.join(root, 'examples/stack.config.json')).adapter).toMatchObject({ type: 'composite', parts: [{ name: 'k8s' }, { name: 'otel' }, { name: 'db' }] });
  });

  it('opens a verified world from one command against a real PostgreSQL wire endpoint', async () => {
    const shop = await startShop({ httpPort: 0, pgPort: 0, traffic: { orderEveryMs: [400, 800], firstFlashSaleMs: 0, flashSaleEveryMs: 0 } });
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
