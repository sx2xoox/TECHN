import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachStats, observe } from '@isomorph/core';
import { compile } from '@isomorph/compiler';
import { defineAdapter, loadAdapter } from '@isomorph/adapters';
import claudeCodeAdapter from './claude-code.ts';

const cwd = '/work/project';
const t = (s: number) => new Date(Date.now() - 30_000 + s * 1000).toISOString();
const line = (o: object) => `${JSON.stringify(o)}\n`;
const use = (id: string, name: string, input: object, s: number) => line({ type: 'assistant', cwd, timestamp: t(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, s: number, isError = false) => line({ type: 'user', cwd, timestamp: t(s), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });

function transcript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-cc-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    use('a', 'Read', { file_path: `${cwd}/src/app.ts` }, 0) +
      result('a', 1) +
      use('b', 'Bash', { command: 'API_KEY=secret npm test -- --watch' }, 2) +
      result('b', 4, true) +
      use('c', 'Write', { file_path: '/etc/hosts', content: 'secret stuff' }, 5) +
      result('c', 6) +
      use('d', 'Edit', { file_path: `${cwd}/src/app.ts`, old_string: 'a', new_string: 'b' }, 7),
  );
  return file;
}

describe('example adapter: Claude Code session → world', () => {
  it('turns tool calls into a lawful world and flags edits outside the project', async () => {
    const a = claudeCodeAdapter({ transcript: transcript() });
    await a.connect();
    const schema = attachStats(await a.introspect(), await a.snapshot());
    const snap = await a.snapshot();
    expect(snap.collections.tools.map((r) => r.name)).toEqual(['Read', 'Bash', 'Write', 'Edit']);
    expect(snap.collections.tools.find((r) => r.name === 'Bash')).toMatchObject({ calls: 1, errors: 1 });
    expect(snap.collections.files.map((r) => [r.name, r.dir, r.outside_project])).toEqual([
      ['app.ts', 'src', false],
      ['hosts', '/etc', true],
    ]);
    const calls = snap.collections.tool_calls;
    expect(calls.map((c) => c.status)).toEqual(['ok', 'error', 'ok', 'pending']);
    // 명령 전체·비밀값은 세계로 오지 않는다
    expect(JSON.stringify(snap)).not.toContain('secret');
    expect(calls[1].summary).toBe('npm');

    const r = await compile(schema, { mode: 'heuristic', numRuns: 60 });
    expect(r.report.ok).toBe(true);
    const kinds = Object.fromEntries(r.grammar.kinds.map((k) => [k.collection, k]));
    expect(kinds.tools).toMatchObject({ sprite: 'factory', archetype: 'building' });
    expect(kinds.files).toMatchObject({ sprite: 'library', archetype: 'building' });
    expect(kinds.tool_calls).toMatchObject({ sprite: 'robot', archetype: 'npc', route: { from: 'tool_id', to: 'file_id' } });
    expect(kinds.session_stats).toMatchObject({ archetype: 'landmark' });
    expect(kinds.files.channels.find((c) => c.channel === 'fog')).toMatchObject({ field: 'outside_project' });

    const world = observe(snap, r.grammar, schema);
    const hosts = world.entities.find((e) => e.label === 'hosts')!;
    expect(hosts.visual.fog).toBe(true);
    expect(hosts.anomalies.map((x) => x.message)).toContain('에이전트는 프로젝트 밖 파일을 건드리지 않는다');
  });

  it('reads only appended lines and notifies on change', async () => {
    const file = transcript();
    const a = claudeCodeAdapter({ transcript: file });
    await a.introspect();
    expect((await a.snapshot()).collections.tool_calls).toHaveLength(4);
    const seen: string[][] = [];
    const stop = await a.watch!((c) => seen.push(c));
    fs.appendFileSync(file, result('d', 9) + use('e', 'Grep', { pattern: 'x' }, 10));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.length).toBeGreaterThan(0);
    const snap = await a.snapshot();
    expect(snap.collections.tool_calls.map((c) => c.status)).toEqual(['ok', 'error', 'ok', 'ok', 'pending']);
    await stop!();
    await expect(a.execute({ op: 'update', collection: 'tools', pk: 1, patch: {}, before: {} })).rejects.toThrow('읽기 전용');
  });
});

describe('adapter SDK', () => {
  it('infers a schema from rows and loads adapters from modules', async () => {
    const a = defineAdapter({
      system: 'jobs',
      collections: [{ name: 'queues', primaryKey: 'id' }, { name: 'jobs' }],
      async read() {
        return {
          queues: [{ id: 1, name: 'mail', paused: false }],
          jobs: [{ id: 7, queue_id: 1, state: 'running', attempts: 2, created_at: new Date().toISOString() }],
        };
      },
    });
    const s = await a.introspect();
    expect(s.collections.find((c) => c.name === 'jobs')!.fields.find((f) => f.name === 'queue_id')!.ref).toEqual({ collection: 'queues', field: 'id' });
    const r = await compile(attachStats(s, await a.snapshot()), { mode: 'heuristic', numRuns: 40 });
    expect(r.report.ok).toBe(true);
    const loaded = await loadAdapter({ type: 'module', path: path.join(import.meta.dirname, 'claude-code.ts'), options: { transcript: transcript() } });
    expect(loaded.kind).toBe('custom');
    expect((await loaded.snapshot()).collections.tools).toHaveLength(4);
  });
});
