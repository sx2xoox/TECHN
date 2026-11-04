import '../style.css';
import './study.css';
import { ANOMALY_KO, type LegendEntry, type Row, type SystemSchema, type WorldGrammar, type WorldState } from '@isomorph/core';
import { loadFonts } from '../fonts.ts';
import { clear, h } from '../ui/dom.ts';
import { Town } from '../world/renderer.ts';
import { TableView } from './table.ts';

/**
 * 사용자 실험 화면: 동의 → 배경 질문 → [조건별: 안내 → 연습(정답 알려줌) → 본 과제 → 설문] → 마지막 설문
 * 같은 과제를 '세계' 와 '표' 로 보여주고, 규칙을 어긴 곳을 찾게 한다.
 */
interface Choice {
  id: string;
  text: string;
}
interface SessionInfo {
  session: string;
  participant: number;
  total: number;
  timeLimitMs: number;
  rules: Choice[];
  choices: Choice[];
  grammar: WorldGrammar;
  legend: LegendEntry[];
  schema: SystemSchema;
}
interface TrialPayload {
  key: number;
  index: number;
  total: number;
  practice: boolean;
  condition: 'world' | 'table' | 'table+alerts';
  rows: Record<string, Row[]>;
  world: WorldState;
  alerts?: string[];
  oracle?: { target: string | null; anomaly: string };
}

const COND_KO: Record<string, string> = { world: '세계 보기', table: '표 보기', 'table+alerts': '표 보기(위반 강조)' };
const root = document.getElementById('study')!;
const api = {
  async post<T>(url: string, body: unknown): Promise<T> {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json() as Promise<T>;
  },
  async get<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json() as Promise<T>;
  },
};

/** 자가 시험(봇)용 손잡이 — 실제 참가자 화면에는 아무 영향이 없다 */
const hook = {
  phase: 'consent' as string,
  trial: null as TrialPayload | null,
  select: (_key: string | null) => {},
  choose: (_id: string) => {},
  submit: () => {},
  click: (_label: string) => {},
  town: null as Town | null,
};
(window as unknown as { __study: typeof hook }).__study = hook;

function screen(...children: (Node | string | null)[]) {
  clear(root);
  const box = h('div', { class: 'study-screen' }, ...children);
  root.append(box);
  return box;
}

function waitClick(btn: HTMLButtonElement) {
  return new Promise<void>((resolve) => btn.addEventListener('click', () => resolve(), { once: true }));
}

function button(label: string, cls = 'btn primary') {
  const b = h('button', { class: cls }, label) as HTMLButtonElement;
  hook.click = (l) => [...root.querySelectorAll('button')].find((x) => x.textContent?.includes(l))?.click();
  return b;
}

async function consent() {
  hook.phase = 'consent';
  const yes = button('동의하고 시작');
  const no = button('동의하지 않음', 'btn');
  screen(
    h('h1', null, 'ISOMORPH 사용자 실험'),
    h('p', null, '이 실험은 "소프트웨어 안에서 규칙을 어긴 곳을, 마을 그림(세계)과 표 중 어느 쪽에서 더 쉽게 찾는가" 를 알아보려는 것입니다. 약 15분 걸립니다.'),
    h('ul', null,
      h('li', null, '기록하는 것: 누른 곳, 걸린 시간, 고른 답, 개발 경험·표 사용 경험(선택: 연령대).'),
      h('li', null, '기록하지 않는 것: 이름, 연락처, 화면 녹화.'),
      h('li', null, '언제든 그만둘 수 있습니다. 그만두면 진행 중인 기록은 실험 진행자에게 말해 지울 수 있습니다.'),
      h('li', null, '기록은 실험 진행자의 컴퓨터에만 저장되며, 결과는 개인을 알아볼 수 없는 집계로만 씁니다.'),
      h('li', null, '정답을 맞히는 시험이 아닙니다. 평가 대상은 여러분이 아니라 화면입니다.'),
    ),
    h('div', { class: 'row' }, yes, no),
  );
  await Promise.race([waitClick(yes), waitClick(no).then(() => Promise.reject(new Error('declined')))]);
}

