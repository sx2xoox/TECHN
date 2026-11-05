# 장애 기록: payments — 2026. 11. 5. 7시 59분 51초

- 시스템: kubernetes + otel
- 기간: 7시 59분 51초 ~ 8시 0분 27초 (37초)
- 근본 원인: payments (`k8s_deployments #shop/payments`) — 준비된 복제본 수가 원하는 수에 닿아야 함 ([그 시점의 세계](https://isomorph.example.com/?focus=k8s_deployments%3Ashop%2Fpayments&at=1793865591261))
- 위반 직전의 변경: `image` `"registry.example/app:1.0"` → `"registry.example/app:2.0-broken"`
- 영향: 3곳 — payments(k8s\_deployments), payments(otel\_services), web(otel\_services)
- 조치: 직전 변경 되돌리기: image (관측으로 확인됨)
- 첫 조치까지: 30초 · 조치 뒤 회복까지: 6초

## 타임라인

| 시각 | 일 |
|---|---|
| 7시 59분 51초 | 법칙 위반 시작: payments — 준비된 복제본 수가 원하는 수에 닿아야 함 ([그 시점의 세계](https://isomorph.example.com/?focus=k8s_deployments%3Ashop%2Fpayments&at=1793865591261)) |
| 7시 59분 53초 | 법칙 위반 시작: payments — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태) ([그 시점의 세계](https://isomorph.example.com/?focus=otel_services%3Apayments&at=1793865593328)) |
| 7시 59분 53초 | 법칙 위반 시작: web — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태) ([그 시점의 세계](https://isomorph.example.com/?focus=otel_services%3Aweb&at=1793865593328)) |
| 8시 0분 21초 | 조치(승인 후 실행): 직전 변경 되돌리기: image ([그 시점의 세계](https://isomorph.example.com/?focus=k8s_deployments%3Ashop%2Fpayments&at=1793865621754)) |
| 8시 0분 21초 | 회복: payments — 준비된 복제본 수가 원하는 수에 닿아야 함 ([그 시점의 세계](https://isomorph.example.com/?focus=k8s_deployments%3Ashop%2Fpayments&at=1793865621767)) |
| 8시 0분 21초 | 관측으로 확인됨: 직전 변경 되돌리기: image ([그 시점의 세계](https://isomorph.example.com/?focus=k8s_deployments%3Ashop%2Fpayments&at=1793865621775)) |
| 8시 0분 27초 | 회복: payments — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태) ([그 시점의 세계](https://isomorph.example.com/?focus=otel_services%3Apayments&at=1793865627821)) |
| 8시 0분 27초 | 회복: web — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태) ([그 시점의 세계](https://isomorph.example.com/?focus=otel_services%3Aweb&at=1793865627821)) |

## 깨진 법칙

- **payments** (`k8s_deployments #shop/payments`) — 준비된 복제본 수가 원하는 수에 닿아야 함: 7시 59분 51초 ~ 8시 0분 21초 (31초)
  - 진단: 직전 변경 뒤에 깨짐: 위반이 시작되기 직전에 이 개체가 바뀌었습니다(image: "registry.example/app:1.0" → "registry.example/app:2.0-broken"). 그 뒤 '준비된 복제본 수가 원하는 수에 닿아야 함' 가 깨졌습니다.
- **payments** (`otel_services #payments`) — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태): 7시 59분 53초 ~ 8시 0분 27초 (34초)
  - 진단: 다른 시스템의 연결된 곳이 먼저 법칙을 어김: k8s\_deployments #shop/payments 가 '준비된 복제본 수가 원하는 수에 닿아야 함' 를 먼저 어겼고(ready\_replicas: 2 → 0, status: "available" → "progressing"), 그 뒤에 이 법칙이 깨졌습니다. 이 위반은 그 결과일 수 있습니다.
- **web** (`otel_services #web`) — 서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태): 7시 59분 53초 ~ 8시 0분 27초 (34초)
  - 진단: 오류가 다른 곳에서 시작됨: 실패한 요청을 따라 내려가 보면 오류는 otel\_services #payments 에서 시작됐습니다('서비스의 오류 비율이 절반을 넘으면 안 됨(실패 상태)'). 이 위반은 그 오류가 이어져 온 결과입니다.

## 실행한 명령

- 8시 0분 21초 직전 변경 되돌리기: image — verified
  - `[k8s] kubectl set image deployment/payments -n shop app=registry.example/app:1.0`

---
ISOMORPH 가 관측 기록으로 만든 보고서입니다. 원인은 관측된 순서와 트레이스로 추정한 것이며, 사람이 확인해야 합니다.