import { readOnlyExcept, type Row, type Snapshot, type SystemSchema } from '@isomorph/core';
import { UnsupportedCommandError, type Adapter } from './types.ts';

/**
 * 서비스 지표(Prometheus 등) → 세계. 트레이스가 없는 시스템도 '평소와 견주는 법칙' 으로 본다.
 *  - 지표는 서비스마다 숫자 하나씩: CPU·메모리·지연·오류·디스크… (이름은 자유)
 *  - 법칙: '높을수록 나쁜' 지표마다 '평소보다 크게 오르면 안 됨'. 한도 = max(평소 × factor, 평소 + 4×MAD, 평소 가장 높았던 값 × 1.5).
 *    평소(중앙값)·MAD 는 법칙을 지킨 관측만 쌓아 배우고(최근 40번), 기준을 세우기 전(4번)에는 판정하지 않는다.
 *    판정 값은 '바로 앞 관측과 이번 관측 중 낮은 쪽'(한 번 튄 값으로 울리지 않게 — 경보 규칙의 for).
 *  - 처리량(요청 수 등)은 높다고 나쁜 것이 아니라 법칙에서 뺀다(보여 주기만).
 *  - 서비스 사이의 호출 관계는 지표로는 모른다: 근본 원인 사슬은 만들지 않고, 먼저 법칙을 어긴 곳이 장애 기록의 근본 원인이 된다.
 * 실시간: Prometheus HTTP API(`/api/v1/query`)에 지표마다 PromQL 을 묻는다(결과 벡터의 `by` 라벨 = 서비스).
 * 재생·밀어 넣기: ingest(시각, { 서비스: { 지표: 값 } }).
 */