async function background(): Promise<Record<string, unknown>> {
  hook.phase = 'background';
  const dev = h('select', null, h('option', { value: '' }, '선택하세요'), h('option', { value: 'none' }, '없음 (개발자가 아님)'), h('option', { value: 'some' }, '조금 (배운 적 있음)'), h('option', { value: 'work' }, '업무로 개발함')) as HTMLSelectElement;
  const dash = h('select', null, ...[1, 2, 3, 4, 5].map((n) => h('option', { value: String(n) }, `${n} ${n === 1 ? '(거의 안 씀)' : n === 5 ? '(매일 씀)' : ''}`))) as HTMLSelectElement;
  const age = h('select', null, h('option', { value: '' }, '답하지 않음'), ...['10대', '20대', '30대', '40대', '50대', '60대 이상'].map((a) => h('option', { value: a }, a))) as HTMLSelectElement;
  const next = button('다음');
  screen(
    h('h2', null, '시작 전에 세 가지만'),
    h('label', { class: 'field' }, '프로그램 개발 경험', dev),
    h('label', { class: 'field' }, '엑셀·관리자 화면 같은 표를 얼마나 자주 보나요?', dash),
    h('label', { class: 'field' }, '연령대(선택)', age),
    next,
  );
  for (;;) {
    await waitClick(next);
    if (dev.value) break;
    dev.focus();
  }
  return { developer: dev.value, dashboards: Number(dash.value), ageBand: age.value };
}

function rulesCard(info: SessionInfo) {
  return h('div', { class: 'rules-card' }, h('strong', null, '이 시스템의 규칙'), h('ol', null, info.rules.map((r) => h('li', null, r.text))));
}

async function intro(info: SessionInfo, condition: string) {
  hook.phase = `intro:${condition}`;
  const start = button('연습 과제 시작');
  const anomalies = Object.entries(ANOMALY_KO).filter(([k]) => ['ghost', 'orphan', 'timewarp', 'doppelganger', 'glitch'].includes(k));
  const body =
    condition === 'world'
      ? [
          h('p', null, '시스템의 데이터가 마을로 보입니다. 상품은 창고, 고객은 집, 주문은 길을 걷는 상인입니다.'),
          h('p', null, '규칙을 어긴 곳은 마을에서 있을 수 없는 장면으로 나타납니다:'),
          h('ul', null, anomalies.map(([k, v]) => h('li', null, h('code', null, k), ` ${v}`))),
          h('p', null, '건물이나 사람에 마우스를 올리면 값이 보이고, 누르면 선택됩니다. 끌어서 움직이고, 휠로 확대할 수 있습니다.'),
        ]
      : [
          h('p', null, '시스템의 데이터가 표로 보입니다(흔한 관리자 화면). 머리글을 누르면 그 칸으로 정렬됩니다.'),
          condition === 'table+alerts' ? h('p', null, '규칙을 어긴 행은 붉게 칠해지고 ⚠ 표시가 붙습니다.') : null,
          h('p', null, '행을 누르면 선택됩니다.'),
        ];
  screen(
    h('h2', null, `다음은 「${COND_KO[condition]}」입니다`),
    ...body,
    rulesCard(info),
    h('p', null, '과제마다 규칙을 어긴 곳이 하나 있거나, 없습니다. 어긴 곳을 찾아 선택하고, 어떤 규칙을 어겼는지 고른 뒤 제출하세요. 어긴 곳이 없다고 생각되면 "어긴 곳이 없다" 를 고르고 제출하세요.'),
    h('p', { class: 'muted' }, '먼저 연습을 한 번 합니다. 연습에서는 정답을 알려드립니다.'),
    start,
  );
  await waitClick(start);
}

