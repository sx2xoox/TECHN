import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { markSensitive, readOnlyExcept, type Row, type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { decodeOtlpTraces } from './otel-proto.ts';
import { UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * OpenTelemetry 트레이스 어댑터: OTLP/HTTP(JSON) 수신기.
 *  - 서비스(service.name)마다 건물 하나: 분당 호출(인파), 오류 수(불길), 평균 지연(걸음), 상태(색)
 *  - 최근 스팬마다 주민 하나: 부른 서비스 → 불린 서비스로 걷는다(부모 스팬의 서비스가 다르면 그쪽이 '부른 쪽')
 * 읽기 전용이다(트레이스는 지나간 사건의 기록이므로 세계에서 바꿀 것이 없다).
 *
 * 보내는 쪽 설정 예: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces (http/json 과 http/protobuf 모두 받는다)
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
  /**
   * 수신 토큰: 보내는 쪽이 `authorization: Bearer <토큰>` 을 실어야 받는다(OTEL_EXPORTER_OTLP_HEADERS).
   * 바깥 주소(0.0.0.0 등)로 들을 때는 필수다. 운영자 토큰과는 다른 값을 쓰자(계측된 앱이 세계를 조작할 권한을 갖지 않게).
   */
  token?: string;
  /** 기억할 서비스 수 상한 */
  maxServices?: number;
}

const LOOPBACK = /^(localhost|::1|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

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
    const host = this.opts.host ?? '127.0.0.1';
    if (!LOOPBACK.test(host) && !this.opts.token) throw new Error(`OTLP 수신기를 바깥 주소(${host})로 열려면 수신 토큰이 필요합니다(ISOMORPH_OTLP_TOKEN).`);
    const expected = this.opts.token ? Buffer.from(`Bearer ${this.opts.token}`) : null;
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/traces')) {
        res.writeHead(404).end();
        return;
      }
      if (expected) {
        const got = Buffer.from(String(req.headers.authorization ?? ''));
        if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '수신 토큰이 필요합니다' }));
          return;
        }
      }
      // 받는 형식: application/json 또는 application/x-protobuf 만(둘 다 다른 사이트의 '단순 요청' 으로는 보낼 수 없다)
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json' && type !== 'application/x-protobuf') {
        res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'OTLP/HTTP 의 JSON(application/json) 또는 protobuf(application/x-protobuf) 만 받습니다' }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 20_000_000) return req.destroy();
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          if (type === 'application/x-protobuf') {
            this.ingest(decodeOtlpTraces(body) as OtlpRequest);
            // 빈 ExportTraceServiceResponse = 0 바이트
            res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
          } else {
            this.ingest(JSON.parse(body.toString('utf8')) as OtlpRequest);
            res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          }
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
    // 서비스도 무한히 늘지 않게: 오래 소식이 없는 서비스부터 지운다
    const maxServices = this.opts.maxServices ?? 200;
    if (this.services.size > maxServices) for (const [name] of [...this.services.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.services.size - maxServices)) this.services.delete(name);
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
    // 트레이스는 지나간 사건: 세계에서 바꿀 것이 없다
    return readOnlyExcept(markSensitive({
      system: this.system,
      source: 'custom',
      // 수신기가 계산한 건강 상태를 법칙으로: 최근 1분 오류 비율이 절반 이상이면 '실패'
      constraints: [{ collection: 'services', expr: { op: 'cmp', field: 'status', cmp: '!=', value: 'failing' }, description: '서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태)', enforced: false }],
      collections: [
        {
          name: 'services',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string', nullable: false, joinKey: 'service' },
            { name: 'name', type: 'string', nullable: false },
            { name: 'status', type: 'string', nullable: false, enumValues: ['healthy', 'degraded', 'failing'] },
            { name: 'calls_per_min', type: 'integer', nullable: false },
            { name: 'error_count', type: 'integer', nullable: false },
            { name: 'avg_latency_ms', type: 'number', nullable: false },
            { name: 'last_seen_at', type: 'timestamp', nullable: false },
            // 이 서비스의 실패가 시작된 곳: 실패한 요청마다 오류가 난 가장 깊은 스팬의 서비스(자기 자신이면 null)
            { name: 'error_origin_id', type: 'string', nullable: true, ref: { collection: 'services', field: 'id', blame: true }, refEnforced: false },
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
    }), []);
  }

  /**
   * 서비스마다 '실패가 시작된 곳': 그 서비스가 받은 실패한 요청에서, 오류 상태인 자식을 따라 가장 깊이 내려간 스팬의 서비스.
   * 실패의 절반 이상이 같은 다른 서비스에서 시작됐으면 그 서비스, 아니면(스스로 실패) 없음.
   */
  private errorOrigins(recent: SpanRec[]): Map<string, string> {
    const children = new Map<string, SpanRec[]>();
    for (const s of this.spans.values()) {
      if (!s.parentId) continue;
      const list = children.get(s.parentId);
      if (list) list.push(s);
      else children.set(s.parentId, [s]);
    }
    const deepest = (s: SpanRec, depth = 0): SpanRec => {
      if (depth > 64) return s;
      const bad = (children.get(s.id) ?? []).find((c) => c.status === 'error');
      return bad ? deepest(bad, depth + 1) : s;
    };
    const tally = new Map<string, Map<string, number>>();
    for (const s of recent) {
      if (s.status !== 'error') continue;
      const entry = s.kind === 'server' || s.kind === 'consumer' || !s.parentId || this.owner.get(s.parentId) !== s.service;
      if (!entry) continue;
      const origin = deepest(s).service;
      const t = tally.get(s.service) ?? new Map<string, number>();
      t.set(origin, (t.get(origin) ?? 0) + 1);
      tally.set(s.service, t);
    }
    const out = new Map<string, string>();
    for (const [svc, t] of tally) {
      const total = [...t.values()].reduce((a, b) => a + b, 0);
      const [top, n] = [...t.entries()].filter(([o]) => o !== svc).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      if (top && n * 2 >= total) out.set(svc, top);
    }
    return out;
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    const now = Date.now();
    const windowMs = this.opts.windowMs ?? 60_000;
    const recent = [...this.spans.values()].filter((s) => now - s.end <= windowMs);
    const collections: Snapshot['collections'] = {};
    if (!only || only.includes('services')) {
      const origins = this.errorOrigins(recent);
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
          error_origin_id: origins.get(name) ?? null,
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
