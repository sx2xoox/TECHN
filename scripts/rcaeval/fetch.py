"""
RCAEval(공개 RCA 벤치마크, MIT 라이선스, Pham et al. 2025) 사례를 내려받아 ISOMORPH 재생용 스팬 파일로 바꾼다.
  python3 -I scripts/rcaeval/fetch.py --suites re2ob,re3ob --out data/rcaeval [--limit 5] [--keep-parquet]

- 사례 목록은 Hugging Face 의 공개 색인(phamquiluan/RCAEval)에서 읽는다.
- 사례마다 inject_time.txt 와 traces.parquet 만 받는다(지표·로그는 받지 않는다).
- traces.parquet 을 spans.jsonl.gz 로 바꾼다: 한 줄 = [시작ms, 길이ms, trace, span, parent, service, 이름, 상태 코드], 시작 시각 순.
- 내려받은 파일은 자료로만 읽는다(실행하지 않는다). 필요: pip install pyarrow
"""
import argparse, gzip, json, os, sys, time, urllib.request

API = 'https://huggingface.co/api/datasets/phamquiluan/RCAEval/tree/main'
RAW = 'https://huggingface.co/datasets/phamquiluan/RCAEval/resolve/main'


def get(url, timeout=300):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # 네트워크가 잠깐 끊겨도 몇 번 다시 해 본다
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--suites', default='re2ob,re3ob')
    ap.add_argument('--out', default='data/rcaeval')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--keep-parquet', action='store_true')
    a = ap.parse_args()
    import pyarrow.parquet as pq

    names = [x['path'] for x in json.loads(get(API + '?recursive=false')) if x['type'] == 'directory']
    suites = a.suites.split(',')
    for suite in suites:
        cases = sorted(n for n in names if n.startswith(suite + '_'))
        if a.limit:
            cases = cases[: a.limit]
        print(f'{suite}: 사례 {len(cases)}개', flush=True)
        for i, case in enumerate(cases):
            d = os.path.join(a.out, case)
            out = os.path.join(d, 'spans.jsonl.gz')
            if os.path.exists(out):
                continue
            os.makedirs(d, exist_ok=True)
            files = {x['path'].split('/')[-1] for x in json.loads(get(f'{API}/{case}?recursive=true'))}
            if 'traces.parquet' not in files:
                print(f'  {case}: 트레이스 없음(건너뜀)', flush=True)
                open(os.path.join(d, 'NO_TRACES'), 'w').close()
                continue
            with open(os.path.join(d, 'inject_time.txt'), 'wb') as f:
                f.write(get(f'{RAW}/{case}/inject_time.txt'))
            pqf = os.path.join(d, 'traces.parquet')
            with open(pqf, 'wb') as f:
                f.write(get(f'{RAW}/{case}/traces.parquet'))
            t = pq.read_table(pqf, columns=['traceID', 'spanID', 'parentSpanID', 'serviceName', 'operationName', 'startTime', 'duration', 'statusCode']).to_pylist()
            t.sort(key=lambda r: r['startTime'] or 0)
            with gzip.open(out + '.tmp', 'wt') as g:
                for r in t:
                    if r['startTime'] is None or r['spanID'] is None:
                        continue
                    g.write(json.dumps([r['startTime'] // 1000, (r['duration'] or 0) / 1000, r['traceID'], r['spanID'], r['parentSpanID'], r['serviceName'], r['operationName'], r['statusCode']], separators=(',', ':')) + '\n')
            os.replace(out + '.tmp', out)
            if not a.keep_parquet:
                os.remove(pqf)
            print(f'  [{i + 1}/{len(cases)}] {case}: 스팬 {len(t)}개', flush=True)


if __name__ == '__main__':
    sys.exit(main())