export interface MetricsAdapterOptions {
  system?: string;
  /** Prometheus 주소(예: http://prometheus:9090). 없으면 ingest 로만 받는다 */
  url?: string;
  /** 지표 이름 → PromQL(서비스마다 값 하나인 순간 벡터) */
  queries?: Record<string, string>;
  /** 결과 벡터에서 서비스 이름이 든 라벨(기본 service) */
  by?: string;
  /** Prometheus 앞의 인증(Bearer) */
  token?: string;
  /** 법칙으로 판정하지 않을 지표(정규식). 기본: 처리량 */
  ignore?: RegExp;
  /** 한도 배수(기본 3) */
  factor?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * 기본 질의: 쿠버네티스에서 흔한 cAdvisor 컨테이너 지표(컨테이너 이름 = 서비스). 다른 지표 이름이면 설정의 queries 로 바꾼다.
 * 지연·오류는 계측 방식마다 이름이 달라 기본값에 넣지 않았다(설정에 PromQL 로 더한다).
 */
export const PROMETHEUS_DEFAULTS: Record<string, string> = {
  cpu: 'sum by (container) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[1m]))',
  mem: 'sum by (container) (container_memory_working_set_bytes{container!="",container!="POD"})',
  restarts: 'sum by (container) (increase(kube_pod_container_status_restarts_total[5m]))',
};

const WARMUP = 4;
const HISTORY = 60;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mad = (xs: number[]) => {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};
/** 지표 이름을 필드 이름으로(소문자·밑줄) */
export const metricField = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export class MetricsAdapter implements Adapter {
  readonly kind = 'custom' as const;
  readonly system: string;
  private latest = new Map<string, Map<string, number>>();
  private metrics = new Set<string>();
  private base = new Map<string, { values: number[]; times: number[]; at: number; last: { at: number; value: number } | null; episode: { start: number; peak: number } | null }>();
  private schema: SystemSchema | null = null;

  constructor(private opts: MetricsAdapterOptions = {}) {
    this.system = opts.system ?? 'metrics';
    for (const m of Object.keys(opts.queries ?? {})) this.metrics.add(metricField(m));
  }

  private judged(m: string) {
    return !(this.opts.ignore ?? /workload|throughput|requests?|rate|qps|rps|count/i).test(m);
  }

  /** 서비스마다 지표 값을 넣는다(재생·밀어 넣기). 처음 보는 지표면 스키마가 바뀐다(다시 introspect) */
  ingest(samples: Record<string, Record<string, number>>) {
    for (const [service, values] of Object.entries(samples)) {
      const m = this.latest.get(service) ?? new Map<string, number>();
      this.latest.set(service, m);
      for (const [k, v] of Object.entries(values)) {
        if (!Number.isFinite(v)) continue;
        const f = metricField(k);
        if (!this.metrics.has(f)) {
          this.metrics.add(f);
          this.schema = null;
        }
        m.set(f, v);
      }
    }
  }

  async connect() {
    if (this.opts.url) await this.pull();
  }

  private async pull() {
    const f = this.opts.fetchImpl ?? fetch;
    const by = this.opts.by ?? 'service';
    for (const [name, q] of Object.entries(this.opts.queries ?? {})) {
      const r = await f(`${this.opts.url!.replace(/\/$/, '')}/api/v1/query?query=${encodeURIComponent(q)}`, { headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {} });
      if (!r.ok) throw new Error(`Prometheus 질의 실패(${name}): HTTP ${r.status}`);
      const body = (await r.json()) as { status: string; data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] } };
      if (body.status !== 'success' || body.data?.resultType !== 'vector') throw new Error(`Prometheus 질의(${name})는 순간 벡터를 돌려줘야 합니다`);
      const samples: Record<string, Record<string, number>> = {};
      for (const x of body.data.result) {
        const svc = x.metric[by];
        if (svc) samples[svc] = { [name]: Number(x.value[1]) };
      }
      this.ingest(samples);
    }
  }

  async introspect(): Promise<SystemSchema> {
    if (this.schema) return this.schema;
    const ms = [...this.metrics].sort();
    const judged = ms.filter((m) => this.judged(m));
    this.schema = readOnlyExcept(
      {
        system: this.system,
        source: 'custom',
        constraints: judged.map((m) => ({ collection: 'services', expr: { op: 'cmpField' as const, field: m, cmp: '<=' as const, other: `${m}_limit` }, description: `${m} 이(가) 평소보다 크게 오르면 안 됨`, enforced: false })),
        collections: [
          {
            name: 'services',
            primaryKey: 'id',
            fields: [
              { name: 'id', type: 'string', nullable: false, joinKey: 'service' },
              { name: 'name', type: 'string', nullable: false },
              { name: 'status', type: 'string', nullable: false, enumValues: ['healthy', 'degraded'] },
              ...ms.flatMap((m) => [{ name: m, type: 'number' as const, nullable: true }, ...(this.judged(m) ? [{ name: `${m}_limit`, type: 'number' as const, nullable: true }] : [])]),
            ],
          },
        ],
      },
      [],
    );
    return this.schema;
  }

  /** 평소와 견준 한도와, 판정에 쓰는 '이어진' 값 */
  private judge(key: string, value: number, now: number) {
    const b = this.base.get(key) ?? { values: [], times: [], at: -Infinity, last: null, episode: null };
    this.base.set(key, b);
    const prev = b.last && now - b.last.at <= 120_000 ? b.last.value : value;
    if (!b.last || now !== b.last.at) b.last = { at: now, value };
    const sustained = Math.min(prev, value);
    const ready = b.values.length >= WARMUP;
    const m = ready ? median(b.values) : 0;
    // 들쭉날쭉한 지표(주기적으로 몰아 쓰는 디스크 등)는 중앙값으로 평소를 다 설명하지 못한다: 평소 가장 높았던 값의 1.5배도 넘어야 한다.
    // 단 3분 이상 지난 값만 '평소의 최고' 로 친다(서서히 오르는 장애가 그 오름을 평소로 배워 한도가 따라 올라가지 않게)
    const old = b.values.filter((_, i) => b.times[i] <= now - 180_000);
    const peak = old.length ? Math.max(...old) * 1.5 : 0;
    const limit = ready ? Math.max(m * (this.opts.factor ?? 3), m + 4 * mad(b.values), peak, m + 1e-9) : null;
    const over = limit !== null && sustained > limit;
    // 저절로 금방(3분 안에) 풀린 넘침은 그 지표의 평소 출렁임으로 배운다(되풀이되는 몰아 쓰기가 매번 울리지 않게).
    // 오래 이어진 넘침(진짜 장애)은 배우지 않는다
    if (over) b.episode = { start: b.episode?.start ?? now, peak: Math.max(b.episode?.peak ?? 0, sustained) };
    else if (b.episode) {
      if (now - b.episode.start <= 180_000) {
        b.values.push(b.episode.peak);
        b.times.push(now - 180_000);
        if (b.values.length > HISTORY) (b.values.shift(), b.times.shift());
      }
      b.episode = null;
    }
    if (!over && now - b.at >= 10_000) {
      b.values.push(value);
      b.times.push(now);
      if (b.values.length > HISTORY) (b.values.shift(), b.times.shift());
      b.at = now;
    }
    const round = (x: number) => Math.round(x * 1e4) / 1e4;
    return { value: round(sustained), limit: limit === null ? null : round(limit), over };
  }

  async snapshot(): Promise<Snapshot> {
    if (this.opts.url) await this.pull();
    const now = this.opts.now?.() ?? Date.now();
    const ms = [...this.metrics].sort();
    const services: Row[] = [...this.latest].map(([name, values]) => {
      const row: Row = { id: name, name };
      let bad = false;
      for (const m of ms) {
        const v = values.get(m);
        if (v === undefined) {
          row[m] = null;
          if (this.judged(m)) row[`${m}_limit`] = null;
          continue;
        }
        if (!this.judged(m)) {
          row[m] = Math.round(v * 1e4) / 1e4;
          continue;
        }
        const j = this.judge(`${name}\u0000${m}`, v, now);
        row[m] = j.value;
        row[`${m}_limit`] = j.limit;
        bad ||= j.over;
      }
      row.status = bad ? 'degraded' : 'healthy';
      return row;
    });
    return { ts: now, collections: { services } };
  }

  describe() {
    return '(지표는 읽기 전용)';
  }

  async execute(): Promise<void> {
    throw new UnsupportedCommandError('지표는 읽기 전용입니다');
  }

  async close() {}
}
