import { colorDistance, MIN_DISTINGUISHABLE_DE, VISIONS, type ColorName, type Region, type SpriteKey } from '@isomorph/core';

/** 이름 의미론 사전: 컬렉션·필드 이름에서 세계의 은유를 고른다. */

export interface PlaceGroup {
  re: RegExp;
  sprite: SpriteKey;
  title: string;
  region: Region;
}

const R = {
  market: { id: 'market', title: '시장', theme: 'market' },
  residential: { id: 'residential', title: '주택가', theme: 'residential' },
  finance: { id: 'finance', title: '금융가', theme: 'finance' },
  industrial: { id: 'industrial', title: '공업지대', theme: 'industrial' },
  civic: { id: 'civic', title: '학문 거리', theme: 'civic' },
  farmland: { id: 'farmland', title: '들판', theme: 'farmland' },
  plaza: { id: 'plaza', title: '광장', theme: 'plaza' },
} satisfies Record<string, Region>;
export const REGIONS = R;
export const REGION_ORDER = ['market', 'residential', 'finance', 'industrial', 'civic', 'farmland', 'plaza'];

/** 짧은 단어는 이름 조각 경계에서만 맞춘다(port ≠ report, bus ≠ business, trip ≠ stripe) */
const w = (...words: string[]) => new RegExp(`(^|_)(${words.join('|')})(e?s)?($|_)`, 'i');

export const PLACE_GROUPS: PlaceGroup[] = [
  { re: /(product|item|inventor|stock|sku|goods|warehouse|depot|stockroom)/i, sprite: 'warehouse', title: '창고', region: R.market },
  { re: /(customer|user|member|patient|student|person|people|employee|citizen|client|resident|owner|author|subscriber|player|passenger|traveler|traveller|guest|contact|applicant|candidate|participant|attendee|volunteer|donor|tenant|staff|actor|actress|artist|singer|performer|director|composer|writer|creator|contributor)/i, sprite: 'house', title: '집', region: R.residential },
  { re: /(account|wallet|payment|invoice|bank|ledger|budget|fund)/i, sprite: 'bank', title: '은행', region: R.finance },
  // 인프라의 층위를 모양으로 가른다: 기계(노드·호스트) → 그 위에서 몇 개를 돌릴지 정하는 관리소(디플로이먼트) → 실제로 일하는 공장(파드·컨테이너)
  { re: w('node', 'host', 'machine', 'vm', 'server', 'cluster'), sprite: 'tower', title: '서버탑', region: R.industrial },
  { re: w('deployment', 'statefulset', 'daemonset', 'replicaset', 'replica_set', 'autoscaler', 'scale_set'), sprite: 'office', title: '관리소', region: R.industrial },
  { re: /(container|server|node|host|service|pod|machine|instance|worker|cluster|vm|deployment|process|truck|vehicle|tool|workshop|plugin|skill)/i, sprite: 'factory', title: '공장', region: R.industrial },
  { re: /(book|library|article|document|post|page|wiki|course|class|lesson|school|file|memory|note)/i, sprite: 'library', title: '도서관', region: R.civic },
  { re: /(doctor|hospital|ward|clinic|room|bed|nurse)/i, sprite: 'clinic', title: '진료소', region: R.civic },
  { re: /(sensor|device|meter|station|tower|antenna|gateway|probe)/i, sprite: 'tower', title: '관측탑', region: R.industrial },
  { re: /(store|shop|merchant|vendor|seller|restaurant|branch|location)/i, sprite: 'shop', title: '가게', region: R.market },
  { re: /(farm|field|crop|plant|garden)/i, sprite: 'farm', title: '농장', region: R.farmland },
  { re: /(mail|letter|notification|inbox|channel)/i, sprite: 'post', title: '우체국', region: R.civic },
  // 콘텐츠(영화·음악·방송·게임·사진)
  { re: /(film|movie|video|cinema|episode|series|season|album|song|music|playlist|podcast|media|photo|picture|image|gallery|broadcast|concert)|(^|_)(tracks?|shows?|games?|streams?)($|_)/i, sprite: 'theater', title: '극장', region: R.civic },
  // 운송·여행
  { re: /(flight|airport|airline|aircraft|airplane|runway|railway|voyage|shipping_line)|(^|_)(planes?|routes?|trips?|trains?|bus|buses|ships?|vessels?|ports?|harbou?rs?|terminals?|gates?|seats?|stops?)($|_)/i, sprite: 'station', title: '역', region: R.industrial },
  // 조직·거래처
  { re: /(compan|organi[sz]ation|department|employer|office|agenc|contractor|provider|institution|universit|faculty|division|committee|supplier|shipper|carrier|partner)|(^|_)(orgs?|teams?|groups?|depts?|units?|firms?)($|_)/i, sprite: 'office', title: '사무소', region: R.finance },
  // 지리
  { re: /(countr|cit(y|ies)|region|territor|province|district|county|address|continent|neighbou?rhood|postal|postcode|zipcode|timezone)|(^|_)((us_)?states?|areas?|zones?|places?|sites?)$/i, sprite: 'signpost', title: '이정표', region: R.plaza },
];
export const DEFAULT_PLACE: PlaceGroup = { re: /.*/, sprite: 'shop', title: '건물', region: R.market };
/** 다른 테이블이 가리키는 작은 기준표(분류·코드·종류): 이름이 아니라 구조로 알아본다 */
export const LOOKUP_PLACE: PlaceGroup = { re: /.*/, sprite: 'signpost', title: '분류 표지판', region: R.plaza };
/** 사건처럼 이름 붙었지만 다른 행이 가리키는 곳(예: 주문 → 주문 상세): 접수처 */
export const EVENT_PLACE: PlaceGroup = { re: /.*/, sprite: 'post', title: '접수처', region: R.market };

