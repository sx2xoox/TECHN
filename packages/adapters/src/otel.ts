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
  /** 지금 시각(기록된 트레이스를 다시 재생할 때: 재생 시계). 기본 Date.now */
  now?: () => number;
  /** 서비스 지연(p90)의 한도: 평소(학습한 기준)의 몇 배까지 괜찮은가. 기본 LATENCY_FACTOR */
  latencyFactor?: number;
}

/** 지연 한도의 기본 배수(평소 p90 의 몇 배). RCAEval 의 Online Boutique 로만 정했다(다른 시스템은 손대지 않은 확인용) */
export const LATENCY_FACTOR = 3;
/** 오류 비율 한도: max(이 값, 평소의 3배) */
const ERROR_FLOOR = 0.05;
/** 기준을 세우기 전 관측 수(그동안은 기준 법칙을 판정하지 않는다) */
const WARMUP = 4;

/**
 * gRPC 의 전체 메서드 이름(`패키지.Service/Method`)에서 불린 서비스 이름. 계측되지 않은 서비스(캐시·DB·옛 서비스)를
 * 부르는 쪽의 클라이언트 스팬으로 알아보는 데 쓴다. 'hipstershop.CartService/GetCart' → 'cartservice'
 */
export function rpcPeer(spanName: string): string | null {
  const m = /^(?:[A-Za-z_]\w*\.)+([A-Z]\w*)\/[\w.]+$/.exec(spanName);
  return m ? m[1].toLowerCase() : null;
}
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/service$/, '');
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

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
  /** 통계용: 시간 창 안의 모든 스팬(세계에 보이는 것은 maxSpans 개뿐이지만, 비율·지연은 창 전체로 센다) */
  private window: SpanRec[] = [];
  /** 서비스마다 평소의 p90 지연·오류 비율(법칙을 지킨 관측만 쌓는다) */
  private baseline = new Map<string, { p90: number[]; err: number[]; at: number; last: { at: number; p90: number } | null }>();
  /** 부르는 쪽 → 불린 쪽 짝마다 평소의 클라이언트 p90(부르는 쪽 전체가 느려졌는지 알아보는 데) */
  private pairBase = new Map<string, { p90: number[]; at: number }>();
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
          this.window.push(rec);
          this.owner.set(rec.id, service);
          this.services.set(service, Math.max(this.services.get(service) ?? 0, rec.end));
          this.received++;
        }
      }
    }
    // 서비스도 무한히 늘지 않게: 오래 소식이 없는 서비스부터 지운다
    const maxServices = this.opts.maxServices ?? 200;
    if (this.services.size > maxServices) for (const [name] of [...this.services.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.services.size - maxServices)) this.services.delete(name);
    // 통계 창이 끝없이 커지지 않게(최근 것 위주로)
    if (this.window.length > 400_000) this.window = this.window.slice(-300_000);
    // 최근 것만 남긴다
    if (this.spans.size > max) for (const id of [...this.spans.values()].sort((a, b) => a.end - b.end).slice(0, this.spans.size - max).map((x) => x.id)) this.spans.delete(id);
    // 부모 스팬의 서비스 기억: 통계 창 전체를 덮어야 '받은 호출'·'부른 쪽' 을 바르게 가른다(창이 큰 시스템에서는 수십만 개)
    const ownerCap = Math.max(max * 20, 500_000);
    if (this.owner.size > ownerCap) for (const id of [...this.owner.keys()].slice(0, this.owner.size - ownerCap)) this.owner.delete(id);
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
      constraints: [
        { collection: 'services', expr: { op: 'cmp', field: 'status', cmp: '!=', value: 'failing' }, description: '서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태)', enforced: false },
        { collection: 'services', expr: { op: 'cmpField', field: 'error_ratio', cmp: '<=', other: 'error_limit' }, description: '오류 비율이 평소보다 크게 오르면 안 됨', enforced: false },
        { collection: 'services', expr: { op: 'cmpField', field: 'p90_latency_ms', cmp: '<=', other: 'latency_limit_ms' }, description: '지연(p90)이 평소보다 크게 늘면 안 됨', enforced: false },
      ],
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
            // 평소와 견주는 값: 최근 1분의 p90 지연·오류 비율과, 이 서비스의 평소에서 배운 한도(배우기 전에는 비어 있음 = 판정 안 함)
            { name: 'p90_latency_ms', type: 'number', nullable: false },
            { name: 'latency_limit_ms', type: 'number', nullable: true },
            { name: 'error_ratio', type: 'number', nullable: false },
            { name: 'error_limit', type: 'number', nullable: true },
            // false: 스스로 스팬을 보내지 않아 부르는 쪽의 기록으로만 아는 서비스(캐시·DB·계측 안 된 서비스)
            { name: 'instrumented', type: 'boolean', nullable: false },
            { name: 'last_seen_at', type: 'timestamp', nullable: false },
            // 이 서비스의 실패가 시작된 곳: 실패한 요청마다 오류가 난 가장 깊은 스팬의 서비스(자기 자신이면 null)
            { name: 'error_origin_id', type: 'string', nullable: true, ref: { collection: 'services', field: 'id', blame: true }, refEnforced: false },
            // 이 서비스가 느린 까닭: 느려진 요청에서 시간이 걸린 곳 — 한 곳을 부르는 호출만 평소보다 느리면 그 불린 서비스(자기 자신이면 null)
            { name: 'latency_origin_id', type: 'string', nullable: true, ref: { collection: 'services', field: 'id', blame: true }, refEnforced: false },
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
  private errorOrigins(recent: SpanRec[], peerOf: (s: SpanRec) => string | null): Map<string, string> {
    const children = new Map<string, SpanRec[]>();
    for (const s of recent) {
      if (!s.parentId) continue;
      const list = children.get(s.parentId);
      if (list) list.push(s);
      else children.set(s.parentId, [s]);
    }
    // 오류인 자식을 따라 가장 깊이. 오류인 자식이 없는 '다른 서비스를 부른 스팬' 이면 오류는 그 불린 쪽에서 났다
    // (불린 쪽이 계측되지 않았거나, 네트워크에서 끊겨 서버 스팬은 멀쩡한 경우)
    const deepest = (s: SpanRec, depth = 0): string => {
      if (depth > 64) return s.service;
      const bad = (children.get(s.id) ?? []).find((c) => c.status === 'error');
      if (bad) return deepest(bad, depth + 1);
      return peerOf(s) ?? s.service;
    };
    const tally = new Map<string, Map<string, number>>();
    for (const s of recent) {
      if (s.status !== 'error') continue;
      const entry = s.kind === 'server' || s.kind === 'consumer' || !s.parentId || this.owner.get(s.parentId) !== s.service;
      if (!entry) continue;
      const origin = deepest(s);
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

  /**
   * 평소와 견준 한도: 서비스마다 법칙을 지킨 관측의 p90 지연·오류 비율을 쌓아(최근 40번) 그 중앙값으로 한도를 정한다.
   * 장애 중의 값은 기준에 넣지 않는다(기준이 장애를 따라 올라가지 않게). 기준을 세우기 전과 호출이 너무 적을 때는 판정하지 않는다.
   */
  private judge(id: string, now: number, windowMs: number, latencyCalls: number, rawLatency: number, errorCalls: number, ratio: number) {
    const b = this.baseline.get(id) ?? { p90: [], err: [], at: -Infinity, last: null };
    this.baseline.set(id, b);
    // 지연은 '이어진' 값으로: 바로 앞 관측과 이번 관측 중 낮은 쪽(한 번 튄 느린 요청으로 경보가 울리지 않게 — 경보 규칙의 'for' 와 같은 뜻)
    const prev = b.last && now - b.last.at <= windowMs ? b.last.p90 : rawLatency;
    if (!b.last || now !== b.last.at) b.last = { at: now, p90: rawLatency };
    const latency = Math.min(prev, rawLatency);
    const calls = Math.max(latencyCalls, errorCalls);
    const ready = b.p90.length >= WARMUP && calls >= 5;
    const base = ready ? median(b.p90) : 0;
    // 지연은 호출이 10번은 있어야 판정한다(몇 번뿐인 p90 은 들쭉날쭉하다)
    const latencyLimit = ready && latencyCalls >= 10 ? Math.round(Math.max(base * (this.opts.latencyFactor ?? LATENCY_FACTOR), base + 10) * 10) / 10 : null;
    // 오류 한도에는 '최소 증거' 를 넣는다: 호출이 적은 서비스는 오류 한두 번으로 넘지 않게(오류 3번 몫)
    const errorLimit = ready && errorCalls >= 5 ? Math.round(Math.max(ERROR_FLOOR, median(b.err) * 3, 3 / errorCalls) * 1000) / 1000 : null;
    const ok = ratio < 0.5 && (latencyLimit === null || latency <= latencyLimit) && (errorLimit === null || ratio <= errorLimit);
    if (ok && calls >= 5 && now - b.at >= windowMs / 4) {
      b.p90.push(rawLatency);
      b.err.push(ratio);
      if (b.p90.length > 40) (b.p90.shift(), b.err.shift());
      b.at = now;
    }
    return { latency, latencyLimit, errorLimit, over: !ok, latencyOver: latencyLimit !== null && latency > latencyLimit };
  }

  async snapshot(only?: string[]): Promise<Snapshot> {
    const now = this.opts.now?.() ?? Date.now();
    const windowMs = this.opts.windowMs ?? 60_000;
    // 통계는 창 안의 모든 스팬으로(세계에 보이는 스팬 수와 상관없이)
    this.window = this.window.filter((s) => now - s.end <= windowMs);
    const recent = this.window.filter((s) => s.end <= now);
    const collections: Snapshot['collections'] = {};
    if (!only || only.includes('services')) {
      const instrumented = new Map([...this.services.keys()].map((n) => [normName(n), n]));
      // 다른 서비스를 부른 스팬이면 불린 서비스(계측된 서비스면 그 이름, 아니면 메서드 이름에서 알아낸 이름)
      // 다른 서비스의 자식 스팬이 있으면 그 서비스가 불린 쪽이다(이름 규칙과 상관없이 — HTTP 든 gRPC 든)
      const crossChild = new Map<string, string>();
      for (const s of recent) {
        if (!s.parentId || crossChild.has(s.parentId)) continue;
        const parentService = this.owner.get(s.parentId);
        if (parentService && parentService !== s.service) crossChild.set(s.parentId, s.service);
      }
      const peerOf = (s: SpanRec): string | null => {
        const child = crossChild.get(s.id);
        if (child) return child;
        const p = rpcPeer(s.name);
        if (!p || normName(p) === normName(s.service)) return null;
        return instrumented.get(normName(p)) ?? p;
      };
      const entryOf = (s: SpanRec) => s.kind === 'server' || s.kind === 'consumer' || !s.parentId || this.owner.get(s.parentId) !== s.service;
      const origins = this.errorOrigins(recent, peerOf);
      // 부르는 쪽에서 본 이 서비스(클라이언트 스팬): 서버 스팬은 멀쩡해도 부르는 쪽에서는 실패할 수 있다(처리 전 거절·끊김·재시작)
      const callsTo = new Map<string, SpanRec[]>();
      for (const s of recent) {
        if (entryOf(s)) continue;
        const p = peerOf(s);
        if (!p) continue;
        const list = callsTo.get(p);
        if (list) list.push(s);
        else callsTo.set(p, [s]);
      }
      // 부르는 쪽 전체가 느려졌는가: 한 서비스가 부르는 곳 둘 이상이 한꺼번에 평소보다 느리면 그 서비스 자신이 느린 것이다
      // (CPU·메모리가 모자란 서비스는 모든 바깥 호출이 느려 보인다). 그런 부르는 쪽의 스팬은 불린 쪽의 지연 판정에 쓰지 않는다
      const slowCallers = new Set<string>();
      /** 부르는 쪽마다 평소보다 느려진 호출(불린 서비스와 한도에 대한 비율) — 지연이 비롯된 곳을 고르는 데 */
      const slowCalls = new Map<string, { callee: string; ratio: number }[]>();
      const byCaller = new Map<string, Map<string, number[]>>();
      for (const [callee, xs] of callsTo) {
        for (const x of xs) {
          const m = byCaller.get(x.service) ?? new Map<string, number[]>();
          byCaller.set(x.service, m);
          const d = m.get(callee);
          if (d) d.push(x.end - x.start);
          else m.set(callee, [x.end - x.start]);
        }
      }
      for (const [caller, m] of byCaller) {
        let slow = 0;
        let judged = 0;
        for (const [callee, ds] of m) {
          if (ds.length < 5) continue;
          const key = `${caller}>${callee}`;
          const pb = this.pairBase.get(key) ?? { p90: [], at: -Infinity };
          this.pairBase.set(key, pb);
          const now90 = p90(ds);
          const pairLimit = Math.max(median(pb.p90) * (this.opts.latencyFactor ?? LATENCY_FACTOR), median(pb.p90) + 10);
          const over = pb.p90.length >= WARMUP && now90 > pairLimit;
          if (pb.p90.length >= WARMUP) judged++;
          if (over) {
            slow++;
            slowCalls.set(caller, [...(slowCalls.get(caller) ?? []), { callee, ratio: now90 / pairLimit }]);
          }
          else if (now - pb.at >= windowMs / 4) {
            pb.p90.push(now90);
            if (pb.p90.length > 40) pb.p90.shift();
            pb.at = now;
          }
        }
        if (slow >= 2 && slow >= judged * 0.6) slowCallers.add(caller);
      }
      const view = (xs: SpanRec[]) => ({ n: xs.length, errors: xs.filter((s) => s.status === 'error').length, p90: p90(xs.map((s) => s.end - s.start)) });
      const row = (name: string, mine: SpanRec[], last: number, isInstrumented: boolean): Row => {
        // 안에서 본 값과 부르는 쪽에서 본 값 중 나쁜 쪽(바깥에서 본 건강이 실제 사용자가 겪는 것)
        const own = view(mine);
        const outsideAll = isInstrumented ? callsTo.get(name) ?? [] : [];
        const outside = view(outsideAll);
        // 지연은 '부르는 쪽 전체가 느려진' 곳의 스팬을 빼고 본다(오류는 그대로 센다)
        const outsideLatency = view(outsideAll.filter((x) => !slowCallers.has(x.service)));
        const ratioOf = (v: { n: number; errors: number }) => (v.n >= 5 ? v.errors / v.n : 0);
        const useOutside = outside.n >= 5 && ratioOf(outside) > ratioOf(own);
        const errors = useOutside ? outside.errors : own.errors;
        const calls = useOutside ? outside.n : own.n;
        const ratio = calls ? errors / calls : 0;
        const latency = Math.round(Math.max(own.p90, outsideLatency.n >= 10 ? outsideLatency.p90 : 0) * 10) / 10;
        const j = this.judge(name, now, windowMs, Math.max(own.n, outside.n), latency, calls, ratio);
        return {
          id: name,
          name,
          status: ratio >= 0.5 ? 'failing' : ratio > 0 || j.over ? 'degraded' : 'healthy',
          calls_per_min: Math.round((mine.length * 60_000) / windowMs),
          error_count: errors,
          avg_latency_ms: mine.length ? Math.round(mine.reduce((a, s) => a + (s.end - s.start), 0) / mine.length) : 0,
          p90_latency_ms: j.latency,
          latency_limit_ms: j.latencyLimit,
          error_ratio: Math.round(ratio * 1000) / 1000,
          error_limit: j.errorLimit,
          instrumented: isInstrumented,
          last_seen_at: new Date(last).toISOString(),
          error_origin_id: origins.get(name) ?? null,
          // 이 서비스가 지연 한도를 넘었고, 그 사이 한 곳(들)을 부르는 호출만 평소보다 느리면 그중 가장 많이 느려진 곳.
          // 부르는 곳 대부분이 한꺼번에 느리면(이 서비스 자신이 느린 것) 비워 둔다
          latency_origin_id: j.latencyOver && isInstrumented && !slowCallers.has(name) ? [...(slowCalls.get(name) ?? [])].sort((a, b) => b.ratio - a.ratio)[0]?.callee ?? null : null,
        };
      };
      // 서비스가 '받은' 호출: 서버·소비자 스팬, 없으면 그 서비스의 루트 스팬
      const rows = [...this.services.entries()].map(([name, last]) => row(name, recent.filter((s) => s.service === name && entryOf(s)), last, true));
      // 계측되지 않은 서비스: 부르는 쪽의 클라이언트 스팬으로(오류·지연은 부르는 쪽에서 본 값)
      for (const [name, calls] of callsTo) if (!this.services.has(name)) rows.push(row(name, calls, calls.reduce((a, c) => Math.max(a, c.end), 0), false));
      collections.services = rows;
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
