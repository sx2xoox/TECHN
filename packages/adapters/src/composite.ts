import type { CollectionSchema, Expr, FieldSchema, Row, Snapshot, SystemSchema, UpdateCommand } from '@isomorph/core';
import { UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * 여러 시스템을 한 세계로: 데이터베이스·서비스(OpenTelemetry)·클러스터(Kubernetes)…
 *
 *  - 컬렉션 이름 앞에 시스템 이름을 붙인다(k8s_deployments, otel_services). 각 시스템의 참조·제약·민감·읽기 전용 표시는 그대로.
 *  - 시스템 사이의 연결을 찾아 참조로 만든다.
 *      · 자동: 같은 joinKey(예: 'service') 를 단 필드끼리. OpenTelemetry 의 service.name 과 Kubernetes 디플로이먼트 이름이 그 예.
 *      · 직접: links: [{ from: 'k8s.deployments.name', to: 'otel.services.id' }]
 *    연결 값은 상대 시스템에 실제로 그 행이 있을 때만 채운다(없으면 null → '대상 없음' 거짓 경보가 생기지 않는다).
 *  - 읽기·쓰기·즉시 반영(watch)·창 밖 확인(lookup)은 이름표를 보고 각 시스템으로 보낸다.
 */
export interface CompositePart {
  /** 짧은 영문 이름(컬렉션 앞에 붙는다): db, otel, k8s … */
  name: string;
  adapter: Adapter;
}

export interface CompositeLinkSpec {
  /** 'part.collection.field' */
  from: string;
  /** 'part.collection.field' — 대상 행을 찾을 필드(기본키가 아니어도 된다) */
  to: string;
}

export interface CompositeAdapterOptions {
  parts: CompositePart[];
  links?: CompositeLinkSpec[];
  /** joinKey 로 자동 연결(기본 켬) */
  autoLink?: boolean;
  system?: string;
}

interface Link {
  /** 연결 필드를 붙일 컬렉션(접두사 포함)과 그 값의 출처 필드 */
  source: string;
  sourceField: string;
  /** 대상 컬렉션(접두사 포함), 대상에서 찾을 필드, 대상의 기본키 */
  target: string;
  targetField: string;
  targetPk: string;
  /** 새로 붙는 필드 이름 */
  as: string;
  why: string;
  /** 어느 쪽이 기반인가(어댑터가 joinUpstream 으로 밝힌 경우만) */
  upstream?: 'target' | 'source';
}

const NAME_RE = /^[a-z][a-z0-9]{0,15}$/;
const AMBIGUOUS = Symbol('ambiguous');

export class CompositeAdapter implements Adapter {
  readonly kind = 'custom' as const;
  readonly system: string;
  readonly parts: CompositePart[];
  private owner = new Map<string, { part: CompositePart; collection: string }>();
  private schema: SystemSchema | null = null;
  private links: Link[] = [];
  /** 대상 컬렉션별 '찾는 값 → 기본키' (부분 관측 때 상대가 없으면 마지막 값을 쓴다) */
  private index = new Map<string, Map<string, string | typeof AMBIGUOUS>>();

  constructor(private opts: CompositeAdapterOptions) {
    if (!opts.parts.length) throw new Error('합칠 시스템이 없습니다');
    const names = new Set<string>();
    for (const p of opts.parts) {
      if (!NAME_RE.test(p.name)) throw new Error(`시스템 이름은 소문자 영문·숫자 16자 이내여야 합니다: ${p.name}`);
      if (names.has(p.name)) throw new Error(`시스템 이름이 겹칩니다: ${p.name}`);
      names.add(p.name);
    }
    this.parts = opts.parts;
    this.system = opts.system ?? opts.parts.map((p) => p.adapter.system).join(' + ');
  }

  /** 지금 묶인 시스템 사이 연결(설명용) */
  get crossLinks(): readonly Link[] {
    return this.links;
  }

  async connect() {
    await Promise.all(this.parts.map((p) => p.adapter.connect()));
  }

  async introspect(): Promise<SystemSchema> {
    const schemas = await Promise.all(this.parts.map(async (p) => ({ part: p, schema: await p.adapter.introspect() })));
    const collections: CollectionSchema[] = [];
    const constraints: SystemSchema['constraints'] = [];
    this.owner.clear();
    for (const { part, schema } of schemas) {
      const pre = (c: string) => `${part.name}_${c}`;
      for (const c of schema.collections) {
        this.owner.set(pre(c.name), { part, collection: c.name });
        collections.push({ ...c, name: pre(c.name), system: part.name, fields: c.fields.map((f) => (f.ref ? { ...f, ref: { ...f.ref, collection: pre(f.ref.collection) } } : f)) });
      }
      for (const k of schema.constraints) constraints.push({ ...k, collection: pre(k.collection), expr: renameExpr(k.expr, pre) });
    }
    this.links = this.resolveLinks(collections);
    for (const l of this.links) {
      const c = collections.find((x) => x.name === l.source)!;
      const pkField = collections.find((x) => x.name === l.target)!.fields.find((f) => f.name === l.targetPk)!;
      const field: FieldSchema = { name: l.as, type: pkField.type === 'integer' ? 'integer' : 'string', nullable: true, ref: { collection: l.target, field: l.targetPk, crossSystem: true, ...(l.upstream ? { upstream: l.upstream } : {}) }, refEnforced: false, readOnly: true };
      c.fields = [...c.fields, field];
    }
    this.schema = { system: this.system, source: 'custom', collections, constraints };
    return this.schema;
  }

  private resolveLinks(collections: CollectionSchema[]): Link[] {
    const out: Link[] = [];
    const partOf = (c: string) => this.owner.get(c)!.part.name;
    const add = (source: CollectionSchema, sourceField: string, target: CollectionSchema, targetField: string, why: string, upstream?: 'target' | 'source') => {
      if (partOf(source.name) === partOf(target.name)) return;
      if (out.some((l) => (l.source === source.name && l.target === target.name) || (l.source === target.name && l.target === source.name))) return;
      let as = `${target.name}_id`;
      while (source.fields.some((f) => f.name === as)) as = `${as}_link`;
      out.push({ source: source.name, sourceField, target: target.name, targetField, targetPk: target.primaryKey, as, why, ...(upstream ? { upstream } : {}) });
    };
    const find = (spec: string) => {
      const m = /^([a-z][a-z0-9]*)\.([^.]+)\.([^.]+)$/.exec(spec);
      const c = m && collections.find((x) => x.name === `${m[1]}_${m[2]}`);
      if (!m || !c || !c.fields.some((f) => f.name === m[3])) throw new Error(`연결을 찾을 수 없습니다: ${spec} ('시스템.컬렉션.필드')`);
      return { c, field: m[3] };
    };
    for (const l of this.opts.links ?? []) {
      const a = find(l.from);
      const b = find(l.to);
      add(a.c, a.field, b.c, b.field, `설정: ${l.from} → ${l.to}`);
    }
    if (this.opts.autoLink !== false) {
      const keyed = collections.flatMap((c) => c.fields.filter((f) => f.joinKey && !f.sensitive).map((f) => ({ c, f })));
      for (const a of keyed) {
        for (const b of keyed) {
          if (a === b || a.f.joinKey !== b.f.joinKey || partOf(a.c.name) === partOf(b.c.name)) continue;
          const bIsPk = b.f.name === b.c.primaryKey;
          const aIsPk = a.f.name === a.c.primaryKey;
          // 방향: 기본키 쪽을 가리킨다. 둘 다 기본키거나 둘 다 아니면 시스템 순서로 한 방향만.
          const forward = bIsPk && !aIsPk ? true : aIsPk && !bIsPk ? false : partOf(a.c.name) < partOf(b.c.name);
          if (forward) add(a.c, a.f.name, b.c, b.f.name, `같은 이름 체계(${a.f.joinKey})`, a.f.joinUpstream ? 'source' : b.f.joinUpstream ? 'target' : undefined);
        }
      }
    }
    return out;
  }

  private route(collection: string) {
    const o = this.owner.get(collection);
    if (!o) throw new UnsupportedCommandError(`알 수 없는 컬렉션: ${collection}`);
    return o;
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    if (!this.schema) await this.introspect();
    // 연결 값을 채우려면 대상도 필요하다(없으면 마지막 색인을 쓴다)
    const wanted = only ? new Set(only) : null;
    const byPart = new Map<CompositePart, string[] | undefined>();
    for (const p of this.parts) byPart.set(p, wanted ? [] : undefined);
    if (wanted) {
      for (const c of wanted) {
        const o = this.owner.get(c);
        if (o) byPart.get(o.part)!.push(o.collection);
      }
    }
    const results = await Promise.all(
      this.parts.map(async (p) => {
        const list = byPart.get(p);
        if (list && !list.length) return null;
        return { part: p, snap: await p.adapter.snapshot(list) };
      }),
    );
    const collections: Snapshot['collections'] = {};
    let ts = 0;
    for (const r of results) {
      if (!r) continue;
      ts = Math.max(ts, r.snap.ts);
      for (const [c, rows] of Object.entries(r.snap.collections)) collections[`${r.part.name}_${c}`] = rows;
    }
    for (const l of this.links) {
      const rows = collections[l.target];
      if (rows) {
        const idx = new Map<string, string | typeof AMBIGUOUS>();
        for (const row of rows) {
          const k = row[l.targetField];
          if (k === null || k === undefined) continue;
          idx.set(String(k), idx.has(String(k)) ? AMBIGUOUS : String(row[l.targetPk]));
        }
        this.index.set(`${l.target}.${l.targetField}`, idx);
      }
    }
    for (const l of this.links) {
      const rows = collections[l.source];
      if (!rows) continue;
      const idx = this.index.get(`${l.target}.${l.targetField}`);
      collections[l.source] = rows.map((row): Row => {
        const v = row[l.sourceField];
        const hit = v === null || v === undefined ? undefined : idx?.get(String(v));
        return { ...row, [l.as]: hit === undefined || hit === AMBIGUOUS ? null : hit };
      });
    }
    return { ts: ts || Date.now(), collections };
  }

  async watch(onChange: (collections: string[]) => void) {
    const stops: (() => Promise<void>)[] = [];
    for (const p of this.parts) {
      if (!p.adapter.watch) continue;
      const stop = await p.adapter.watch((cols) => {
        const changed = new Set(cols.map((c) => `${p.name}_${c}`));
        // 대상이 바뀌면(새 서비스가 나타남 등) 연결을 가진 쪽도 다시 계산한다
        for (const l of this.links) if (changed.has(l.target)) changed.add(l.source);
        onChange([...changed]);
      });
      if (stop) stops.push(stop);
    }
    if (!stops.length) return null;
    return async () => {
      await Promise.all(stops.map((s) => s()));
    };
  }

  async lookup(collection: string, field: string, values: unknown[]): Promise<unknown[]> {
    const o = this.owner.get(collection);
    if (!o?.part.adapter.lookup) return [];
    return o.part.adapter.lookup(o.collection, field, values);
  }

  private inner(cmd: UpdateCommand): { part: CompositePart; cmd: UpdateCommand } {
    const o = this.route(cmd.collection);
    if (this.links.some((l) => l.source === cmd.collection && l.as in cmd.patch)) throw new UnsupportedCommandError('시스템 사이의 연결은 바꿀 수 없습니다');
    const strip = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !this.links.some((l) => l.source === cmd.collection && l.as === k)));
    return { part: o.part, cmd: { ...cmd, collection: o.collection, patch: strip(cmd.patch), before: strip(cmd.before) } };
  }

  describe(cmd: UpdateCommand): string {
    const { part, cmd: c } = this.inner(cmd);
    return `[${part.name}] ${part.adapter.describe(c)}`;
  }

  async execute(cmd: UpdateCommand): Promise<void> {
    const { part, cmd: c } = this.inner(cmd);
    await part.adapter.execute(c);
  }

  async close() {
    await Promise.all(this.parts.map((p) => p.adapter.close().catch(() => {})));
  }
}

function renameExpr(e: Expr, pre: (c: string) => string): Expr {
  switch (e.op) {
    case 'refExists':
      return { ...e, collection: pre(e.collection) };
    case 'and':
    case 'or':
      return { ...e, args: e.args.map((a) => renameExpr(a, pre)) };
    case 'not':
      return { ...e, arg: renameExpr(e.arg, pre) };
    case 'implies':
      return { ...e, if: renameExpr(e.if, pre), then: renameExpr(e.then, pre) };
    default:
      return e;
  }
}
