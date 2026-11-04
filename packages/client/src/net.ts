import type { ClientMessage, ServerMessage } from '@isomorph/core';

/** 자동 재연결하는 WebSocket 연결 */
export class Connection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: ClientMessage[] = [];

  constructor(
    private url: string,
    private onMessage: (m: ServerMessage) => void,
    private onState: (s: 'open' | 'closed') => void,
  ) {}

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onState('open');
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch (e) {
        console.error('bad message', e);
      }
    };
    ws.onclose = () => {
      this.onState('closed');
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.queue.push(m);
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
