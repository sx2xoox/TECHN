# ISOMORPH

### 모든 소프트웨어를 '살아있는 세계'로 — 보고, 만지고, 고치는 역(逆) 디지털 트윈

![데모 쇼핑몰이 픽셀 마을로 보이는 모습 — 법칙이 깨진 창고와 원인 진단](docs/screenshots/02-inspector.png)

ISOMORPH 는 실제 시스템(PostgreSQL, REST/JSON API, Docker)에 연결해 **그 구조를 읽고, 수학적으로 검증된 대응 규칙을 합성해, 실시간 픽셀 마을로 렌더링**합니다.

- 테이블의 행은 건물, 사건(주문 등)은 걸어 다니는 주민, 지표는 광장의 시청이 됩니다.
- 시스템의 규칙(불변식)은 세계의 **물리 법칙**이 됩니다. 법칙이 깨지면 *있을 수 없는 장면*(붉은 유령 상자, 화면 깨짐, 도플갱어…)으로 보입니다.
- 세계를 만지면(예: 창고 문 잠그기) **실제 시스템이 바뀝니다** — 드라이런 → 승인 → 실행 → 실제 반영 검증 → 되돌리기.
- 대응 규칙이 법칙(GetPut·PutGet·국소성·단사성)을 통과하지 못하면 **세계를 열지 않습니다.** 틀린 그림을 보여주느니 아무것도 보여주지 않습니다.

기획 의도와 선행연구 비교는 [PROPOSAL.md](PROPOSAL.md)에 있습니다.

---

## 3분 데모

```bash
npm install
```

```bash
npm run build
```

```bash
npm run demo
```

브라우저에서 **http://127.0.0.1:4000** 을 엽니다. 데모는 일부러 버그를 심어 둔 쇼핑몰(PGlite = WASM PostgreSQL, `:5433`)과 그 세계(`:4000`)를 함께 띄웁니다.

1. **15초 뒤 반짝 세일**이 열리고, '마지막 2개' 상품에 주문 4건이 동시에 들어옵니다. 재고 확인과 차감 사이에 잠금이 없는 버그(check-then-act) 때문에 재고가 음수가 됩니다.
2. 창고 옆에 **붉게 깜빡이는 유령 상자**와 `!` 말풍선이 나타나고, 상단에 `법칙 위반 1` 이 켜집니다.
3. 창고를 클릭하면 인스펙터가 **원본 데이터 ↔ 세계 표현**, 위반 직전의 **사건 기록**, 그리고 **원인 진단**("orders 요청 4건이 24ms 안에… 경쟁 조건 의심, 확신 높음")과 고치는 법을 보여줍니다.
4. **창고 문 잠그기**를 누르면 드라이런 창과 함께 마을 위에 **미래 장면**이 반투명하게 겹쳐 보입니다. 실행될 SQL 도 그대로 보여줍니다. 승인하면 실제 DB 의 `active=false` 가 되고, 다음 관측에서 **실제 반영 확인 ✓** 이 붙습니다. 잠긴 창고로 오는 주문은 거절됩니다.
5. 하단 **타임라인**을 끌면 과거 어느 순간의 세계로든 돌아갑니다(붉은 표식 = 법칙 위반이 시작된 순간).

| 드라이런(미래 장면) | 실제 반영 확인 |
|---|---|
| ![드라이런](docs/screenshots/03-dryrun.png) | ![실행 후](docs/screenshots/04-verified.png) |

| 정직한 범례 | 시간 여행 | 렌즈 검증 보고서 |
|---|---|---|
| ![범례](docs/screenshots/05-legend.png) | ![과거](docs/screenshots/06-history.png) | ![검증](docs/screenshots/07-verification.png) |

조작: 드래그 = 이동, 휠 = 확대/축소, `L` 범례, `F` 전체 보기.

---

## 내 시스템에 연결하기

설정 파일 하나로 연결합니다(예시: [`examples/`](examples)).

```bash
npx tsx packages/server/src/cli.ts serve --config examples/postgres.config.json
```

| 어댑터 | 읽기 | 쓰기 | 예시 |
|---|---|---|---|
| PostgreSQL | 테이블·키·enum·CHECK 제약 자동 파악, 이름으로 참조 추론 | 조건부 `UPDATE … WHERE pk AND 변경전값` (낙관적 동시성) | [postgres.config.json](examples/postgres.config.json) |
| HTTP/JSON | 표본으로 스키마 추론 | 설정한 경로로 `PATCH`(직전 값 재확인 후) | [http.config.json](examples/http.config.json) |
| Docker | Engine API(컨테이너·CPU·메모리·재시작) | state 편집 → start/stop/pause/unpause | [docker.config.json](examples/docker.config.json) |

- `writeMode`: `read-only`(기본) / `low` / `medium` / `high`. 이 값보다 위험도가 높은 행동은 실행할 수 없습니다.
- 문법만 컴파일·검증해 파일로 저장할 수 있습니다: `cli.ts compile --config … --out world.json`
- 저장한 파일을 다시 검증할 수 있습니다: `cli.ts verify --config … --grammar world.json`
- 저장한 문법을 손으로 고친 뒤 `grammarPath` 로 고정할 수 있습니다. 고정한 문법도 시작할 때마다 검증합니다.

