# 사용자 실험 진행자 안내

이 폴더는 ISOMORPH 의 핵심 주장을 사람을 대상으로 검증하는 데 필요한 문서입니다. 검증할 주장은 하나입니다.

> 코드를 못 읽는 사람도 흔한 대시보드(표)보다 이 세계에서 규칙을 어긴 곳을 **더 빨리·정확히** 찾는다.

| 문서 | 용도 | 언제 |
|---|---|---|
| [PROTOCOL.md](PROTOCOL.md) | 연구 계획서: 가설, 설계, 절차, 진행자 대본, 분석 계획, 제외 기준 | 시작 전에 읽고 고정 |
| [PREREGISTRATION.md](PREREGISTRATION.md) | 사전 등록 양식(AsPredicted 형식, 미리 채움) | 본 실험 **전에** 등록 |
| [RECRUITMENT.md](RECRUITMENT.md) | 모집 공고와 선별 질문 | 모집할 때 |
| [CONSENT.md](CONSENT.md) | 인쇄용 설명문·동의서(화면의 동의와 같은 내용) | 참가자를 만날 때 |
| [CHECKLIST.md](CHECKLIST.md) | 회차마다 쓰는 점검표(전·중·후) | 매 회차 |
| [PROTOCOL-RCA.md](PROTOCOL-RCA.md) | 두 번째 실험: 여러 시스템에 번진 장애의 근본 원인 찾기(계획서 + 사전 등록 요약) | 따로 등록하고 따로 진행 |

## 빠른 시작

```bash
npm install && npm run build
```

```bash
npm run study
```

- 콘솔에 세 주소가 나옵니다. 참가자 화면(`/study`), 예비 참가자용 주소(`/study?pilot=1`), 진행자 화면(`/study/admin?token=…`)입니다.
- 진행자 화면 주소는 참가자에게 보이지 않게 하세요.
- 기록은 `data/study/*.jsonl` 에 쌓입니다. 이 폴더는 git 에 올라가지 않습니다.

## 권장 순서

1. **예비 실험(파일럿) 3~5명**: `/study?pilot=1` 로 진행하고, 이 기록은 본 분석에서 자동으로 빠집니다. 화면·설명·시간이 매끄러운지 보고, 시간 비율과 흩어짐을 대략 잽니다.
2. **표본 크기 정하기**: 예비 실험에서 본 비율과 흩어짐을 넣어 `npm run study:power -- <비율> <흩어짐>` 을 돌립니다. KPI 판정 확률이 80% 이상인 가장 작은 인원을 고릅니다(기본 가정 0.35·0.5 에서는 약 24명).
3. **연구윤리 심의**: 소속 기관 IRB 에서 심의(또는 면제 확인)를 받습니다.
4. **사전 등록**: [PREREGISTRATION.md](PREREGISTRATION.md) 를 채워 AsPredicted·OSF 등에 등록합니다. 날짜가 찍힌 기록을 남기는 것이 핵심입니다.
5. **본 실험**: [CHECKLIST.md](CHECKLIST.md) 대로 진행합니다. 정해 둔 인원이 차면 멈추고, 중간에 결과를 보고 인원을 바꾸지 않습니다.
6. **분석**: 사전 등록한 대로 `npm run study:analyze -- data/study --out report.md --csv trials.csv` 를 돌립니다. 결과는 좋든 나쁘든 그대로 공개합니다.

## 도구가 이미 지키는 것

- **정답 비공개**: 정답은 서버에만 있습니다. 화면에는 정답이 실리지 않습니다.
- **조건 순서 균형**: 참가 번호가 짝수면 세계를 먼저, 홀수면 표를 먼저 봅니다. 철회한 번호는 다시 쓰지 않습니다.
- **분석 대상 거르기**: 예비·제외·미완료 참가자는 기본으로 분석에서 뺍니다.
- **철회**: 진행자 화면에서 그 참가자의 기록만 지웁니다. 감사 기록에는 번호와 시각만 남습니다.

## 두 번째 실험: 근본 원인 찾기

```bash
STUDY_TASK=rca STUDY_CONDITIONS=world,table,table+alerts STUDY_DATA=data/study-rca npm run study
```

```bash
npm run study:analyze -- data/study-rca --task rca --out report-rca.md --csv trials-rca.csv
```

- 클러스터와 서비스로 장애가 번진 장면에서, 고객 화면(frontend)이 실패한 근본 원인(노드·디플로이먼트·서비스)을 찾습니다. 자세한 것은 [PROTOCOL-RCA.md](PROTOCOL-RCA.md) 에 있습니다.
- 모든 조건이 같은 표·변경 기록을 받습니다. 엔진의 살펴보기(진단·근본 원인 사슬)는 세계와 '표 + 위반 강조' 에만 줍니다.
- 기록 폴더는 첫 실험과 나누세요. 분석은 과제 종류를 섞지 않으며, `--task` 가 없으면 기록에 있는 종류마다 따로 보고서를 냅니다.
