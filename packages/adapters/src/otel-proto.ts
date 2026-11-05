/**
 * OTLP 트레이스 요청(ExportTraceServiceRequest)의 protobuf 를 읽는 작은 해석기(의존성 없음).
 * 세계에 필요한 필드만 읽고 나머지는 건너뛴다. 결과는 OTLP/JSON 과 같은 모양이라 같은 수신 코드를 쓴다.
 * 필드 번호: opentelemetry-proto v1 (trace/v1/trace.proto, common/v1/common.proto, resource/v1/resource.proto)
 */
export interface OtlpJsonLike {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } }[] };
    scopeSpans: { spans: { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number; message?: string } }[] }[];
  }[];
}

class Reader {
  pos = 0;
  constructor(
    private buf: Uint8Array,
    private end = buf.length,
  ) {}
  get done() {
    return this.pos >= this.end;
  }
  private need(n: number) {
    if (this.pos + n > this.end) throw new Error('protobuf: 메시지가 잘렸습니다');
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      this.need(1);
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw new Error('protobuf: varint 가 너무 깁니다');
  }
  uint(): number {
    return Number(this.varint() & 0xffffffffn);
  }
  fixed64(): bigint {
    this.need(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += 8;
    return v;
  }
  bytes(): Uint8Array {
    const len = this.uint();
    this.need(len);
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  sub(): Reader {
    const len = this.uint();
    this.need(len);
    const r = new Reader(this.buf, this.pos + len);
    r.pos = this.pos;
    this.pos += len;
    return r;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) (this.need(8), (this.pos += 8));
    else if (wire === 2) this.bytes();
    else if (wire === 5) (this.need(4), (this.pos += 4));
    else throw new Error(`protobuf: 알 수 없는 wire type ${wire}`);
  }
  /** (필드 번호, wire type) 을 차례로 돌려준다 */
  *fields(): Generator<[number, number]> {
    while (!this.done) {
      const tag = this.uint();
      yield [tag >>> 3, tag & 7];
    }
  }
}

const utf8 = new TextDecoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function anyValue(r: Reader): { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } {
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) return { stringValue: utf8.decode(r.bytes()) };
    if (f === 2 && w === 0) return { boolValue: r.varint() !== 0n };
    if (f === 3 && w === 0) return { intValue: BigInt.asIntN(64, r.varint()).toString() };
    if (f === 4 && w === 1) {
      const v = r.fixed64();
      const dv = new DataView(new ArrayBuffer(8));
      dv.setBigUint64(0, v, true);
      return { doubleValue: dv.getFloat64(0, true) };
    }
    r.skip(w);
  }
  return {};
}

function keyValue(r: Reader) {
  let key = '';
  let value = {};
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) key = utf8.decode(r.bytes());
    else if (f === 2 && w === 2) value = anyValue(r.sub());
    else r.skip(w);
  }
  return { key, value };
}

function span(r: Reader) {
  const s = { traceId: '', spanId: '', parentSpanId: undefined as string | undefined, name: '', kind: 0, startTimeUnixNano: '0', endTimeUnixNano: '0', status: { code: 0 } as { code: number; message?: string } };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) s.traceId = hex(r.bytes());
    else if (f === 2 && w === 2) s.spanId = hex(r.bytes());
    else if (f === 4 && w === 2) {
      const p = r.bytes();
      if (p.length) s.parentSpanId = hex(p);
    } else if (f === 5 && w === 2) s.name = utf8.decode(r.bytes());
    else if (f === 6 && w === 0) s.kind = r.uint();
    else if (f === 7 && w === 1) s.startTimeUnixNano = r.fixed64().toString();
    else if (f === 8 && w === 1) s.endTimeUnixNano = r.fixed64().toString();
    else if (f === 15 && w === 2) {
      const st = r.sub();
      for (const [sf, sw] of st.fields()) {
        if (sf === 2 && sw === 2) s.status.message = utf8.decode(st.bytes());
        else if (sf === 3 && sw === 0) s.status.code = st.uint();
        else st.skip(sw);
      }
    } else r.skip(w);
  }
  return s;
}

/** application/x-protobuf 본문 → OTLP/JSON 모양 */
export function decodeOtlpTraces(buf: Uint8Array): OtlpJsonLike {
  const out: OtlpJsonLike = { resourceSpans: [] };
  const root = new Reader(buf);
  for (const [f, w] of root.fields()) {
    if (f !== 1 || w !== 2) {
      root.skip(w);
      continue;
    }
    const rs = root.sub();
    const entry: OtlpJsonLike['resourceSpans'][number] = { resource: { attributes: [] }, scopeSpans: [] };
    for (const [rf, rw] of rs.fields()) {
      if (rf === 1 && rw === 2) {
        const res = rs.sub();
        for (const [af, aw] of res.fields()) {
          if (af === 1 && aw === 2) entry.resource.attributes.push(keyValue(res.sub()));
          else res.skip(aw);
        }
      } else if (rf === 2 && rw === 2) {
        const ss = rs.sub();
        const spans: OtlpJsonLike['resourceSpans'][number]['scopeSpans'][number]['spans'] = [];
        for (const [sf, sw] of ss.fields()) {
          if (sf === 2 && sw === 2) spans.push(span(ss.sub()));
          else ss.skip(sw);
        }
        entry.scopeSpans.push({ spans });
      } else rs.skip(rw);
    }
    out.resourceSpans.push(entry);
  }
  return out;
}