/**
 * 필드 특징: 테이블 이름이 낯설어도 '무엇을 담고 있나' 로 고른다(이름 사전 다음, 일반 은유 전에).
 * 필드 이름 하나가 아니라 같은 묶음의 필드가 있는지를 본다.
 */
export interface FieldSignature {
  id: 'money' | 'text' | 'geo' | 'file' | 'job' | 'person';
  re: RegExp;
  place: PlaceGroup;
  walker: WalkerGroup;
}
export const FIELD_SIGNATURES: FieldSignature[] = [
  { id: 'job', re: /^(started_at|finished_at|completed_at|failed_at|run_at|scheduled_at|attempts|retries|retry_count|duration(_ms)?|queue|progress)$/i, place: { re: /.*/, sprite: 'factory', title: '작업장', region: R.industrial }, walker: { re: /.*/, sprite: 'robot', title: '일꾼 로봇' } },
  { id: 'money', re: /^(price|amount|cost|fee|balance|total|subtotal|currency|salary|tax|discount|.*_(price|amount|cents|total))$/i, place: { re: /.*/, sprite: 'bank', title: '은행', region: R.finance }, walker: { re: /.*/, sprite: 'merchant', title: '상인' } },
  { id: 'geo', re: /^(lat|lng|lon|latitude|longitude|geom|geometry|coordinates|address(_line)?\d?|city|country(_code)?|postal_code|zip(code)?|region)$/i, place: { re: /.*/, sprite: 'signpost', title: '이정표', region: R.plaza }, walker: { re: /.*/, sprite: 'villager', title: '여행자' } },
  { id: 'file', re: /^(filename|file_name|content_type|byte_size|file_size|mime_type|checksum|attachment.*|.*_file_name|.*_content_type)$/i, place: { re: /.*/, sprite: 'warehouse', title: '보관 창고', region: R.industrial }, walker: { re: /.*/, sprite: 'courier', title: '배달부' } },
  { id: 'text', re: /^(body|content|message|text|html|markdown|comment|raw|cooked|.*_body|.*_html|.*_markdown)$/i, place: { re: /.*/, sprite: 'library', title: '도서관', region: R.civic }, walker: { re: /.*/, sprite: 'courier', title: '배달부' } },
  { id: 'person', re: /^(email|first_name|last_name|username|full_name|phone|avatar.*|birth.*|gender)$/i, place: { re: /.*/, sprite: 'house', title: '집', region: R.residential }, walker: { re: /.*/, sprite: 'villager', title: '방문객' } },
];
/** 많은 테이블이 가리키는 중심 건물(구조) */
export const HUB_PLACE: PlaceGroup = { re: /.*/, sprite: 'office', title: '회관', region: R.civic };

