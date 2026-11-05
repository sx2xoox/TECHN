import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachStats, formatReport, verifyGrammar } from '@isomorph/core';
import { anthropicDraftModel, compile } from '@isomorph/compiler';
import { CompositeAdapter, loadAdapter, OtelAdapter, PostgresAdapter } from '@isomorph/adapters';
import { configFromTarget, loadAssets, loadConfig, loadGrammar } from './config.ts';
import { isLoopback } from './auth.ts';
import { attachNotifier } from './notify.ts';
import { IsomorphRuntime } from './runtime.ts';
import { serve } from './server.ts';

/**
 * isomorph connect <postgres://…|https://…|otel|docker|kubernetes> [--schema s] [--port 4000] [--write low]   설정 파일 없이 바로(읽기 전용)
 *   kubernetes: [--context c] [--kubeconfig f] [--namespace n]
 *   대상을 여러 개(종류가 달라도) 주면 한 세계로 묶는다: connect postgres://… otel kubernetes
 *   알림: --notify <웹훅>(또는 ISOMORPH_NOTIFY_URL) [--public-url https://…]
 * isomorph study   사용자 실험 서버(STUDY_* 환경변수, scripts/study.ts 와 같음)
 * isomorph snapshot <대상|--config x.json> [--observe 20] [--minutes 10] [--out world.html]   공유본(HTML 한 파일) 만들기
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
  if (cmd === 'study') {
    const { startStudyServer } = await import('./study.ts');
    const srv = await startStudyServer({
      port: Number(process.env.PORT ?? 4100),
      host: process.env.HOST ?? '127.0.0.1',
      staticDir: path.resolve(here, '../../client/dist'),
      dataDir: path.resolve(process.env.STUDY_DATA ?? 'data/study'),
      conditions: (process.env.STUDY_CONDITIONS ?? 'world,table').split(',') as never,
      perCondition: Number(process.env.STUDY_PER_CONDITION ?? 5),
      accessCode: process.env.STUDY_ACCESS_CODE || undefined,
      adminToken: process.env.STUDY_ADMIN_TOKEN || undefined,
      log,
    });
    log(`참가자 화면: ${srv.url} · 진행자 화면: ${srv.adminUrl}`);
    return;
  }
  const targetLike = (cmd === 'connect' || cmd === 'snapshot') && args[1] && !args[1].startsWith('--');
  const config =
    targetLike
      ? configFromTarget(
          args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--')),
          { schema: flag('schema'), namespace: flag('namespace'), port: flag('port') ? Number(flag('port')) : undefined, host: flag('host'), write: flag('write') as never, context: flag('context'), kubeconfig: flag('kubeconfig') },
        )
      : loadConfig(configPath);
  if (cmd === 'connect') log(`연결: ${config.adapter.type} · 쓰기 ${config.writeMode}${config.writeMode === 'read-only' ? '(바꾸려면 --write low|medium|high)' : ''}`);

  const adapter = await loadAdapter(config.adapter);
  const llmModel = config.compile?.model ? anthropicDraftModel({ model: config.compile.model }) : process.env.ANTHROPIC_API_KEY && cmd === 'connect' ? anthropicDraftModel({}) : undefined;
  if (cmd === 'snapshot') {
    // 잠깐 지켜본 뒤 그동안의 세계를 HTML 한 파일로(서버를 띄우지 않는다)
    const { buildWorldBundle, renderSnapshotHtml } = await import('./snapshot.ts');
    const rt = new IsomorphRuntime({ adapter, compile: { mode: config.compile?.mode ?? 'auto', model: llmModel }, pollMs: 1000, numRuns: config.numRuns, log });
    const status = await rt.start();
    if (status !== 'running') throw new Error(`세계를 열지 못했습니다: ${status} ${rt.error ?? ''}`);
    const seconds = Number(flag('observe') ?? 20);
    log(`${seconds}초 동안 지켜봅니다…`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await rt.refresh();
    const html = renderSnapshotHtml(buildWorldBundle(rt, { minutes: Number(flag('minutes') ?? 10) }), path.resolve(here, '../../client/dist-snapshot'));
    const out = flag('out') ?? `isomorph-${config.adapter.type}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`;
    fs.writeFileSync(out, html);
    log(`공유본: ${out} (${(html.length / 1024 / 1024).toFixed(1)}MB, 서버 없이 열립니다 · 보기 전용 · 민감 정보 가명)`);
    await rt.stop();
    return;
  }

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

  // OTLP 수신기는 설정이 위험하면(바깥 주소인데 수신 토큰 없음) 재시도하지 말고 바로 멈춘다
  if (config.adapter.type === 'otel') await adapter.connect();
  if (adapter instanceof CompositeAdapter) {
    for (const p of adapter.parts) if (p.adapter instanceof OtelAdapter) await p.adapter.connect();
    log(`한 세계로 묶음: ${adapter.parts.map((p) => `${p.name}(${p.adapter.system})`).join(' · ')}`);
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
  // 알림: 법칙이 새로 깨지면 웹훅으로(링크는 그 개체·그 시점의 세계)
  const webhook = flag('notify') ?? config.notify?.webhook ?? process.env.ISOMORPH_NOTIFY_URL;
  if (webhook) {
    const publicUrl = flag('public-url') ?? config.publicUrl ?? process.env.ISOMORPH_PUBLIC_URL ?? (isLoopback(config.host) ? srv.url : null);
    const n = attachNotifier(runtime, { ...config.notify, webhook, publicUrl, log });
    log(`알림 켜짐(${n.format})${publicUrl ? ` · 링크 ${publicUrl}` : ' · 링크 없음(바깥 주소면 --public-url 로 알려 주세요)'}`);
    process.once('SIGTERM', () => void n.stop());
  }
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
