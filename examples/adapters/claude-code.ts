import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineAdapter, type Adapter } from '@isomorph/adapters';
import type { Row, SystemSchema } from '@isomorph/core';

/**
 * 예제 어댑터(어댑터 SDK 사용): Claude Code 세션 기록(JSONL) → 'AI 에이전트의 머릿속 마을'
 *
 *   도구(Bash, Read, Write…)      → 공업지대의 공방(사용 횟수 = 인파, 오류 = 불길, 평균 소요 = 속도)
 *   에이전트가 건드린 파일          → 학문 거리의 도서관(프로젝트 밖 파일 = 안개)
 *   도구 호출 하나하나              → 공방에서 도서관으로 걷는 일꾼 로봇(대기 노랑·성공 초록·오류 빨강)
 *   세션 지표                       → 광장의 시청
 *   법칙: 에이전트는 프로젝트 밖 파일을 건드리지 않는다 → 어기면 화면 깨짐
 *
 * 기록 파일은 끝에서부터 '덧붙은 줄만' 읽는다(증분). 파일이 바뀌면 즉시 알린다(푸시 관측).
 * 명령·파일 내용은 세계로 가져오지 않는다: 도구 이름, 파일 이름, Bash 명령의 첫 단어만.
 */
export interface ClaudeCodeOptions {
  /** 특정 기록 파일 */
  transcript?: string;
  /** 또는 프로젝트 기록 폴더(~/.claude/projects/<프로젝트>) — 가장 최근 파일을 따라간다 */
  projectDir?: string;
  /** 에이전트가 머물러야 하는 프로젝트 경로(기본: 기록의 cwd) */
  cwd?: string;
  /** 세계에 남길 최근 도구 호출 수 */
  keepCalls?: number;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);

interface Call {
  id: number;
  toolUseId: string;
  tool: string;
  file: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'pending' | 'ok' | 'error';
  summary: string;
}

function expandHome(p: string) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function latestJsonl(dir: string): string | null {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

function summarize(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    const words = input.command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w) && w !== 'cd' && !w.startsWith('/'));
    return words[0]?.replace(/[^\w.:-]/g, '').slice(0, 24) || 'bash';
  }
  return tool;
}

function fileOf(input: Record<string, unknown>): string | null {
  const v = input.file_path ?? input.notebook_path ?? input.path;
  return typeof v === 'string' && v.length ? v : null;
}

export const CLAUDE_CODE_SCHEMA: SystemSchema = {
  system: 'claude-code',
  source: 'custom',
  constraints: [
    {
      collection: 'files',
      expr: { op: 'cmp', field: 'outside_project', cmp: '==', value: false },
      description: '에이전트는 프로젝트 밖 파일을 건드리지 않는다',
      enforced: false,
    },
  ],
  collections: [
    {
      name: 'tools',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'calls', type: 'integer', nullable: false, stats: { min: 0, max: 40 } },
        { name: 'errors', type: 'integer', nullable: false, stats: { min: 0, max: 3 } },
        { name: 'avg_ms', type: 'number', nullable: true, stats: { min: 0, max: 3000 } },
        { name: 'last_used', type: 'timestamp', nullable: true },
      ],
    },
    {
      name: 'files',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', nullable: false },
        { name: 'dir', type: 'string', nullable: false },
        { name: 'reads', type: 'integer', nullable: false, stats: { min: 0, max: 10 } },
        { name: 'writes', type: 'integer', nullable: false, stats: { min: 0, max: 10 } },
        { name: 'outside_project', type: 'boolean', nullable: false },
        { name: 'last_touched', type: 'timestamp', nullable: true },
      ],
    },
    {
      name: 'tool_calls',
      primaryKey: 'id',
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'tool_id', type: 'integer', nullable: false, ref: { collection: 'tools', field: 'id' }, refEnforced: false },
        { name: 'file_id', type: 'integer', nullable: true, ref: { collection: 'files', field: 'id' }, refEnforced: false },
        { name: 'status', type: 'string', nullable: false, enumValues: ['pending', 'ok', 'error'] },
        { name: 'summary', type: 'string', nullable: false },
        { name: 'duration_ms', type: 'number', nullable: true, stats: { min: 0, max: 3000 } },
        { name: 'started_at', type: 'timestamp', nullable: false },
        { name: 'finished_at', type: 'timestamp', nullable: true },
      ],
    },
    {
      name: 'session_stats',
      primaryKey: 'id',
      rowCountHint: 1,
      fields: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'calls_per_min', type: 'integer', nullable: false, stats: { min: 0, max: 30 } },
        { name: 'error_count', type: 'integer', nullable: false, stats: { min: 0, max: 5 } },
        { name: 'avg_latency_ms', type: 'number', nullable: false, stats: { min: 0, max: 2000 } },
      ],
    },
  ],
};

