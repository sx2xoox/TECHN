/**
 * PixelLab API(v2) 최소 클라이언트 — 픽셀 아트 스프라이트 생성.
 * https://api.pixellab.ai/v2/llms.txt
 */
export class PixelLabError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface PixfluxRequest {
  description: string;
  width: number;
  height: number;
  noBackground?: boolean;
  view?: 'side' | 'low top-down' | 'high top-down';
  outline?: 'single color black outline' | 'single color outline' | 'selective outline' | 'lineless';
  shading?: 'flat shading' | 'basic shading' | 'medium shading' | 'detailed shading' | 'highly detailed shading';
  detail?: 'low detail' | 'medium detail' | 'highly detailed';
  seed?: number;
}

export interface PixelLabOptions {
  /** 없으면 PIXELLAB_API_KEY. (관리형 프록시 환경에서는 프록시가 실제 키를 주입) */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class PixelLabClient {
  private base: string;
  private key: string;
  private fetch: typeof fetch;

  constructor(opts: PixelLabOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://api.pixellab.ai/v2').replace(/\/$/, '');
    this.key = opts.apiKey ?? process.env.PIXELLAB_API_KEY ?? 'proxy-injected';
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text).detail ?? text;
      } catch {
        /* 텍스트 그대로 */
      }
      const reason =
        res.status === 401 ? '인증 실패(API 키 확인)'
          : res.status === 402 ? '크레딧/생성 횟수 부족'
            : res.status === 429 ? '요청 한도 초과'
              : res.status === 422 ? '요청 형식 오류' : `HTTP ${res.status}`;
      throw new PixelLabError(`PixelLab ${reason}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  balance() {
    return this.call<{ credits?: { usd: number }; subscription?: { generations: number; total: number; status: string } }>('GET', '/balance');
  }

  /** 텍스트 → 픽셀 아트 PNG(바이트) */
  async pixflux(req: PixfluxRequest): Promise<{ png: Buffer; usd?: number }> {
    const r = await this.call<{ image: { base64: string; format?: string }; usage?: { usd?: number } }>('POST', '/create-image-pixflux', {
      description: req.description,
      image_size: { width: req.width, height: req.height },
      no_background: req.noBackground ?? true,
      ...(req.view ? { view: req.view } : {}),
      ...(req.outline ? { outline: req.outline } : {}),
      ...(req.shading ? { shading: req.shading } : {}),
      ...(req.detail ? { detail: req.detail } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    });
    const b64 = r.image.base64.replace(/^data:image\/\w+;base64,/, '');
    return { png: Buffer.from(b64, 'base64'), usd: r.usage?.usd };
  }
}
