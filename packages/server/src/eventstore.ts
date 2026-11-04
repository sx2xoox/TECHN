import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyEvents, type ChangeEvent, type Pk, type Snapshot, type SystemSchema } from '@isomorph/core';

/**
 * 이벤트 소싱 저장소(SQLite). 모든 상태 변화를 행 단위 이벤트로 남기고,
 * 주기적인 키프레임 + 이벤트 재생으로 과거 어느 시점의 스냅샷이든 복원한다(Time Scrubber).
 */
export class EventStore {
  private db: DatabaseSync;
  private ticks = 0;

  constructor(file = ':memory:', private keyframeEvery = 40, private retentionMs = 30 * 60_000) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists keyframes (ts integer primary key, snapshot text not null);
      create table if not exists events (
        id integer primary key autoincrement,
        ts integer not null, collection text not null, pk text not null, kind text not null,
        before text, after text
      );
      create index if not exists events_ts on events(ts);
      create index if not exists events_row on events(collection, pk, ts);
    `);
  }

  /** 한 틱의 결과를 기록한다. 첫 틱과 N틱마다 키프레임. */
  record(snapshot: Snapshot, events: ChangeEvent[]): void {
    const insert = this.db.prepare('insert into events (ts, collection, pk, kind, before, after) values (?, ?, ?, ?, ?, ?)');
    this.db.exec('begin');
    try {
      for (const e of events) {
        insert.run(e.ts, e.collection, JSON.stringify(e.pk), e.kind, e.before ? JSON.stringify(e.before) : null, e.after ? JSON.stringify(e.after) : null);
      }
      if (this.ticks % this.keyframeEvery === 0) {
        this.db.prepare('insert or replace into keyframes (ts, snapshot) values (?, ?)').run(snapshot.ts, JSON.stringify(snapshot));
      }
      this.db.exec('commit');
    } catch (e) {
      this.db.exec('rollback');
      throw e;
    }
    this.ticks++;
    if (this.ticks % 200 === 0) this.prune(snapshot.ts - this.retentionMs);
  }

  private rowToEvent(r: Record<string, unknown>): ChangeEvent {
    return {
      ts: Number(r.ts),
      collection: String(r.collection),
      pk: JSON.parse(String(r.pk)) as Pk,
      kind: r.kind as ChangeEvent['kind'],
      before: r.before ? JSON.parse(String(r.before)) : null,
      after: r.after ? JSON.parse(String(r.after)) : null,
    };
  }

  eventsBetween(from: number, to: number): ChangeEvent[] {
    return this.db.prepare('select * from events where ts > ? and ts <= ? order by id').all(from, to).map((r) => this.rowToEvent(r as Record<string, unknown>));
  }

  snapshotAt(ts: number, schema: SystemSchema): Snapshot | null {
    const kf = this.db.prepare('select ts, snapshot from keyframes where ts <= ? order by ts desc limit 1').get(ts) as { ts: number; snapshot: string } | undefined;
    if (!kf) return null;
    const base = JSON.parse(kf.snapshot) as Snapshot;
    return applyEvents(base, this.eventsBetween(kf.ts, ts), schema, ts);
  }

  range(): { start: number; end: number } | null {
    const r = this.db.prepare('select min(ts) as start from keyframes').get() as { start: number | null };
    const e = this.db.prepare('select max(ts) as end from (select max(ts) as ts from keyframes union all select max(ts) as ts from events)').get() as { end: number | null };
    if (r.start === null || e.end === null) return null;
    return { start: Number(r.start), end: Number(e.end) };
  }

  /** 보존 기간 밖 데이터 정리. 남는 가장 오래된 이벤트 이전 키프레임은 하나 남긴다. */
  prune(before: number): void {
    const keep = this.db.prepare('select max(ts) as ts from keyframes where ts <= ?').get(before) as { ts: number | null };
    if (keep.ts === null) return;
    this.db.prepare('delete from keyframes where ts < ?').run(keep.ts);
    this.db.prepare('delete from events where ts <= ?').run(keep.ts);
  }

  close() {
    this.db.close();
  }
}
