import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage, WorldState } from '@isomorph/core';
import type { IsomorphRuntime } from './runtime.ts';
import { isLoopback, presentedToken, resolveRole, sameOrigin, sessionCookie, type AuthOptions, type Role } from './auth.ts';

export interface ServeOptions {
  port?: number;
  host?: string;
  /** 빌드된 클라이언트(정적 파일) 경로 */
  staticDir?: string;
  /** 생성된 픽셀 아트 에셋 경로(/assets/*) */
  assetsDir?: string;
  log?: (msg: string) => void;
  /** 운영자 토큰(행동 가능) */
  token?: string;
  /** 관람자 토큰(보기 전용) */
  viewerToken?: string;
}

interface ClientState {
  ws: WebSocket;
  role: Role;
  /** null 이면 실시간, 숫자면 그 시점을 보고 있음 */
  seekTs: number | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function serveFile(res: http.ServerResponse, root: string, rel: string): boolean {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': rel.includes('/assets/') ? 'max-age=3600' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 런타임을 HTTP(정적 클라이언트·디버그 JSON) + WebSocket(/ws)으로 노출한다. */
export async function serve(runtime: IsomorphRuntime, opts: ServeOptions = {}) {
  const log = opts.log ?? (() => {});
  const clients = new Set<ClientState>();
  const auth: AuthOptions = { token: opts.token, viewerToken: opts.viewerToken };
  if (!isLoopback(opts.host) && !auth.token) {
    throw new Error(`외부 주소(${opts.host})로 세계를 열려면 접근 토큰(token)이 필요합니다. ISOMORPH_TOKEN 을 설정하세요.`);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = resolveRole(req, auth);
    if (!role) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ISOMORPH 접근 토큰이 필요합니다. 받은 링크(…/?token=…)로 접속하세요.');
    }
    // 링크의 ?token= 은 쿠키로 옮기고 주소창에서 지운다
    if (url.searchParams.has('token')) {
      const t = presentedToken(req)!;
      url.searchParams.delete('token');
      res.writeHead(302, { 'set-cookie': sessionCookie(t), location: `${url.pathname}${url.search}` });
      return res.end();
    }
    if (url.pathname === '/api/hello') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: runtime.status, error: runtime.error, compileMode: runtime.compileMode, fallbackReason: runtime.fallbackReason, rounds: runtime.compileRounds, ...(runtime.grammar ? runtime.hello() : {}), role }));
    }
    if (url.pathname === '/api/world') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(runtime.world));
    }
    if (url.pathname.startsWith('/generated/') && opts.assetsDir && serveFile(res, opts.assetsDir, url.pathname.slice('/generated/'.length))) return;
    if (opts.staticDir) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (serveFile(res, opts.staticDir, rel)) return;
      if (!path.extname(rel) && serveFile(res, opts.staticDir, 'index.html')) return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(opts.staticDir ? 'not found' : '클라이언트가 빌드되지 않았습니다. npm run build 를 실행하세요.');
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, done) => {
      if (!sameOrigin(info.req)) return done(false, 403, 'origin mismatch');
      done(resolveRole(info.req, auth) !== null, 401, 'token required');
    },
  });
  const send = (c: ClientState, m: ServerMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  };
  const broadcast = (m: ServerMessage, filter: (c: ClientState) => boolean = () => true) => {
    for (const c of clients) if (filter(c)) send(c, m);
  };

  const onWorld = (world: WorldState) => broadcast({ type: 'world', mode: 'live', world }, (c) => c.seekTs === null);
  const onActions = () => broadcast({ type: 'actions', actions: runtime.getActions() });
  const onGrammar = () => runtime.grammar && broadcast({ type: 'grammar', grammar: runtime.grammar, legend: runtime.hello().legend });
  const onStatus = () => {
    if (!runtime.grammar) return;
    for (const c of clients) send(c, { ...runtime.hello(), role: c.role });
    if (runtime.world) broadcast({ type: 'world', mode: 'live', world: runtime.world }, (c) => c.seekTs === null);
  };
  runtime.on('status', onStatus);
  const onToast = (t: { level: 'info' | 'success' | 'warning' | 'error'; message: string }) => broadcast({ type: 'toast', ...t });
  runtime.on('world', onWorld);
  runtime.on('actions', onActions);
  runtime.on('grammar', onGrammar);
  runtime.on('toast', onToast);
  const timelineTimer = setInterval(() => runtime.status === 'running' && broadcast(runtime.timeline()), 2000);

  wss.on('connection', (ws, req) => {
    const c: ClientState = { ws, seekTs: null, role: resolveRole(req, auth) ?? 'viewer' };
    clients.add(c);
    if (runtime.grammar) send(c, { ...runtime.hello(), role: c.role });
    if (runtime.world) send(c, { type: 'world', mode: 'live', world: runtime.world });
    if (runtime.status === 'running') {
      send(c, runtime.timeline());
      send(c, { type: 'actions', actions: runtime.getActions() });
    }
    ws.on('close', () => clients.delete(c));
    ws.on('message', async (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const writes = ['dryrun', 'approve', 'cancel', 'undo', 'invariant'];
      if (c.role === 'viewer' && writes.includes(msg.type)) {
        send(c, { type: 'toast', level: 'warning', message: '보기 전용 접속입니다. 행동은 운영자 토큰으로 접속해야 합니다.' });
        return;
      }
      try {
        switch (msg.type) {
          case 'inspect': {
            const m = runtime.inspect(msg.entityId, c.seekTs ?? undefined);
            if (c.role === 'viewer') m.affordances = m.affordances.map((a) => ({ ...a, allowed: false, reason: '보기 전용 접속입니다' }));
            send(c, m);
            break;
          }
          case 'dryrun':
            if (c.seekTs !== null) {
              send(c, { type: 'toast', level: 'warning', message: '과거 시점에서는 행동할 수 없습니다. 실시간(LIVE)으로 돌아가세요.' });
              break;
            }
            send(c, runtime.dryRun(msg.entityId, msg.affordanceId));
            break;
          case 'approve': {
            const r = await runtime.approve(msg.planId);
            send(c, { type: 'toast', level: r.status === 'failed' ? 'error' : 'success', message: r.status === 'failed' ? `실행 실패: ${r.error}` : `실행됨: ${r.title}` });
            break;
          }
          case 'cancel':
            runtime.cancel(msg.planId);
            break;
          case 'undo': {
            const r = await runtime.undo(msg.actionId);
            send(c, { type: 'toast', level: r.status === 'failed' ? 'error' : 'success', message: r.status === 'failed' ? `되돌리기 실패: ${r.error}` : `되돌림: ${r.title}` });
            break;
          }
          case 'seek': {
            const w = runtime.seek(msg.ts);
            if (w) {
              c.seekTs = msg.ts;
              send(c, { type: 'world', mode: 'history', world: w });
            }
            break;
          }
          case 'live':
            c.seekTs = null;
            if (runtime.world) send(c, { type: 'world', mode: 'live', world: runtime.world });
            break;
          case 'invariant':
            runtime.setInvariantStatus(msg.id, msg.status);
            break;
          case 'lab': {
            const lab = runtime.lab();
            send(c, { type: 'lab', model: lab.model, hypotheses: lab.hypotheses });
            break;
          }
          case 'simulate': {
            const result = await runtime.simulate(msg.hypothesis, (done, total) => send(c, { type: 'simulation-progress', hypothesisId: msg.hypothesis.id, done, total }));
            send(c, { type: 'simulation', result });
            break;
          }
        }
      } catch (e) {
        send(c, { type: 'toast', level: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  const port = opts.port ?? 4000;
  await new Promise<void>((resolve) => server.listen(port, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  log(`ISOMORPH 세계: http://${opts.host ?? '127.0.0.1'}:${actualPort}${auth.token ? ' (접근 토큰 필요)' : ''}`);
  return {
    port: actualPort,
    url: `http://${opts.host ?? '127.0.0.1'}:${actualPort}`,
    async close() {
      clearInterval(timelineTimer);
      runtime.off('world', onWorld);
      runtime.off('actions', onActions);
      runtime.off('grammar', onGrammar);
      runtime.off('toast', onToast);
      runtime.off('status', onStatus);
      for (const c of clients) c.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
