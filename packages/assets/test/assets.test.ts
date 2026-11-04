import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENCH_SCHEMAS, compileHeuristic } from '@isomorph/compiler';
import { generateAssets, PixelLabClient, spriteJobs } from '../src/index.ts';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const grammar = compileHeuristic(BENCH_SCHEMAS.find((s) => s.system === 'shop')!);

function mockFetch(status = 200) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get('authorization') });
    if (status !== 200) return new Response(JSON.stringify({ detail: 'Insufficient generations and credits.' }), { status });
    return new Response(JSON.stringify({ image: { type: 'base64', base64: PNG_1PX }, usage: { type: 'usd', usd: 0.01 } }), { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

describe('PixelLab asset pipeline', () => {
  it('generates one sprite per building kind and caches by prompt hash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-assets-'));
    const m = mockFetch();
    const client = new PixelLabClient({ apiKey: 'test-key', fetchImpl: m.impl });
    const jobs = spriteJobs(grammar, 'style');
    expect(jobs.map((j) => j.key).sort()).toEqual(['house', 'townhall', 'warehouse']);
    const r1 = await generateAssets({ grammar, outDir: dir, client });
    expect(r1.generated.sort()).toEqual(['house', 'townhall', 'warehouse']);
    expect(m.calls[0].url).toBe('https://api.pixellab.ai/v2/create-image-pixflux');
    expect(m.calls[0].auth).toBe('Bearer test-key');
    expect(m.calls[0].body).toMatchObject({ image_size: { width: 64, height: 64 }, no_background: true, view: 'high top-down' });
    expect(r1.usd).toBeCloseTo(0.03);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.assets.house).toMatchObject({ source: 'pixellab', width: 64 });
    expect(fs.existsSync(path.join(dir, manifest.assets.house.file))).toBe(true);
    const r2 = await generateAssets({ grammar, outDir: dir, client });
    expect(r2.generated).toEqual([]);
    expect(r2.cached.sort()).toEqual(['house', 'townhall', 'warehouse']);
    expect(m.calls).toHaveLength(3);
  });

  it('stops immediately on payment errors and keeps procedural fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-assets-'));
    const m = mockFetch(402);
    const r = await generateAssets({ grammar, outDir: dir, client: new PixelLabClient({ fetchImpl: m.impl }) });
    expect(m.calls).toHaveLength(1);
    expect(r.stoppedReason).toContain('크레딧');
    expect(r.generated).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).assets).toEqual({});
  });
});
