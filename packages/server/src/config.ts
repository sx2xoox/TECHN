import fs from 'node:fs';
import path from 'node:path';
import { parseGrammar, type AssetManifest, type WorldGrammar, type WriteMode } from '@isomorph/core';
import type { AdapterConfig } from '@isomorph/adapters';

export interface IsomorphConfig {
  adapter: AdapterConfig;
  compile?: { mode?: 'heuristic' | 'llm' | 'auto'; model?: string };
  /** 고정 문법 파일(있으면 컴파일 대신 사용, 그래도 검증은 한다) */
  grammarPath?: string;
  writeMode?: WriteMode;
  pollMs?: number;
  port?: number;
  host?: string;
  storePath?: string;
  numRuns?: number;
  assetsDir?: string;
}

export function loadConfig(file: string): IsomorphConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as IsomorphConfig;
  const base = path.dirname(path.resolve(file));
  const rel = (p?: string) => (p ? path.resolve(base, p) : undefined);
  return { ...raw, grammarPath: rel(raw.grammarPath), storePath: raw.storePath === ':memory:' ? raw.storePath : rel(raw.storePath), assetsDir: rel(raw.assetsDir) };
}

export function loadGrammar(file: string): WorldGrammar {
  const r = parseGrammar(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!r.ok) throw new Error(`문법 파일 구조 오류:\n${r.errors.join('\n')}`);
  return r.value;
}

export function loadAssets(dir?: string): AssetManifest | null {
  if (!dir) return null;
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as AssetManifest;
}