### LLM 컴파일 (Claude API)

`ANTHROPIC_API_KEY` 가 있으면 `compile.mode: "auto"` 에서 LLM 모드로 컴파일합니다.

1. Claude 가 구조화 출력으로 문법 초안을 냅니다.
2. 검증기가 초안을 검사하고, 찾은 **반례**를 Claude 에게 되돌려 고치게 합니다(최대 3회).
3. 그래도 실패하면 결정적 자동 수리를 하고, 최종적으로 규칙 기반 컴파일러로 물러섭니다.

모델은 `claude-opus-5-5` 이며, 안전 분류기 거절에 대비해 서버 측 대체 모델(`fallbacks: "default"`)을 켜 두었습니다. 다른 모델은 `compile.model` 로 지정합니다.

### PixelLab 픽셀 아트

기본 그래픽은 코드로 그린 오리지널 픽셀 아트입니다. PixelLab 으로 건물 종류마다 스프라이트를 **한 번만** 생성해 캐시할 수 있습니다.

```bash
PIXELLAB_API_KEY=... npm run assets -- --from http://127.0.0.1:4000
```

생성된 스프라이트는 `assets/generated/` 에 저장되며 서버가 자동으로 사용합니다. 프록시를 거치는 환경에서는 `NODE_USE_ENV_PROXY=1` 을 함께 지정하세요.

---

## 작동 원리

```
 시스템 ──어댑터──▶ 스키마 + 스냅샷 ──Metaphor Compiler(규칙/LLM)──▶ 세계 문법(JSON)
                                                                   │
                         반례 되먹임 ◀── Lens Verifier (fast-check) ◀┘  통과해야만 ▼
 시스템 ◀──조건부 실행── 명령 ◀── put ◀── 승인 ◀── 드라이런 ◀── 사용자 행동      세계 열림
   │                                                                          │
   └──관측(폴링)──▶ diff ──▶ 이벤트 저장소(SQLite) ──▶ get + 불변식 ──▶ WebSocket ──▶ 픽셀 마을
                            (시간 여행·원인 추적)        (이상 현상)
```

| 구성요소 | 위치 | 핵심 |
|---|---|---|
| 세계 문법 + 시각 채널 대수 | [`packages/core/src/grammar.ts`](packages/core/src/grammar.ts) | 채널 9종(상자·인파·불길·크기·속도·색·불빛·안개·간판), 채널-필드 타입 규칙 |
| 렌즈 get/put | [`packages/core/src/lens.ts`](packages/core/src/lens.ts) | 범위 밖 값을 조용히 자르지 않음, 상대 편집은 정확히 n×단위 |
| Verified Lens | [`packages/core/src/verify.ts`](packages/core/src/verify.ts) | 결정성, GetPut, PutGet, 국소성, 행동 법칙·멱등성, 단사성, 개인정보, 충실도 점수 |
| 불변식(물리 법칙) | [`packages/core/src/invariants.ts`](packages/core/src/invariants.ts) | 스키마·이름 추정·관측 학습(Daikon 류)·LLM 법칙 → 이상 현상 6종 |
| 원인 추적 | [`packages/core/src/diagnose.ts`](packages/core/src/diagnose.ts) | 위반 시작 순간 기준 사건 기록, 경쟁 조건/참조 끊김/중복/시간 역행 진단 |
| Metaphor Compiler | [`packages/compiler/src`](packages/compiler/src) | 규칙 기반 컴파일러 + Claude 구조화 출력 + 반례 되먹임 + 자동 수리 |
| 어댑터 | [`packages/adapters/src`](packages/adapters/src) | Postgres·HTTP·Docker, 낙관적 동시성 |
| 런타임 | [`packages/server/src/runtime.ts`](packages/server/src/runtime.ts) | Safe Put(드라이런·위험도·재계획·실제 반영 검증·되돌리기), 시간 여행 |
| 렌더러 | [`packages/client/src`](packages/client/src) | PixiJS v8, 절차적 픽셀 아트, 한국어 UI(갈무리 픽셀 글꼴) |
| 버그 있는 데모 쇼핑몰 | [`apps/demo-shop/src/shop.ts`](apps/demo-shop/src/shop.ts) | check-then-act 경쟁 조건, `fixed` 모드로 수정 가능 |

---

## 무엇을 어떻게 검증했나

```bash
npm test
```

```bash
npm run bench:compile
```

```bash
npm run build && npm run e2e
```

```bash
npm run bench:latency
```

- `npm test`: 단위·통합 테스트 47개입니다.
- `npm run bench:compile`: 컴파일러 KPI 를 잽니다.
- `npm run e2e`: 실제 브라우저로 데모 시나리오를 처음부터 끝까지 수행합니다.
- `npm run bench:latency`: 상태 변화가 세계에 반영되기까지의 지연을 잽니다.

