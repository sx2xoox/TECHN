import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

/**
 * 접근 제어
 *  - operator: 세계를 보고 '행동'까지 할 수 있음
 *  - viewer  : 보기 전용(관람자 토큰) — 비개발자·경영진·고객에게 안전하게 공유
 * 토큰이 하나도 설정되지 않았다면 루프백(127.0.0.1)에서만 열 수 있고, 그때는 로컬 사용자를 operator 로 본다.
 */
export type Role = 'operator' | 'viewer';

export interface AuthOptions {
  token?: string;
  viewerToken?: string;
}

export const COOKIE = 'isomorph_token';

const LOOPBACK_IP = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** 듣는 주소가 이 컴퓨터 안에서만 닿는가. 지정하지 않음(undefined)은 기본값 127.0.0.1 이라 루프백,
 *  빈 문자열('')은 Node 가 모든 주소(0.0.0.0)로 듣기 때문에 루프백이 아니다. */
export function isLoopback(host: string | undefined): boolean {
  if (host === undefined) return true;
  return host === 'localhost' || host === '::1' || LOOPBACK_IP.test(host);
}

/**
 * DNS 리바인딩 방지: 토큰 없이(로컬 전용으로) 열었을 때는 요청의 Host 가 로컬 이름이어야 한다.
 * 공격 사이트(evil.example)가 자기 이름을 127.0.0.1 로 바꿔 가리켜도 Host 는 evil.example 이므로 막힌다.
 */
export function hostHeaderIsLoopback(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.replace(/:\d+$/, '');
  return name === 'localhost' || name === '::1' || LOOPBACK_IP.test(name);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function presentedToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') ?? cookieValue(req, COOKIE);
}

export function resolveRole(req: http.IncomingMessage, auth: AuthOptions): Role | null {
  if (!auth.token && !auth.viewerToken) return 'operator';
  const t = presentedToken(req);
  if (!t) return null;
  if (auth.token && same(t, auth.token)) return 'operator';
  if (auth.viewerToken && same(t, auth.viewerToken)) return 'viewer';
  return null;
}

/** 다른 사이트가 사용자의 쿠키로 WebSocket 을 여는 것을 막는다 */
export function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