export interface WalkerGroup {
  re: RegExp;
  sprite: SpriteKey;
  title: string;
}
export const WALKER_GROUPS: WalkerGroup[] = [
  { re: /(order|purchase|sale|cart|checkout|booking|reservation|transfer|transaction|trade|payment|refund|deposit|withdrawal|charge|donation|bid|claim)/i, sprite: 'merchant', title: '상인' },
  { re: /(shipment|delivery|message|parcel|package|dispatch|notification)/i, sprite: 'courier', title: '배달부' },
  { re: /(request|event|reading|metric|sample|alert|incident|invocation)|(^|_)(jobs?|tasks?|logs?|runs?|builds?|calls?|steps?)($|_)/i, sprite: 'robot', title: '일꾼 로봇' },
  { re: /(rental|loan|borrow|lease|hire)/i, sprite: 'villager', title: '대여 손님' },
  { re: /(boarding|check_?in|journey|ride|itinerar|segment)/i, sprite: 'villager', title: '여행자' },
  { re: /(visit|attendance|enrol|session|login|page_?views?)|(^|_)(views?|clicks?|plays?|listens?|watch(es)?)($|_)/i, sprite: 'villager', title: '방문객' },
  { re: /(review|rating|comment|repl(y|ies)|reaction|favou?rite|bookmark|mention)|(^|_)(likes?|votes?|follows?|followers?)($|_)/i, sprite: 'villager', title: '이야기꾼' },
];
export const DEFAULT_WALKER: WalkerGroup = { re: /.*/, sprite: 'villager', title: '주민' };

export const LANDMARK_RE = /(stat|metric|health|summary|overview|dashboard|config|setting|gateway_stats|status$)/i;

/* 필드 의미론 */
export const LABEL_RE = /^(name|title|label|hostname|display_name|full_name|username|nickname|plate|sku|code|slug)$/i;
export const STACK_RE = /(stock|quantity|qty|inventor|available|remaining|units|capacity_left|seats|beds_available|copies|replicas|balance|free)/i;
export const RESTOCK_RE = /(stock|inventor|quantity|qty|available|units|copies|replicas|seats|beds)/i;
export const CROWD_RE = /(calls?$|calls_|request|rps|qps|throughput|visitor|traffic|connection|session|online_users|active_users|load|queue|pending|backlog|cpu|usage|utiliz|mem|enrolled|followers|views|count$|used)/i;
export const FIRE_RE = /(error|fail|exception|crash|incident|alert|restart|reject|drop)/i;
export const SPEED_RE = /(latency|duration|response_time|delay|_ms$|elapsed|wait|p9\d)/i;
export const MONEY_RE = /(price|cost|amount|fee|salary|revenue|total$|payment)/i;
export const LIT_RE = /(active|enabled|open|available|online|published|visible|ready|healthy|on_call|in_stock|verified|^is_)/i;
export const FOG_RE = /(blocked|disabled|banned|offline|locked|deleted|archived|hidden|frozen|suspended|muted|outside|external|foreign)/i;
export const ENUM_RE = /(status|state|phase|stage|level|tier|type|kind|category|role|priority|plan|severity|condition|grade|specialty)/i;
export const SIGN_RE = /(image|city|location|region|category|brand|author|model|specialty|namespace|destination|zone|genre|dir$|folder)/i;
export const CREATED_RE = /^(created|inserted|opened|started|issued|recorded|scheduled|admitted)(_at|_on|_time)?$/i;
export const RUNNING_VALUES = ['running', 'active', 'open', 'online', 'healthy', 'up', 'ready', 'ok', 'enabled', 'available', 'published'];
export const STOPPED_VALUES = ['exited', 'stopped', 'inactive', 'closed', 'offline', 'down', 'disabled', 'paused', 'dead'];
export const CANCEL_VALUES = ['cancelled', 'canceled', 'revoked', 'aborted', 'returned'];

