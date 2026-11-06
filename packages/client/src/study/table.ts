import type { Row } from '@isomorph/core';
import { h } from '../ui/dom.ts';

/**
 * 비교 조건: 흔한 관리자 대시보드(요약 카드 + 테이블별 표, 머리글 정렬, 행 선택).
 * alerts 가 주어지면(표 + 위반 강조 조건) 규칙을 어긴 행을 붉게 칠한다.
 */
export interface TableViewOptions {
  rows: Record<string, Row[]>;
  alerts?: string[];
  onSelect(key: string | null): void;
}

const TITLES: Record<string, string> = {
  products: '상품 (products)',
  orders: '주문 (orders)',
  customers: '고객 (customers)',
  otel_services: '서비스 (otel_services)',
  k8s_deployments: '디플로이먼트 (k8s_deployments)',
  k8s_pods: '파드 (k8s_pods)',
  k8s_nodes: '노드 (k8s_nodes)',
};
const ORDER = ['products', 'orders', 'customers', 'otel_services', 'k8s_deployments', 'k8s_pods', 'k8s_nodes'];

const cell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return new Date(v).toLocaleTimeString('ko-KR', { hour12: false });
  return String(v);
};

export class TableView {
  readonly el = h('div', { class: 'study-tables' });
  private selected: string | null = null;
  private sort = new Map<string, { field: string; dir: 1 | -1 }>();

  constructor(private opts: TableViewOptions) {
    this.render();
  }

  /** reveal: 다른 곳(변경 기록·살펴보기)에서 고른 행이 보이도록 스크롤한다 */
  select(key: string | null, reveal = false) {
    this.selected = key;
    for (const tr of this.el.querySelectorAll<HTMLTableRowElement>('tr[data-key]')) {
      const on = tr.dataset.key === key;
      tr.classList.toggle('sel', on);
      if (on && reveal) tr.scrollIntoView({ block: 'center' });
    }
  }

  private kpis() {
    const card = (label: string, value: string) => h('div', { class: 'kpi' }, h('div', { class: 'small muted' }, label), h('div', { class: 'kpi-v' }, value));
    if (!this.opts.rows.orders) {
      // 쇼핑몰이 아닌 장면(클러스터+서비스): 표마다 행 수(흔한 관리 화면의 요약 칸)
      return h('div', { class: 'kpis' },
        ...ORDER.filter((n) => this.opts.rows[n]).map((n) => card((TITLES[n] ?? n).split(' (')[0], String(this.opts.rows[n].length))),
        ...(this.opts.alerts ? [card('규칙 위반', `${this.opts.alerts.length}건`)] : []),
      );
    }
    const orders = this.opts.rows.orders ?? [];
    const products = new Map((this.opts.rows.products ?? []).map((p) => [String(p.id), p]));
    const paid = orders.filter((o) => o.status === 'paid');
    const revenue = paid.reduce((a, o) => a + Number(products.get(String(o.product_id))?.price ?? 0) * Number(o.quantity ?? 1), 0);
    return h('div', { class: 'kpis' },
      card('주문', String(orders.length)),
      card('결제 완료', String(paid.length)),
      card('실패', String(orders.filter((o) => o.status === 'failed').length)),
      card('매출', `₩${revenue.toLocaleString('ko-KR')}`),
      card('상품', String(products.size)),
      ...(this.opts.alerts ? [card('규칙 위반', `${this.opts.alerts.length}건`)] : []),
    );
  }

  private table(name: string, rows: Row[]) {
    const fields = Object.keys(rows[0] ?? {});
    const s = this.sort.get(name);
    const sorted = s ? [...rows].sort((a, b) => (a[s.field] === b[s.field] ? 0 : (a[s.field]! > b[s.field]! ? 1 : -1) * s.dir)) : rows;
    const alerts = new Set(this.opts.alerts ?? []);
    return h('section', { class: 'study-table' },
      h('h3', null, TITLES[name] ?? name, h('span', { class: 'muted small' }, ` ${rows.length}행`)),
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null,
          this.opts.alerts ? h('th', null, '') : null,
          fields.map((f) => h('th', { class: 'sortable', onclick: () => this.toggleSort(name, f) }, f, s?.field === f ? (s.dir === 1 ? ' ▲' : ' ▼') : '')))),
        h('tbody', null, sorted.map((r) => {
          const key = `${name}:${r.id}`;
          const tr = h('tr', { 'data-key': key, class: `${alerts.has(key) ? 'alert' : ''} ${this.selected === key ? 'sel' : ''}` },
            this.opts.alerts ? h('td', null, alerts.has(key) ? '⚠' : '') : null,
            fields.map((f) => h('td', { class: 'mono' }, cell(r[f]))));
          tr.addEventListener('click', () => {
            this.select(key);
            this.opts.onSelect(key);
          });
          return tr;
        })),
      ),
    );
  }

  private toggleSort(name: string, field: string) {
    const cur = this.sort.get(name);
    this.sort.set(name, { field, dir: cur?.field === field && cur.dir === 1 ? -1 : 1 });
    this.render();
  }

  private render() {
    const top = this.el.scrollTop;
    const names = [...ORDER.filter((n) => this.opts.rows[n]), ...Object.keys(this.opts.rows).filter((n) => !ORDER.includes(n))];
    this.el.replaceChildren(this.kpis(), ...names.map((n) => this.table(n, this.opts.rows[n])));
    this.el.scrollTop = top;
    this.select(this.selected);
  }
}
