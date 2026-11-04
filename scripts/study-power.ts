import { studyPower } from '@isomorph/server';

/**
 * 표본 크기 계획(검정력 모의실험): 참가자 수별로 'KPI 달성 판정이 나올 확률' 과 '윌콕슨 p<0.05 확률'.
 *   npm run study:power -- [참된 세계/표 시간 비율=0.35] [참가자별 비율의 로그 표준편차=0.5]
 * 가정이 틀리면 결과도 틀립니다. 예비 실험(파일럿)에서 비율과 흩어짐을 먼저 재고 다시 돌리세요.
 */
const trueRatio = Number(process.argv[2] ?? 0.35);
const logSd = Number(process.argv[3] ?? 0.5);
console.log(`가정: 참된 시간 비율(세계/표) 중앙값 ${trueRatio}, 참가자별 흩어짐(로그 표준편차) ${logSd}\n`);
console.log('참가자 | KPI 판정(비율 95% 구간 상한 ≤ 0.5) | 윌콕슨 p<0.05');
for (const n of [8, 12, 16, 20, 24, 30, 36, 48, 60]) {
  const p = studyPower({ n, trueRatio, logSd, sims: 300 });
  console.log(`${String(n).padStart(5)}  | ${(p.kpi * 100).toFixed(0).padStart(3)}% | ${(p.wilcoxon * 100).toFixed(0).padStart(3)}%`);
}
console.log('\n권장: KPI 판정 확률이 80% 이상이 되는 가장 작은 참가자 수를 사전 등록하세요.');