/** 과제 하나: 고른 것과 시간을 서버에 보내고, 연습이면 정답을 보여준다 */
async function runTrial(info: SessionInfo, t: TrialPayload, town: Town, stage: HTMLElement) {
  hook.phase = t.practice ? 'practice' : 'trial';
  hook.trial = t;
  let selected: string | null = null;
  let choice: string | null = null;
  const selections: { t: number; key: string }[] = [];
  const pickedLabel = h('div', { class: 'picked' }, '선택한 곳: (없음)');
  const choiceBox = h('div', { class: 'choices' });
  const submit = h('button', { class: 'btn primary', disabled: true }, '제출') as HTMLButtonElement;
  const skip = h('button', { class: 'btn small ghost' }, '모르겠어요(넘어가기)') as HTMLButtonElement;
  const label = (key: string | null) => {
    if (!key) return '(없음)';
    const [col, pk] = key.split(':');
    const row = (t.rows[col] ?? []).find((r) => String(r.id) === pk);
    return `${col} #${pk}${row?.name ? ` (${row.name})` : ''}`;
  };
  const refresh = () => {
    pickedLabel.textContent = `선택한 곳: ${choice === 'none' ? '(어긴 곳이 없다)' : label(selected)}`;
    submit.disabled = !choice || (choice !== 'none' && !selected);
  };
  for (const c of info.choices) {
    const input = h('input', { type: 'radio', name: 'choice', value: c.id }) as HTMLInputElement;
    input.addEventListener('change', () => {
      choice = c.id;
      refresh();
    });
    choiceBox.append(h('label', { class: 'choice' }, input, ` ${c.text}`));
  }

  const header = h('div', { class: 'study-head' },
    h('strong', null, t.practice ? '연습' : `과제 ${t.index + 1}`),
    h('span', { class: 'tag' }, COND_KO[t.condition]),
    h('span', { class: 'muted small grow' }, '규칙을 어긴 곳을 찾아 선택하고, 어긴 규칙을 고르세요.'),
  );
  const side = h('aside', { class: 'study-side' }, rulesCard(info), h('h3', null, '답'), pickedLabel, choiceBox, h('div', { class: 'row' }, submit, skip));
  const main = h('main', { class: 'study-main' });
  clear(root);
  root.append(h('div', { class: 'study-trial' }, header, h('div', { class: 'study-body' }, side, main)));

  let started = 0;
  const onSelect = (key: string | null) => {
    selected = key;
    if (key) selections.push({ t: Math.round(performance.now() - started), key });
    refresh();
  };
  hook.select = (key) => {
    onSelect(key);
    if (t.condition === 'world') town.select(key ? (t.world.entities.find((e) => `${e.source.collection}:${e.source.pk}` === key)?.id ?? null) : null);
  };
  hook.choose = (id) => (root.querySelector<HTMLInputElement>(`input[value="${id}"]`)!.click());
  hook.submit = () => submit.click();

  let table: TableView | null = null;
  if (t.condition === 'world') {
    main.append(stage);
    stage.classList.remove('hidden');
    town.setWorld(t.world);
    town.fit();
    worldSelect = (id) => {
      const e = id ? t.world.entities.find((x) => x.id === id) : null;
      onSelect(e ? `${e.source.collection}:${e.source.pk}` : null);
    };
    worldHover = (id, x, y) => {
      const e = id ? t.world.entities.find((w) => w.id === id) : null;
      if (!e) return tip.classList.add('hidden');
      // 세계 조건의 말풍선은 원본 값만 보여준다(⚠ 문구는 빼서 '표 보기' 와 같은 정보만 준다)
      const row = (t.rows[e.source.collection] ?? []).find((r) => String(r.id) === String(e.source.pk));
      tip.replaceChildren(h('strong', null, e.label), h('span', { class: 'muted small' }, ` ${e.source.collection} #${e.source.pk}`), h('div', { class: 'mono small' }, Object.entries(row ?? {}).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${typeof v === 'string' && /^\d{4}-/.test(v) ? new Date(v).toLocaleTimeString('ko-KR', { hour12: false }) : v}`).join('  ')));
      const r = stage.getBoundingClientRect();
      tip.style.transform = `translate(${Math.round(x + r.left + 14)}px, ${Math.round(y + r.top + 12)}px)`;
      tip.classList.remove('hidden');
    };
  } else {
    table = new TableView({ rows: t.rows, alerts: t.alerts, onSelect });
    main.append(table.el);
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  started = performance.now();

  const outcome = await new Promise<{ gaveUp: boolean; timedOut: boolean }>((resolve) => {
    const timer = window.setTimeout(() => resolve({ gaveUp: false, timedOut: true }), info.timeLimitMs);
    submit.addEventListener('click', () => (window.clearTimeout(timer), resolve({ gaveUp: false, timedOut: false })), { once: true });
    skip.addEventListener('click', () => (window.clearTimeout(timer), resolve({ gaveUp: true, timedOut: false })), { once: true });
  });
  const timeMs = Math.round(performance.now() - started);
  tip.classList.add('hidden');
  worldSelect = () => {};
  worldHover = () => {};
  stage.classList.add('hidden');
  document.body.append(stage);
  const result = await api.post<{ locateCorrect?: boolean; diagnoseCorrect?: boolean; target?: string | null; anomaly?: string }>('/api/study/answer', {
    session: info.session,
    key: t.key,
    answer: outcome.gaveUp || outcome.timedOut || choice === 'none' ? null : selected,
    choice: outcome.gaveUp || outcome.timedOut ? null : choice,
    timeMs,
    selections,
    gaveUp: outcome.gaveUp,
    timedOut: outcome.timedOut,
    viewport: `${innerWidth}x${innerHeight}`,
  });
  if (t.practice) {
    hook.phase = 'feedback';
    const ok = result.locateCorrect && result.diagnoseCorrect;
    const rule = info.choices.find((c) => c.id === result.anomaly)?.text;
    const next = button('본 과제 시작');
    screen(
      h('h2', { class: ok ? 'ok' : 'bad' }, ok ? '정답입니다' : '아쉽지만 정답이 아닙니다'),
      h('p', null, result.target ? `규칙을 어긴 곳은 ${label(result.target)} 이었고, 어긴 규칙은 "${rule}" 입니다.` : '이 과제에는 규칙을 어긴 곳이 없었습니다.'),
      h('p', { class: 'muted' }, '이제부터는 정답을 알려드리지 않습니다. 가능한 한 빠르고 정확하게 해 주세요.'),
      next,
    );
    await waitClick(next);
  }
}

async function questionnaire(info: SessionInfo, condition: string) {
  hook.phase = `questionnaire:${condition}`;
  const scale = (name: string, lo: string, hi: string) =>
    h('div', { class: 'scale' }, h('span', { class: 'muted small' }, lo), ...[1, 2, 3, 4, 5, 6, 7].map((n) => h('label', null, h('input', { type: 'radio', name, value: String(n) }), String(n))), h('span', { class: 'muted small' }, hi));
  const next = button('다음');
  screen(
    h('h2', null, `「${COND_KO[condition]}」를 마쳤습니다`),
    h('p', null, '이 방식으로 과제를 하면서 머리를 얼마나 써야 했나요?'),
    scale('effort', '1 아주 적게', '7 아주 많이'),
    h('p', null, '고른 답에 얼마나 확신했나요?'),
    scale('confidence', '1 전혀', '7 매우'),
    next,
  );
  const val = (n: string) => Number(root.querySelector<HTMLInputElement>(`input[name="${n}"]:checked`)?.value ?? 0);
  for (;;) {
    await waitClick(next);
    if (val('effort') && val('confidence')) break;
  }
  await api.post('/api/study/questionnaire', { session: info.session, condition, effort: val('effort'), confidence: val('confidence') });
}

async function finalQuestions(info: SessionInfo) {
  hook.phase = 'final';
  const pref = h('select', null, h('option', { value: '' }, '선택하세요'), h('option', { value: 'world' }, '세계 보기가 더 쉬웠다'), h('option', { value: 'table' }, '표 보기가 더 쉬웠다'), h('option', { value: 'same' }, '비슷했다')) as HTMLSelectElement;
  const comment = h('textarea', { rows: '4', placeholder: '좋았던 점, 헷갈렸던 점(선택)' }) as HTMLTextAreaElement;
  const done = button('마치기');
  screen(h('h2', null, '마지막 질문'), h('label', { class: 'field' }, '어느 쪽이 규칙을 어긴 곳을 찾기 쉬웠나요?', pref), h('label', { class: 'field' }, '하고 싶은 말', comment), done);
  await waitClick(done);
  await api.post('/api/study/questionnaire', { session: info.session, condition: 'final', final: true, preference: pref.value, comment: comment.value });
  hook.phase = 'done';
  screen(h('h1', null, '참여해 주셔서 감사합니다'), h('p', null, '기록이 저장되었습니다. 창을 닫으셔도 됩니다.'), h('p', { class: 'muted small' }, `참가 번호 ${info.participant}`));
}

let worldSelect: (id: string | null) => void = () => {};
let worldHover: (id: string | null, x: number, y: number) => void = () => {};
const tip = h('div', { id: 'tooltip', class: 'hidden' });

async function main() {
  await loadFonts();
  document.body.append(tip);
  try {
    await consent();
  } catch {
    hook.phase = 'declined';
    screen(h('h2', null, '참여하지 않기로 하셨습니다'), h('p', null, '아무것도 기록하지 않았습니다. 창을 닫으셔도 됩니다.'));
    return;
  }
  const bg = await background();
  const info = await api.post<SessionInfo>('/api/study/session', bg);
  const stage = h('div', { id: 'stage', class: 'study-stage hidden' });
  document.body.append(stage);
  const town = new Town({ onSelect: (id) => (town.select(id), worldSelect(id)), onHover: (id, x, y) => worldHover(id, x, y) });
  await town.init(stage);
  town.setGrammar(info.grammar);
  hook.town = town;
  let condition: string | null = null;
  for (let key = 0; key < info.total; key++) {
    const t = await api.get<TrialPayload>(`/api/study/trial?session=${info.session}&key=${key}`);
    if (t.condition !== condition) {
      if (condition) await questionnaire(info, condition);
      condition = t.condition;
      await intro(info, condition);
    }
    await runTrial(info, t, town, stage);
  }
  if (condition) await questionnaire(info, condition);
  await finalQuestions(info);
}

main().catch((e) => {
  hook.phase = 'error';
  screen(h('h2', { class: 'bad' }, '오류가 났습니다'), h('p', null, e instanceof Error ? e.message : String(e)), h('p', { class: 'muted' }, '실험 진행자에게 알려 주세요.'));
});