| 기획안 KPI | 목표 | 측정 결과 | 판정 |
|---|---|---|---|
| 무인 컴파일 성공률 | 처음 보는 스키마 10종 중 8종 이상 | 도메인 스키마 **12/12** 통과(1차 통과 12, 자동 수리 0), 무작위 생성 스키마 **100/100** 통과 | 달성 — 단, 아래 주의 참고 |
| 정직성(단사성 위반) | 0건 | 벤치마크 전 문법 단사성 100%. 색이 겹치는 문법은 검증기가 거부함(테스트로 확인) | 달성 |
| 상태 → 화면 반영 지연 | 500ms 미만 | 중앙값 **367ms**, p95 **506ms** (관측 주기 500ms 기준) | 중앙값 달성, p95 는 6ms 초과 → `pollMs` 를 낮추면 줄어듦 |
| 엔티티 1만 개 60fps | 60fps | 프레임당 CPU 약 **10ms**(애니메이션 3.3ms + 렌더 제출 6.8ms)로 16.7ms 예산 안. 단, 이 개발 환경은 GPU 가 없어(SwiftShader 소프트웨어 렌더링) 실측은 1천 개 30fps · 1만 개 5~10fps | 실제 GPU 측정 필요 |
| 비개발자 이상 탐지 실험 | 대시보드 대비 50% 단축 | **아직 수행하지 않음**(참가자 실험 필요) | 미측정 |

E2E 가 확인하는 것: 세계가 열림 → 반짝 세일 경쟁 조건이 유령 상자로 보임 → 클릭한 창고의 진단이 '경쟁 조건' → 드라이런 SQL 이 맞고 실제 DB 는 그대로 → 승인 후 DB 가 바뀌고 관측으로 확인 → 잠긴 창고 주문 거절 → 되돌리기로 복구 → 과거 시점 이동 → 검증 보고서 → 브라우저 오류 0.

**주의(정직하게):**

- 벤치마크 스키마 12종은 컴파일러를 만든 사람이 함께 작성했습니다. 무작위 스키마 100종이 이를 보완하지만, '처음 보는 실제 서비스'에서의 성공률은 별도로 측정해야 합니다.
- 규칙 기반 컴파일러가 높은 통과율을 보이는 데에는 의도된 이유가 있습니다. 의미가 분명하지 않은 편집 채널을 **읽기 전용으로 닫는 보수적 설계**이기 때문입니다.
- **LLM 컴파일 경로**는 대본을 따르는 가짜 모델로 반례 되먹임·자동 수리·대체 경로를 테스트했습니다. 이 개발 환경에는 Claude API 키가 없어 **실제 API 호출로는 검증하지 못했습니다.**
- **PixelLab 생성**은 실제 API 까지 호출해 확인했습니다. 다만 연결된 계정의 구독이 만료되어 `402`(크레딧 부족)가 반환되었고, 파이프라인은 이를 감지해 즉시 멈추고 절차적 픽셀 아트로 남깁니다. 지금 보이는 그래픽은 모두 코드로 그린 것입니다.
- **Docker 어댑터**는 Engine API 를 흉내 낸 유닉스 소켓 서버로만 테스트했습니다(이 환경에 Docker 데몬이 없음).

## 한계와 다음 단계

- **관측 방식**: 관측이 폴링(기본 500ms)이라 그 사이의 짧은 상태는 놓칠 수 있습니다. 다음 단계는 Postgres 논리 복제/`LISTEN`, OpenTelemetry 트레이스 어댑터입니다.
- **행 제한**: 큰 테이블은 최신 `rowLimit` 행만 봅니다. 줌에 따른 집계(LOD)는 아직 없습니다.
- **원인 시각의 정밀도**: 원인 추적의 시각은 관측 시각과 행의 `created_at`/`updated_at` 에 기대므로, 정밀도는 그 필드에 달려 있습니다.
- **세계 테마**: 지금은 '픽셀 마을' 하나뿐입니다. 항구 도시(K8s), 도서관(AI 에이전트 메모리) 같은 문법 계열은 기획안의 다음 단계입니다.
- **보안**: 웹 UI 에 인증이 없어 기본적으로 `127.0.0.1` 에만 바인딩합니다. 쓰기는 `writeMode` 와 위험도로 제한합니다.

## 프로젝트 구조

```
packages/core       세계 문법·렌즈·검증기·불변식·원인 추적·프로토콜 (브라우저/Node 공용)
packages/compiler   Metaphor Compiler (규칙 기반 + Claude API) · 벤치마크 스키마
packages/adapters   Postgres · HTTP/JSON · Docker
packages/server     런타임 · 이벤트 저장소 · WebSocket 서버 · CLI
packages/client     PixiJS 렌더러 · 한국어 UI
packages/assets     PixelLab 에셋 파이프라인
apps/demo-shop      경쟁 조건 버그가 있는 데모 쇼핑몰
scripts/            demo · e2e · bench-compile · bench-latency
```

요구 사항: Node.js 22.13 이상(`node:sqlite` 사용).

글꼴: [갈무리(Galmuri)](https://github.com/quiple/galmuri), SIL OFL 1.1.
