import http from 'node:http';
import { markSensitive, type Row, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * OpenTelemetry 트레이스 어댑터: OTLP/HTTP(JSON) 수신기.
 *  - 서비스(service.name)마다 건물 하나: 분당 호출(인파), 오류 수(불길), 평균 지연(걸음), 상태(색)
 *  - 최근 스팬마다 주민 하나: 부른 서비스 → 불린 서비스로 걷는다(부모 스팬의 서비스가 다르면 그쪽이 '부른 쪽')
 * 읽기 전용이다(트레이스는 지나간 사건의 기록이므로 세계에서 바꿀 것이 없다).
 *
 * 보내는 쪽 설정 예: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces, OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 */
export interface OtelAdapterOptions {
  /** 수신 포트(OTLP/HTTP 표준은 4318). 0 이면 빈 포트 */
  port?: number;
  host?: string;
  system?: string;
  /** 세계에 남겨 둘 최근 스팬 수 */
  maxSpans?: number;
  /** 분당 호출·오류·평균 지연을 셀 시간 창 */
  windowMs?: number;
}

interface SpanRec {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  service: string;
  kind: string;
  status: 'ok' | 'error' | 'unset';
  start: number;
  end: number;
}

type AnyValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number };
interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  status?: { code?: number | string; message?: string };
}
interface OtlpRequest {
  resourceSpans?: { resource?: { attributes?: { key: string; value: AnyValue }[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const nanosToMs = (v: string | number | undefined) => (v === undefined ? 0 : Number(BigInt(String(v)) / 1_000_000n));

export class OtelAdapter implements Adapter {
  readonly kind = 'custom' as const;
  readonly system: string;
  private server: http.Server | null = null;
  private spans = new Map<string, SpanRec>();
  /** 부모 스팬의 서비스를 찾기 위한 더 긴 기억(스팬 id → 서비스) */
  private owner = new Map<string, string>();
  private services = new Map<string, number>();
  private listeners = new Set<(c: string[]) => void>();
  private notifyTimer: NodeJS.Timeout | null = null;
  received = 0;

  constructor(private opts: OtelAdapterOptions = {}) {
    this.system = opts.system ?? 'otel';
  }

  get port(): number {
    const a = this.server?.address();
    return typeof a === 'object' && a ? a.port : this.opts.port ?? 4318;
  }

  get endpoint() {
    return `http://${this.opts.host ?? '127.0.0.1'}:${this.port}/v1/traces`;
  }

  async connect() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/traces')) {
        res.writeHead(404).end();
        return;
      }
      if (!String(req.headers['content-type'] ?? '').includes('json')) {
        res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'OTLP JSON 만 받습니다(OTEL_EXPORTER_OTLP_PROTOCOL=http/json)' }));
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 20_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          this.ingest(JSON.parse(body) as OtlpRequest);
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port ?? 4318, this.opts.host ?? '127.0.0.1', () => resolve());
    });
  }

  /** OTLP 요청 하나를 받아들인다(테스트·다른 수신기에서 직접 불러도 된다) */
  ingest(req: OtlpRequest) {
    const max = this.opts.maxSpans ?? 300;
    for (const rs of req.resourceSpans ?? []) {
      const service = rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value.stringValue ?? 'unknown_service';
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          if (!s.spanId) continue;
          const code = Number(s.status?.code ?? 0) || (String(s.status?.code).includes('ERROR') ? 2 : String(s.status?.code).includes('OK') ? 1 : 0);
          const rec: SpanRec = {
            id: s.spanId,
            traceId: s.traceId ?? '',
            parentId: s.parentSpanId || null,
            name: s.name ?? '',
            service,
            kind: typeof s.kind === 'number' ? KINDS[s.kind] ?? 'unspecified' : String(s.kind ?? 'unspecified').replace(/^SPAN_KIND_/, '').toLowerCase(),
            status: code === 2 ? 'error' : code === 1 ? 'ok' : 'unset',
            start: nanosToMs(s.startTimeUnixNano),
            end: nanosToMs(s.endTimeUnixNano),
          };
          this.spans.set(rec.id, rec);
          this.owner.set(rec.id, service);
          this.services.set(service, Math.max(this.services.get(service) ?? 0, rec.end));
          this.received++;
        }
      }
    }
    // 최근 것만 남긴다
    if (this.spans.size > max) for (const id of [...this.spans.values()].sort((a, b) => a.end - b.end).slice(0, this.spans.size - max).map((x) => x.id)) this.spans.delete(id);
    if (this.owner.size > max * 20) for (const id of [...this.owner.keys()].slice(0, this.owner.size - max * 20)) this.owner.delete(id);
    if (this.listeners.size && !this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        for (const l of this.listeners) l(['services', 'spans']);
      }, 30);
    }
  }

  async introspect(): Promise<SystemSchema> {
    return markSensitive({
      system: this.system,
      source: 'custom',
      constraints: [],
      collections: [
        {
          name: 'services',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'name', type: 'string', nullable: false },
            { name: 'status', type: 'string', nullable: false, enumValues: ['healthy', 'degraded', 'failing'] },
            { name: 'calls_per_min', type: 'integer', nullable: false },
            { name: 'error_count', type: 'integer', nullable: false },
            { name: 'avg_latency_ms', type: 'number', nullable: false },
            { name: 'last_seen_at', type: 'timestamp', nullable: false },
          ],
        },
        {
          name: 'spans',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'trace_id', type: 'string', nullable: false },
            { name: 'name', type: 'string', nullable: false },
            // 순서가 곧 걷는 방향: 부른 서비스 → 불린 서비스
            { name: 'caller_id', type: 'string', nullable: true, ref: { collection: 'services', field: 'id' }, refEnforced: true },
            { name: 'service_id', type: 'string', nullable: false, ref: { collection: 'services', field: 'id' }, refEnforced: true },
            { name: 'kind', type: 'string', nullable: false, enumValues: ['server', 'client', 'internal', 'producer', 'consumer', 'unspecified'] },
            { name: 'status', type: 'string', nullable: false, enumValues: ['ok', 'error', 'unset'] },
            { name: 'duration_ms', type: 'number', nullable: false },
            { name: 'created_at', type: 'timestamp', nullable: false },
            { name: 'ended_at', type: 'timestamp', nullable: false },
          ],
        },
      ],
    });
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    const now = Date.now();
    const windowMs = this.opts.windowMs ?? 60_000;
    const recent = [...this.spans.values()].filter((s) => now - s.end <= windowMs);
    const collections: Snapshot['collections'] = {};
    if (!only || only.includes('services')) {
      collections.services = [...this.services.entries()].map(([name, last]): Row => {
        // 서비스가 '받은' 호출: 서버·소비자 스팬, 없으면 그 서비스의 루트 스팬
        const mine = recent.filter((s) => s.service === name && (s.kind === 'server' || s.kind === 'consumer' || !s.parentId || this.owner.get(s.parentId) !== name));
        const errors = mine.filter((s) => s.status === 'error').length;
        const ratio = mine.length ? errors / mine.length : 0;
        return {
          id: name,
          name,
          status: ratio >= 0.5 ? 'failing' : ratio > 0 ? 'degraded' : 'healthy',
          calls_per_min: Math.round((mine.length * 60_000) / windowMs),
          error_count: errors,
          avg_latency_ms: mine.length ? Math.round(mine.reduce((a, s) => a + (s.end - s.start), 0) / mine.length) : 0,
          last_seen_at: new Date(last).toISOString(),
        };
      });
    }
    if (!only || only.includes('spans')) {
      collections.spans = [...this.spans.values()].map((s): Row => {
        const parentService = s.parentId ? this.owner.get(s.parentId) : undefined;
        return {
          id: s.id,
          trace_id: s.traceId,
          name: s.name,
          service_id: s.service,
          caller_id: parentService && parentService !== s.service ? parentService : null,
          kind: s.kind,
          status: s.status,
          duration_ms: Math.max(0, s.end - s.start),
          created_at: new Date(s.start).toISOString(),
          ended_at: new Date(s.end).toISOString(),
        };
      });
    }
    return { ts: now, collections };
  }

  async watch(onChange: (collections: string[]) => void) {
    this.listeners.add(onChange);
    return async () => {
      this.listeners.delete(onChange);
    };
  }

  describe(cmd: UpdateCommand) {
    return `(트레이스는 읽기 전용) ${cmd.collection}#${cmd.pk}`;
  }

  async execute(): Promise<void> {
    throw new UnsupportedCommandError('OpenTelemetry 트레이스는 읽기 전용입니다');
  }

  async close() {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