const COLOR_FAMILIES: [RegExp, ColorName[]][] = [
  [/^(gold|premium|vip)$/i, ['yellow', 'orange']],
  [/^(silver|standard)$/i, ['gray', 'blue']],
  [/^(bronze|basic|free)$/i, ['brown', 'orange']],
  [/^(platinum|diamond|enterprise)$/i, ['teal', 'blue']],
  [/^(ok|active|paid|success|succeeded|running|completed?|done|delivered|open|online|healthy|approved|available|published|resolved|up|ready|returned|enrolled|discharged|stable|low)$/i, ['green', 'teal']],
  [/^(pending|waiting|queued|created|processing|in_progress|new|draft|scheduled|starting|review|shipped|in_transit|borrowed|medium|moderate)$/i, ['yellow', 'orange']],
  [/^(failed|failing|failure|error|rejected|dead|exited|crashed|down|offline|unhealthy|blocked|banned|overdue|expired|critical|high|lost)$/i, ['red', 'pink']],
  // 주의(아직 실패는 아님): 노랑·주황 계열
  [/^(degraded|warning|warn|unstable|slow|at_risk)$/i, ['orange', 'yellow']],
  [/^(cancelled|canceled|refunded|restarting|stopped|paused|suspended|archived|revoked|unset|unknown)$/i, ['gray', 'brown']],
];
const NEUTRAL: ColorName[] = ['blue', 'purple', 'teal', 'pink', 'brown', 'orange', 'green', 'yellow', 'red', 'gray'];

/** 이미 쓴 색들과 '가장 헷갈리는 색각 유형에서' 얼마나 달라 보이는가 */
function worstSeparation(c: ColorName, used: Iterable<ColorName>): number {
  let worst = Infinity;
  for (const u of used) for (const v of VISIONS) worst = Math.min(worst, colorDistance(c, u, v));
  return worst;
}

/** 후보를 선호 순서대로 보되, 색각 이상에서도 이미 쓴 색과 구분되는 첫 색을 고른다(없으면 가장 덜 헷갈리는 색) */
function pickColor(candidates: ColorName[], used: Set<ColorName>): ColorName {
  const free = candidates.filter((c) => !used.has(c));
  const ok = free.find((c) => worstSeparation(c, used) >= MIN_DISTINGUISHABLE_DE);
  return ok ?? free.reduce((best, c) => (worstSeparation(c, used) > worstSeparation(best, used) ? c : best), free[0]);
}

/**
 * 값마다 서로 다른 색(단사성)을 배정하고, 남는 색 하나를 '미지의 값'용으로 남긴다.
 * 뜻에 맞는 색 계열을 먼저 보되, 적색맹·녹색맹·청색맹에서도 앞서 고른 색과 구분되는 색을 고른다.
 */
export function assignColors(values: string[]): { map: Record<string, ColorName>; fallback: ColorName } {
  const used = new Set<ColorName>();
  const map: Record<string, ColorName> = {};
  const limited = values.slice(0, 9);
  for (const v of limited) {
    const family = COLOR_FAMILIES.find(([re]) => re.test(v))?.[1] ?? [];
    const pick = pickColor([...new Set([...family, ...NEUTRAL])], used);
    map[v] = pick;
    used.add(pick);
  }
  const fallback = pickColor([...new Set([...(['purple', 'pink', 'blue', 'teal', 'brown', 'gray', 'orange'] as ColorName[]), ...NEUTRAL])], used);
  return { map, fallback };
}

/** 10 이상의 '깔끔한' 상한값(10의 배수). 상자 스케일이 정수 비율이 되도록 한다. */
export function niceCeil(x: number): number {
  if (!Number.isFinite(x) || x <= 10) return 10;
  const step = Math.pow(10, Math.floor(Math.log10(x)));
  return Math.ceil(x / step) * step;
}

export function slugify(s: string): string {
  const x = s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return x || 'kind';
}
