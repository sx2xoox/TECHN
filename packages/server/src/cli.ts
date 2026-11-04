import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachStats, formatReport, verifyGrammar } from '@isomorph/core';
import { anthropicDraftModel, compile } from '@isomorph/compiler';
import { createAdapter, PostgresAdapter } from '@isomorph/adapters';
import { loadAssets, loadConfig, loadGrammar } from './config.ts';
import { IsomorphRuntime } from './runtime.ts';
import { serve } from './server.ts';

/**
 * isomorph serve   --config isomorph.config.json   세계를 연다
 * isomorph compile --config isomorph.config.json --out world.json   문법만 컴파일·검증해 저장
 * isomorph verify  --config isomorph.config.json --grammar world.json   기존 문법 검증
 * isomorph uninstall-feed --config isomorph.config.json   푸시 관측 트리거 제거
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0] ?? 'serve';
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const configPath = flag('config') ?? 'isomorph.config.json';
const log = (m: string) => console.log(`[isomorph] ${m}`);

async function main() {
  const config = loadConfig(configPath);
  const adapter = createAdapter(config.adapter);
  const llmModel = config.compile?.model ? anthropicDraftModel({ model: config.compile.model }) : undefined;

  if (cmd === 'uninstall-feed') {
    // 푸시 관측용으로 설치한 트리거·함수·로그 테이블 제거
    if (!(adapter instanceof PostgresAdapter)) throw new Error('uninstall-feed 는 postgres 어댑터에만 해당합니다');
    await adapter.connect();
    await adapter.uninstallFeed();
    log('변경 알림 트리거를 모두 제거했습니다');
    await adapter.close();
    return;
  }

  if (cmd === 'compile' || cmd === 'verify') {
    await adapter.connect();
    const schema = attachStats(await adapter.introspect(), await adapter.snapshot());
    if (cmd === 'compile') {
      const r = await compile(schema, { mode: config.compile?.mode ?? 'auto', model: llmModel, numRuns: config.numRuns, onRound: (x) => log(`${x.round}회차(${x.source}): ${x.ok ? '통과' : `오류 ${x.errors}`} · 충실도 ${x.score}`) });
      if (r.fallbackReason) log(`LLM 대신 규칙 기반 사용: ${r.fallbackReason}`);
      console.log(formatReport(r.report));
      const out = flag('out') ?? 'world.json';
      fs.writeFileSync(out, JSON.stringify(r.grammar, null, 2));
      log(`문법 저장: ${out}`);
      process.exitCode = r.report.ok ? 0 : 1;
    } else {
      const g = loadGrammar(flag('grammar') ?? config.grammarPath ?? 'world.json');
      const r = verifyGrammar(g, schema, { numRuns: config.numRuns });
      console.log(formatReport(r));
      process.exitCode = r.ok ? 0 : 1;
    }
    await adapter.close();
    return;
  }

  const runtime = new IsomorphRuntime({
    adapter,
    grammar: config.grammarPath && fs.existsSync(config.grammarPath) ? loadGrammar(config.grammarPath) : undefined,
    compile: { mode: config.compile?.mode ?? 'auto', model: llmModel },
    writeMode: config.writeMode ?? 'read-only',
    pollMs: config.pollMs,
    storePath: config.storePath,
    numRuns: config.numRuns,
    assets: loadAssets(config.assetsDir),
    log,
  });
  const staticDir = path.resolve(here, '../../client/dist');
  const srv = await serve(runtime, {
    port: config.port ?? 4000,
    host: config.host,
    staticDir: fs.existsSync(staticDir) ? staticDir : undefined,
    assetsDir: config.assetsDir,
    token: config.token ?? process.env.ISOMORPH_TOKEN,
    viewerToken: config.viewerToken ?? process.env.ISOMORPH_VIEWER_TOKEN,
    log,
  });
  // 시스템이 아직 안 떴으면 기다렸다가 다시 시도한다
  let status = await runtime.start();
  for (let i = 0; status === 'error' && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    log(`재시도 ${i + 1}…`);
    status = await runtime.start();
  }
  if (status === 'refused') console.log(formatReport(runtime.report));
  const shutdown = async () => {
    await srv.close();
    await runtime.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
