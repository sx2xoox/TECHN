import http from 'node:http';
import { type Snapshot, type SystemSchema, type UpdateCommand } from '@isomorph/core';
import { ConflictError, UnsupportedCommandError, type Adapter } from './types.ts';

export interface DockerAdapterOptions {
  socketPath?: string;
  /** tcp 엔드포인트(예: http://127.0.0.1:2375). 지정하면 socketPath 대신 사용 */
  baseUrl?: string;
  system?: string;
  /** 실행 중 컨테이너의 CPU/메모리 통계를 읽을 최대 개수 */
  statsLimit?: number;
}

const STATES = ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'];

interface DockerContainer {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
}

/** Docker Engine API: 컨테이너 하나 = 공장 하나. state 만 쓸 수 있다(start/stop/pause/unpause). */
export class DockerAdapter implements Adapter {
  readonly kind = 'docker' as const;
  readonly system: string;
  private schema: SystemSchema;

  constructor(private opts: DockerAdapterOptions = {}) {
    this.system = opts.system ?? 'docker';
    this.schema = {
      system: this.system,
      source: 'docker',
      constraints: [],
      collections: [
        {
          name: 'containers',
          primaryKey: 'id',
          fields: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'name', type: 'string', nullable: false },
            { name: 'image', type: 'string', nullable: false },
            { name: 'state', type: 'string', nullable: false, enumValues: STATES },
            { name: 'status', type: 'string', nullable: false },
            { name: 'cpu_percent', type: 'number', nullable: true, stats: { min: 0, max: 100 } },
            { name: 'mem_mb', type: 'number', nullable: true, stats: { min: 0, max: 512 } },
            { name: 'restart_count', type: 'integer', nullable: true, stats: { min: 0, max: 3 } },
            { name: 'created_at', type: 'timestamp', nullable: false },
          ],
        },
      ],
    };
  }

  private request<T>(method: string, path: string): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const base = this.opts.baseUrl ? new URL(this.opts.baseUrl) : null;
      const req = http.request(
        base
          ? { method, host: base.hostname, port: base.port, path }
          : { method, socketPath: this.opts.socketPath ?? '/var/run/docker.sock', path },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = text;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              /* 텍스트 응답 */
            }
            resolve({ status: res.statusCode ?? 0, body: body as T });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  async connect() {
    const r = await this.request('GET', '/_ping');
    if (r.status !== 200) throw new Error(`Docker 데몬 응답 없음 (${r.status})`);
  }

  async introspect(): Promise<SystemSchema> {
    return this.schema;
  }

  async snapshot(): Promise<Snapshot> {
    const r = await this.request<DockerContainer[]>('GET', '/containers/json?all=1');
    if (r.status !== 200) throw new Error(`컨테이너 목록 실패 (${r.status})`);
    const limit = this.opts.statsLimit ?? 20;
    const rows = await Promise.all(
      r.body.map(async (c, i) => {
        const row: Record<string, unknown> = {
          id: c.Id.slice(0, 12),
          name: (c.Names[0] ?? c.Id).replace(/^\//, ''),
          image: c.Image,
          state: c.State,
          status: c.Status,
          cpu_percent: null,
          mem_mb: null,
          restart_count: null,
          created_at: new Date(c.Created * 1000).toISOString(),
        };
        if (i < limit) {
          const inspect = await this.request<{ RestartCount?: number }>('GET', `/containers/${c.Id}/json`);
          if (inspect.status === 200) row.restart_count = inspect.body.RestartCount ?? 0;
          if (c.State === 'running') {
            const s = await this.request<any>('GET', `/containers/${c.Id}/stats?stream=false`);
            if (s.status === 200 && s.body?.cpu_stats) {
              const cpuDelta = s.body.cpu_stats.cpu_usage.total_usage - (s.body.precpu_stats?.cpu_usage?.total_usage ?? 0);
              const sysDelta = s.body.cpu_stats.system_cpu_usage - (s.body.precpu_stats?.system_cpu_usage ?? 0);
              const cpus = s.body.cpu_stats.online_cpus ?? 1;
              row.cpu_percent = sysDelta > 0 ? Number(((cpuDelta / sysDelta) * cpus * 100).toFixed(2)) : 0;
              row.mem_mb = Number(((s.body.memory_stats?.usage ?? 0) / 1048576).toFixed(1));
            }
          }
        }
        return row;
      }),
    );
    return { ts: Date.now(), collections: { containers: rows } };
  }

  private action(cmd: UpdateCommand): string {
    const keys = Object.keys(cmd.patch);
    if (cmd.collection !== 'containers' || keys.length !== 1 || keys[0] !== 'state') {
      throw new UnsupportedCommandError('Docker 어댑터는 컨테이너 state 만 바꿀 수 있습니다');
    }
    const to = String(cmd.patch.state);
    const from = String(cmd.before.state ?? '');
    if (to === 'running') return from === 'paused' ? 'unpause' : 'start';
    if (to === 'paused') return 'pause';
    if (to === 'exited') return 'stop';
    throw new UnsupportedCommandError(`state=${to} 로는 바꿀 수 없습니다`);
  }

  describe(cmd: UpdateCommand): string {
    return `POST /containers/${cmd.pk}/${this.action(cmd)}`;
  }

  async execute(cmd: UpdateCommand): Promise<void> {
    const action = this.action(cmd);
    const r = await this.request<{ message?: string }>('POST', `/containers/${cmd.pk}/${action}`);
    if (r.status === 304) throw new ConflictError('컨테이너가 이미 그 상태입니다');
    if (r.status === 404) throw new ConflictError('컨테이너가 더 이상 존재하지 않습니다');
    if (r.status >= 300) throw new Error(`Docker ${action} 실패 (${r.status}): ${r.body?.message ?? ''}`);
  }

  async close() {}
}
