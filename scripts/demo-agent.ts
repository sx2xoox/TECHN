import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AI 에이전트 데모: 합성 Claude Code 세션 기록 → 에이전트의 머릿속 마을(:4003)
 *   npm run demo:agent
 * 실제 세션을 보려면 examples/claude-code.config.json 의 projectDir 를 바꿔 serve 하세요.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const kids = [
  spawn(tsx, ['examples/adapters/fake-agent-session.ts', '.data/fake-session/session.jsonl'], { cwd: root, stdio: 'inherit' }),
];
setTimeout(() => {
  kids.push(spawn(tsx, ['packages/server/src/cli.ts', 'serve', '--config', 'examples/claude-code-demo.config.json'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' } }));
  console.log('\n  ▶ 브라우저에서 http://127.0.0.1:4003 을 여세요\n');
}, 1500);
const stop = () => {
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
