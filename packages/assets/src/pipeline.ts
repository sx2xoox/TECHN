import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetManifest, WorldGrammar } from '@isomorph/core';
import { PixelLabError, type PixelLabClient } from './pixellab.ts';

/**
 * Living Asset Pipeline: 세계 문법의 '종류'마다 스프라이트를 한 번만 생성하고 캐시한다.
 * 개체가 1만 개여도 비용은 종류 수에 비례한다. 생성할 수 없으면 절차적 픽셀 아트로 남는다.
 */
export const DEFAULT_STYLE = 'original 16-bit pixel art, cozy town, warm palette, top-down 3/4 view, single object centered, no text';

export interface GenerateOptions {
  grammar: WorldGrammar;
  outDir: string;
  client: PixelLabClient;
  style?: string;
  size?: number;
  force?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateResult {
  manifest: AssetManifest;
  generated: string[];
  cached: string[];
  failed: { key: string; error: string }[];
  stoppedReason?: string;
  usd: number;
}

export function readManifest(dir: string): AssetManifest | null {
  const f = path.join(dir, 'manifest.json');
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as AssetManifest) : null;
}

/** 건물·랜드마크 스프라이트만 생성(걷는 인물은 프레임 애니메이션이 필요해 절차적 스프라이트 유지) */
export function spriteJobs(grammar: WorldGrammar, style: string): { key: string; prompt: string }[] {
  const seen = new Map<string, string>();
  for (const k of grammar.kinds) {
    if (k.archetype === 'npc' || seen.has(k.sprite)) continue;
    seen.set(k.sprite, `${k.spritePrompt || k.sprite}. ${style}`);
  }
  return [...seen].map(([key, prompt]) => ({ key, prompt }));
}

export async function generateAssets(opts: GenerateOptions): Promise<GenerateResult> {
  const style = opts.style ?? DEFAULT_STYLE;
  const size = opts.size ?? 64;
  const log = opts.log ?? (() => {});
  fs.mkdirSync(opts.outDir, { recursive: true });
  const prev = readManifest(opts.outDir);
  const manifest: AssetManifest = { version: 1, style, generatedAt: new Date().toISOString(), assets: { ...(prev?.assets ?? {}) } };
  const result: GenerateResult = { manifest, generated: [], cached: [], failed: [], usd: 0 };

  for (const job of spriteJobs(opts.grammar, style)) {
    const hash = createHash('sha256').update(`${job.prompt}|${size}`).digest('hex').slice(0, 16);
    const file = `${job.key}-${hash}.png`;
    const existing = manifest.assets[job.key];
    if (!opts.force && existing?.hash === hash && existing.source === 'pixellab' && fs.existsSync(path.join(opts.outDir, existing.file))) {
      result.cached.push(job.key);
      continue;
    }
    try {
      log(`생성: ${job.key} — "${job.prompt}"`);
      const { png, usd } = await opts.client.pixflux({ description: job.prompt, width: size, height: size, noBackground: true, view: 'high top-down', outline: 'single color black outline', shading: 'basic shading', detail: 'medium detail' });
      fs.writeFileSync(path.join(opts.outDir, file), png);
      manifest.assets[job.key] = { file, prompt: job.prompt, width: size, height: size, source: 'pixellab', hash };
      result.generated.push(job.key);
      result.usd += usd ?? 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed.push({ key: job.key, error: msg });
      // 결제·인증 문제는 다음 요청도 똑같이 실패하므로 즉시 멈춘다
      if (e instanceof PixelLabError && (e.status === 401 || e.status === 402)) {
        result.stoppedReason = msg;
        log(`중단: ${msg} — 나머지는 절차적 픽셀 아트로 표시됩니다`);
        break;
      }
      log(`실패(${job.key}): ${msg}`);
    }
  }
  fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return result;
}
