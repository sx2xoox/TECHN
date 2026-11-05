import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KubernetesAdapter } from '@isomorph/adapters';
import { startFakeKube, type FakeKube } from '../../adapters/test/fake-kube.ts';
import { attachNotifier, deepLink, detectFormat, formatPayload, IsomorphRuntime, type NotifyItem } from '../src/index.ts';

/** 알림: 법칙이 새로 깨지면 웹훅으로, 링크는 그 개체·그 시점 */
let kube: FakeKube;
let rt: IsomorphRuntime;
let hook: http.Server;
let hookUrl: string;
let status = 200;
const got: { path: string; body: { text: string; system: string; items: NotifyItem[] } }[] = [];

beforeAll(async () => {
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (status === 200) got.push({ path: req.url ?? '', body: JSON.parse(b) });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hooks/SECRET-abc123`;
  kube = await startFakeKube();
  rt = new IsomorphRuntime({ adapter: new KubernetesAdapter({ server: kube.url, token: kube.token }), pollMs: 60_000, numRuns: 30, compile: { mode: 'heuristic' } });
});

afterAll(async () => {
  await rt?.stop();
  await kube?.close();
  hook.close();
});

const tick = async () => {
  await new Promise((r) => setTimeout(r, 5));
  await rt.refresh(); // 이 변경 뒤에 시작한 관측(진행 중이던 관측을 빌려 쓰지 않는다)
};
const waitFor = async (n: number) => {
  for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

describe('notifications', () => {
  it('formats for Slack (escaping data) and Discord (no pings), and builds deep links', () => {
    expect(detectFormat('https://hooks.slack.com/services/T/B/x')).toBe('slack');
    expect(detectFormat('https://discord.com/api/webhooks/1/abc')).toBe('discord');
    expect(detectFormat('https://example.com/hook')).toBe('json');
    expect(deepLink('https://iso.example.com', 'products:3', 1700000000000)).toBe('https://iso.example.com/?focus=products%3A3&at=1700000000000');
    const item: NotifyItem = { phase: 'start', at: 1, title: '재고 <!channel> 음수', severity: 'critical', collection: 'products', pk: '3', entityId: 'products:3', values: {}, diagnosis: { pattern: 'race', title: '경쟁 조건', detail: 'x'.repeat(500) }, link: 'https://iso.example.com/?focus=products%3A3', root: null, change: null };
    const slack = formatPayload('slack', { system: 'shop', text: '', items: [item] }) as { text: string };
    expect(slack.text).toContain('&lt;!channel&gt;'); // 데이터가 Slack 멘션이 되지 않는다
    expect(slack.text).toContain('<https://iso.example.com/?focus=products%3A3|세계에서 보기>');
    expect(slack.text).toContain('원인 후보: 경쟁 조건');
    const discord = formatPayload('discord', { system: 'shop', text: '', items: Array.from({ length: 30 }, () => item) }) as { content: string; allowed_mentions: unknown };
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.content.length).toBeLessThanOrEqual(1900);
  });

  it('stays quiet about what was already broken at startup, then reports a new break with its diagnosis and a link', async () => {
    const n = attachNotifier(rt, { webhook: hookUrl, publicUrl: 'http://world.example:4000', batchMs: 30, cooldownMs: 60_000 });
    expect(await rt.start()).toBe('running');
    await n.flush();
    expect(got).toHaveLength(0); // 시작할 때 이미 깨져 있던 4건은 알리지 않는다
    kube.setReady('default/web', 0);
    await tick();
    await waitFor(1);
    expect(got).toHaveLength(1);
    const it0 = got[0].body.items[0];
    expect(it0).toMatchObject({ phase: 'start', collection: 'deployments', pk: 'default/web', entityId: 'deployments:default/web' });
    expect(it0.link).toBe(`http://world.example:4000/?focus=deployments%3Adefault%2Fweb&at=${it0.at}`);
    expect(it0.diagnosis?.title).toBeTruthy();
    expect(got[0].body.text).toContain('법칙 위반 1건');
    expect(got[0].path).toBe('/hooks/SECRET-abc123');

    // 풀리면 '복구'
    kube.setReady('default/web', 2);
    await tick();
    await waitFor(2);
    expect(got[1].body.items[0]).toMatchObject({ phase: 'end', pk: 'default/web' });
    expect(got[1].body.text).toContain('복구 1건');
    // 그 뒤 장애 종료 요약(근본 원인·영향·조치·사후 보고서 링크)
    await waitFor(3);
    const summary = got[2].body as unknown as { text: string; incident: { root: { pk: string }; report: string } };
    expect(summary.text).toContain('장애 종료');
    expect(summary.incident.root.pk).toBe('default/web');
    expect(summary.incident.report).toMatch(/^http:\/\/world\.example:4000\/api\/incidents\/[0-9a-f-]{36}\.md$/);
    got.splice(2, 1);

    // 깜빡임: 되풀이 억제 시간 안에 다시 깨지면 다시 알리지 않는다
    const before = n.stats.suppressed;
    kube.setReady('default/web', 0);
    await tick();
    await n.flush();
    expect(got).toHaveLength(2);
    expect(n.stats.suppressed).toBe(before + 1);
    kube.setReady('default/web', 2);
    await tick();
    await n.stop();
  });

  it('survives a failing webhook without ever logging its secret address', async () => {
    const logs: string[] = [];
    status = 500;
    const n = attachNotifier(rt, { webhook: hookUrl, batchMs: 10, log: (m) => logs.push(m) });
    kube.setReady('default/web', 1);
    await tick();
    await n.flush();
    expect(n.stats.failed).toBe(1);
    expect(logs.join('\n')).toContain('알림 실패');
    expect(logs.join('\n')).not.toContain('SECRET-abc123');
    status = 200;
    kube.setReady('default/web', 2);
    await tick();
    await n.stop();
  });

  it('only sends what reaches the chosen severity, and refuses non-http webhooks', async () => {
    const before = got.length;
    const n = attachNotifier(rt, { webhook: hookUrl, batchMs: 10, minSeverity: 'critical' });
    kube.setReady('default/web', 0); // 이 법칙은 warning
    await tick();
    await n.flush();
    expect(got.length).toBe(before);
    await n.stop();
    expect(() => attachNotifier(rt, { webhook: 'file:///etc/passwd' })).toThrow(/http/);
  });
});