export default function claudeCodeAdapter(options: ClaudeCodeOptions = {}): Adapter {
  let file: string | null = null;
  let offset = 0;
  let partial = '';
  let cwd = options.cwd ? path.resolve(expandHome(options.cwd)) : null;
  const calls = new Map<string, Call>();
  const order: string[] = [];
  let seq = 0;
  const toolIds = new Map<string, number>();
  const fileIds = new Map<string, number>();

  const resolveFile = () => {
    const next = options.transcript ? expandHome(options.transcript) : options.projectDir ? latestJsonl(expandHome(options.projectDir)) : null;
    if (!next) throw new Error('transcript 또는 projectDir 를 지정하세요');
    if (next !== file) {
      file = next;
      offset = 0;
      partial = '';
      calls.clear();
      order.length = 0;
    }
    return file;
  };

  /** 덧붙은 줄만 읽어 상태를 갱신한다 */
  const ingest = () => {
    const f = resolveFile();
    const size = fs.statSync(f).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const text = partial + buf.toString('utf8');
    const lines = text.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: Record<string, any>;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
      const ts = typeof o.timestamp === 'string' ? o.timestamp : new Date().toISOString();
      const content = o.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (o.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          calls.set(b.id, { id: ++seq, toolUseId: b.id, tool: String(b.name), file: fileOf(input), startedAt: ts, finishedAt: null, status: 'pending', summary: summarize(String(b.name), input) });
          order.push(b.id);
        } else if (o.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const c = calls.get(b.tool_use_id);
          if (c) {
            c.finishedAt = ts;
            c.status = b.is_error ? 'error' : 'ok';
          }
        }
      }
    }
  };

  const build = (): Record<string, Row[]> => {
    ingest();
    const now = Date.now();
    const all = order.map((id) => calls.get(id)!);
    const toolsAgg = new Map<string, { calls: number; errors: number; ms: number[]; last: string | null }>();
    const filesAgg = new Map<string, { reads: number; writes: number; last: string | null }>();
    for (const c of all) {
      const t = toolsAgg.get(c.tool) ?? { calls: 0, errors: 0, ms: [], last: null };
      t.calls++;
      if (c.status === 'error') t.errors++;
      if (c.finishedAt) t.ms.push(Date.parse(c.finishedAt) - Date.parse(c.startedAt));
      t.last = c.startedAt;
      toolsAgg.set(c.tool, t);
      if (!toolIds.has(c.tool)) toolIds.set(c.tool, toolIds.size + 1);
      if (c.file) {
        const f = filesAgg.get(c.file) ?? { reads: 0, writes: 0, last: null };
        if (WRITE_TOOLS.has(c.tool)) f.writes++;
        else if (READ_TOOLS.has(c.tool)) f.reads++;
        f.last = c.startedAt;
        filesAgg.set(c.file, f);
        if (!fileIds.has(c.file)) fileIds.set(c.file, fileIds.size + 1);
      }
    }
    const root = cwd ? path.resolve(cwd) : null;
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const recent = all.slice(-(options.keepCalls ?? 300));
    const finished = all.filter((c) => c.finishedAt).slice(-50);
    return {
      tools: [...toolsAgg].map(([name, t]) => ({ id: toolIds.get(name)!, name, calls: t.calls, errors: t.errors, avg_ms: avg(t.ms), last_used: t.last })),
      files: [...filesAgg].map(([p, f]) => {
        const abs = path.resolve(root ?? '/', p);
        const inside = root ? abs === root || abs.startsWith(root + path.sep) : true;
        return {
          id: fileIds.get(p)!,
          name: path.basename(p),
          dir: root && inside ? path.dirname(path.relative(root, abs)) || '.' : path.dirname(abs),
          reads: f.reads,
          writes: f.writes,
          outside_project: !inside,
          last_touched: f.last,
        };
      }),
      tool_calls: recent.map((c) => ({
        id: c.id,
        tool_id: toolIds.get(c.tool)!,
        file_id: c.file ? fileIds.get(c.file)! : null,
        status: c.status,
        summary: c.summary,
        duration_ms: c.finishedAt ? Date.parse(c.finishedAt) - Date.parse(c.startedAt) : null,
        started_at: c.startedAt,
        finished_at: c.finishedAt,
      })),
      session_stats: [
        {
          id: 1,
          calls_per_min: all.filter((c) => now - Date.parse(c.startedAt) < 60_000).length,
          error_count: all.filter((c) => c.status === 'error' && now - Date.parse(c.startedAt) < 10 * 60_000).length,
          avg_latency_ms: avg(finished.map((c) => Date.parse(c.finishedAt!) - Date.parse(c.startedAt))) ?? 0,
        },
      ],
    };
  };

  return defineAdapter({
    system: 'claude-code',
    schema: CLAUDE_CODE_SCHEMA,
    async read() {
      return build();
    },
    async watch(onChange) {
      const f = resolveFile();
      const watcher = fs.watch(f, () => onChange(['tools', 'files', 'tool_calls', 'session_stats']));
      return async () => watcher.close();
    },
  });
}
