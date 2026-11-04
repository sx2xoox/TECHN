import fs from 'node:fs';
import path from 'node:path';

/**
 * 합성 Claude Code 세션 기록기(데모용): 가상의 프로젝트에서 에이전트가 일하는 모습을
 * Claude Code 기록 형식(JSONL)으로 계속 덧붙인다. 실제 대화나 개인 데이터는 전혀 없다.
 *
 *   npx tsx examples/adapters/fake-agent-session.ts .data/fake-session/session.jsonl
 */
const out = path.resolve(process.argv[2] ?? '.data/fake-session/session.jsonl');
const cwd = '/work/demo-project';
const files = ['src/app.ts', 'src/cart.ts', 'src/payment.ts', 'src/db.ts', 'test/cart.test.ts', 'README.md', 'package.json', 'src/ui/button.tsx', 'src/ui/form.tsx'];
const commands = ['npm test', 'git status', 'git diff', 'npm run build', 'npx tsc --noEmit', 'ls src'];
let n = 0;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '');
const write = (o: object) => fs.appendFileSync(out, `${JSON.stringify({ cwd, ...o })}\n`);

function step() {
  const id = `toolu_${++n}`;
  const r = rand();
  let name: string;
  let input: Record<string, unknown>;
  if (r < 0.35) [name, input] = ['Read', { file_path: `${cwd}/${pick(files)}` }];
  else if (r < 0.55) [name, input] = ['Edit', { file_path: `${cwd}/${pick(files)}`, old_string: '…', new_string: '…' }];
  else if (r < 0.8) [name, input] = ['Bash', { command: pick(commands) }];
  else if (r < 0.92) [name, input] = ['Grep', { pattern: 'TODO', path: `${cwd}/src` }];
  else [name, input] = ['Write', { file_path: '/tmp/scratch-notes.md', content: '…' }]; // 프로젝트 밖 — 법칙 위반
  write({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
  const ms = 300 + Math.floor(rand() * 1800);
  setTimeout(() => {
    const failed = name === 'Bash' && rand() < 0.25;
    write({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: failed ? 'exit 1' : 'ok' }] } });
  }, ms);
}

// 처음에 기록 몇 개를 채워 두고, 이후 1.2초마다 한 번씩 일한다
for (let i = 0; i < 12; i++) step();
setInterval(step, 1200);
console.log(`[fake-agent] ${out} 에 합성 세션 기록을 쓰는 중…`);
