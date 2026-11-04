import fs from 'node:fs';
import { parseGrammar, type WorldGrammar } from '@isomorph/core';
import { PixelLabClient } from './pixellab.ts';
import { generateAssets } from './pipeline.ts';

/**
 * npm run assets -- --from http://127.0.0.1:4000 [--out assets/generated] [--force]
 * npm run assets -- --grammar world.json
 * npm run assets -- --balance
 */
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function loadGrammar(): Promise<WorldGrammar> {
  const file = flag('grammar');
  const from = flag('from') ?? (file ? undefined : 'http://127.0.0.1:4000');
  const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : (await (await fetch(`${from}/api/hello`)).json()).grammar;
  const r = parseGrammar(raw);
  if (!r.ok) throw new Error(`문법을 읽을 수 없습니다: ${r.errors.join('; ')}`);
  return r.value;
}

async function main() {
  const client = new PixelLabClient();
  if (args.includes('--balance')) {
    console.log(JSON.stringify(await client.balance(), null, 2));
    return;
  }
  const grammar = await loadGrammar();
  const out = flag('out') ?? 'assets/generated';
  const r = await generateAssets({ grammar, outDir: out, client, force: args.includes('--force'), log: (m) => console.log(`[assets] ${m}`) });
  console.log(`[assets] 생성 ${r.generated.length} · 캐시 ${r.cached.length} · 실패 ${r.failed.length} · 비용 $${r.usd.toFixed(3)} → ${out}/manifest.json`);
  if (r.stoppedReason) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`[assets] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
