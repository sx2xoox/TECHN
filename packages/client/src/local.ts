import {
  applyEvents,
  buildInspect,
  learnModel,
  observe,
  sanitizeHypothesis,
  simulateAsync,
  suggestHypotheses,
  type ChangeEvent,
  type ClientMessage,
  type HelloMessage,
  type ServerMessage,
  type Snapshot,
  type SystemSchema,
  type TimelineMarker,
} from '@isomorph/core';

/** 서버가 HTML 에 끼워 넣은 공유본 자료(packages/server/src/snapshot.ts 의 WorldBundle) */
export interface WorldBundle {
  version: 1;
  createdAt: number;
  hello: HelloMessage;
  schema: SystemSchema;
  base: Snapshot;
  events: ChangeEvent[];
  start: number;
  end: number;
  markers: TimelineMarker[];
}

export function embeddedBundle(): WorldBundle | null {
  const el = document.getElementById('isomorph-snapshot');
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as WorldBundle;
  } catch {
    return null;
  }
}

/**
 * 브라우저 안의 작은 서버: 공유본 자료만으로 실제 서버와 같은 메시지에 답한다.
 * 살펴보기·시간 여행·가설 실험실은 되고, 시스템을 바꾸는 행동은 모두 거절한다(보기 전용).
 */
export class LocalServer {
  private seekTs: number | null = null;
  private simulating = false;

  constructor(
    private b: WorldBundle,
    private onMessage: (m: ServerMessage) => void,
  ) {}

  private snapshotAt(ts: number): Snapshot {
    const snap = applyEvents(this.b.base, this.b.events.filter((e) => e.ts <= ts), this.b.schema, ts);
    return this.b.base.outside ? { ...snap, outside: this.b.base.outside } : snap;
  }

  private worldAt(ts: number) {
    return observe(this.snapshotAt(ts), this.b.hello.grammar, this.b.schema);
  }

  connect() {
    const emit = this.onMessage;
    emit(this.b.hello);
    emit({ type: 'timeline', start: this.b.start, end: this.b.end, markers: this.b.markers });
    emit({ type: 'world', mode: 'live', world: this.worldAt(this.b.end) });
    emit({ type: 'actions', actions: [] });
  }

  send(m: ClientMessage) {
    // 화면 갱신 흐름이 실제 서버와 같도록 다음 틱에 답한다
    queueMicrotask(() => void this.handle(m));
  }

  private async handle(m: ClientMessage) {
    const emit = this.onMessage;
    const readOnly = () => emit({ type: 'toast', level: 'info', message: '공유본은 보기 전용입니다. 시스템을 바꾸려면 원래의 세계에서 하세요.' });
    switch (m.type) {
      case 'inspect': {
        const ts = this.seekTs ?? this.b.end;
        const events = this.b.events.filter((e) => e.ts <= ts && e.ts >= ts - 10 * 60_000);
        emit(buildInspect({ snapshot: this.snapshotAt(ts), grammar: this.b.hello.grammar, schema: this.b.schema, events, entityId: m.entityId, writeMode: 'read-only', history: this.seekTs !== null }));
        return;
      }
      case 'seek': {
        const ts = Math.max(this.b.start, Math.min(this.b.end, m.ts));
        this.seekTs = ts;
        emit({ type: 'world', mode: 'history', world: this.worldAt(ts) });
        return;
      }
      case 'live':
        this.seekTs = null;
        emit({ type: 'world', mode: 'live', world: this.worldAt(this.b.end) });
        return;
      case 'lab': {
        const model = learnModel(this.b.base, this.b.events, this.b.schema);
        const world = this.worldAt(this.b.end);
        const labelOf = (c: string, pk: unknown) => world.entities.find((e) => e.source.collection === c && String(e.source.pk) === String(pk))?.label ?? `${c} #${pk}`;
        emit({ type: 'lab', model, hypotheses: suggestHypotheses(model, this.snapshotAt(this.b.end), this.b.schema, labelOf) });
        return;
      }
      case 'simulate': {
        if (this.simulating) return;
        this.simulating = true;
        try {
          const h = sanitizeHypothesis(m.hypothesis, this.b.schema);
          const model = learnModel(this.b.base, this.b.events, this.b.schema);
          const result = await simulateAsync(this.snapshotAt(this.b.end), model, h, this.b.hello.grammar, this.b.schema, {
            runs: 60,
            frameMs: Math.max(250, Math.round(h.horizonMs / 80)),
            onProgress: (done, total) => emit({ type: 'simulation-progress', hypothesisId: h.id, done, total }),
          });
          emit({ type: 'simulation', result });
        } finally {
          this.simulating = false;
        }
        return;
      }
      default:
        readOnly();
    }
  }
}
