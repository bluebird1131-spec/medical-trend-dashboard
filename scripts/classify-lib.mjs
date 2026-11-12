/**
 * 기사 분석(classify.mjs)과 분류 기준 검증(classify-eval.mjs)이 함께 쓰는 판정 기준·프롬프트·시트 읽기
 * - 판정 기준 v1: 2026-10-13~11-12 에 쓰던 기준 (비교·되돌리기용)
 * - 판정 기준 v2(2026-11-12부터 기본): 담당자가 관리자 페이지에서 직접 고친 판정(10/13~11/12)을 분석해 보강한 기준
 *   검증(classify-eval) 결과 담당자 판정과 일치율 57~64% → 84~88%, 잘못 올린 기사 약 4분의 1로, 대신 담당자 기사 중 45~63%만 잡음
 *   + 실행할 때마다 시트에서 담당자의 최근 판정을 예시로 붙이고(userExamples)
 *   + 최근 3일 고른 기사 제목을 함께 줘서 같은 사건의 후속 보도를 거름(recentPicks)
 * - 담당자 판정 = 선별상태 열, AI 판정 = 요약 열 앞의 [상태-사유] 표시. 둘이 다르면 담당자가 고친 것
 */
import { toCsvUrl, parseCsv } from './csv.mjs';

export const STATUSES = ['필요', '검토필요', '불필요'];
export const CATEGORIES = ['국가정책/수가제도', '복지부 사업공고', '로봇수술/첨단장비', '신의료기술', 'AI·디지털헬스',
  '특성화센터/인프라', '병원경영/전략', '업체기술', '기타'];

export const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER' },
      status: { type: 'STRING', enum: STATUSES },
      category: { type: 'STRING', enum: CATEGORIES },
      reason: { type: 'STRING' }, summary: { type: 'STRING' }, org: { type: 'STRING' }, region: { type: 'STRING' },
    },
    required: ['id', 'status', 'category', 'reason', 'summary', 'org', 'region'],
  },
};

// ---------- 판정 기준 ----------
const INTRO = `너는 울산대학교병원(울산 지역 상급종합병원) 기획팀을 위해 의료계 뉴스를 선별하는 담당자다.
기획팀은 병원 전략·정책 대응·벤치마킹에 쓸 기사를 고른다. 기사마다 출처(매체)나 순서와 관계없이 내용만 보고 판단한다.`;

const STATUS_V1 = `[선별상태]
'필요': 기획팀이 알아야 하는 기사
 1) 국가 보건의료 정책·제도: 보건복지부, 국민건강보험공단, 건강보험심사평가원, 질병관리청, 식약처의 정책 발표·계획, 수가·급여 변경, 건정심, 의료전달체계, 상급종합병원 구조전환, 필수·응급·지역의료, 의료인력(전공의·의대 정원·간호·PA), 의료법령 개정·입법예고·고시, 의료 AI·비대면진료·의료데이터 제도, 시범사업 시행·지침
 2) 타 병원의 새로운 의료서비스·기술 도입: 로봇수술·첨단장비 도입, 전문센터·병동 개소, 신규 시술 첫 시행·성과, AI·스마트병원, 새 진료·환자서비스 모델, 분원·신축 등 대형병원 전략
 3) 병원에 실질적으로 도움이 될 업체 기술: 의료기기·의료 AI·디지털 솔루션의 허가·출시·병원 적용 사례
 4) 복지부 등의 주요 사업 공고: 의료기관이 신청·참여할 수 있는 공모, 지원사업, 보조사업자 선정, 시범사업 참여기관 모집, 센터 지정 공모, 보건의료 R&D 과제 공고
 5) 그 밖에 병원 기획팀이 고려할 사항: 의료기관 평가·적정성 평가 결과, 병원계 경영 환경 변화, 병원 운영에 영향이 큰 판결
'불필요': 기획팀과 관계가 적은 기사
 - 기업의 실적·매출·주가·투자유치·M&A·IPO·임상 진행 등 재무·경영 중심 기사
 - 채용공고, 시험 합격자 발표, 인사·파견 모집, 기관장 공모, 인사 동정
 - 민간자격 등록·폐지, 행정처분, 단순 입찰, 포상 추천, 공시송달 등 의료기관 운영과 무관한 행정 공지
 - 아동·노인 소득지원, 연금, 기초생활보장, 장애인 수당 등 의료와 무관한 복지정책 (장기요양·돌봄이 병원·재택의료와 연계되면 예외)
 - 단순 행사·캠페인·기부·수상, 칼럼·인터뷰 위주, 의원급·약국만의 이슈, 정치적 공방만 있는 기사
 - 제약사의 신약 허가·적응증 확대·제네릭 경쟁·해외 진출처럼 약 하나의 시장 이야기 (병원 진료·운영이 바뀌는 내용이 아니면)
 - 업체의 해외 수출·해외 허가·해외 공급계약·기업 간 제휴·학회 발표 (국내 병원 적용 소식이 아니면)
 - 장애인 활동지원·아동·노인 일자리 등 의료기관과 연결되지 않는 복지 서비스
헷갈리기 쉬운 것:
 - 정부·공공기관 이름이 나와도 기사 중심이 기업 실적·행사·홍보면 '불필요'
 - 학회·협회의 조사·주장은 정책 변화로 이어질 내용(수가·인력·제도)일 때만 '필요'
 - '필요'는 기획팀이 실제로 챙겨 볼 기사에만 쓴다. 의료 관련이라는 이유만으로 '필요'로 하지 않는다
'검토필요': 위 기준으로 필요/불필요가 정말 애매할 때만 쓴다. 남용하지 않는다.
 예: 정책과의 연관성이 간접적, 기초연구·해외 사례처럼 병원 적용이 불확실, 공고가 의료기관 대상인지 불분명, 기술 소개와 기업 홍보가 섞임`;

// 담당자가 직접 고친 판정 분석(2026-10-13~11-12): AI '필요' 중 남긴 비율 44%→최근 20% 안팎.
// 내린 기사 경향 = 단체 성명·반발, 같은 사건 후속, 약 개별 품목, 개별 병원 수상·등급, 연구·통계, 업체 해외·출시·협약, 개별 분쟁
const STATUS_V2 = `[선별상태]
담당자는 하루 수집 기사 수십 건 가운데 열에 한두 건 정도만 '필요'로 남긴다. '필요'는 기획팀이 실제로 챙겨 볼 기사에만 쓰고, 망설여지면 '불필요'로 한다.
의료 관련이라는 이유만으로, 또는 정부·병원 이름이 나온다는 이유만으로 '필요'로 하지 않는다.
'필요': 정부·대형병원의 실제 결정·시행·도입이 담긴 기사
 1) 국가 보건의료 정책·제도: 보건복지부·건강보험공단·심사평가원·질병관리청의 정책 발표·계획·검토, 고시 제정·행정예고·법령 개정, 수가·급여 구조 변경, 상급종합병원·국립대병원 정책, 필수·응급·지역의료 제도, 의료인력 제도(전공의 정원·배정, 지역의사, 간호·PA), 비대면진료 제도, 보건의료 예산 배정·삭감
    정부가 주체인 정책·제도·예산 기사는 비판·논란·국회 지적이 함께 실렸거나 아직 '추진·검토' 단계여도 '필요'다 (정부의 해명·반박, 국회의 보건의료 예산 증감 포함). 의료기관 전체에 적용되는 제도는 의원급 이야기가 섞여 있어도 '필요'다
 2) 상급종합병원·대학병원(대학 부속·교육수련병원)의 새 서비스·시설·전략: 국내 첫 도입·첫 시행, 전문센터·병원 건립·개소, 병원 단위 시스템 구축과 실제 운영 변화(AI·스마트병원·물류 등), 부속병원 전환·분원 같은 경영 전략. 지방의료원·중소병원·전문병원·의원의 소식은 해당하지 않는다
 3) 울산대학교병원 또는 울산 지역 의료에 관한 기사 (노사·인력·시설·정책 모두)
 4) 의료기관이 직접 신청할 수 있는 복지부 등의 공모·지원사업·시범사업 참여기관 모집·센터 지정 공고
 5) 병원 운영에 직접 영향을 주는 변화: 의료기관 평가 제도 변경, 진료비 삭감·환수처럼 병원 수입과 진료 관행을 바꾸는 판결, 대형병원 파업 돌입
'불필요': 아래는 의료 관련이어도 '불필요'
 - 정부 결정 없이 학회·의사회·협회·노조·환자단체·시민단체의 성명·촉구·반발·우려·건의·토론회·포럼·설문이 중심인 기사 (실제 파업 돌입·집단 사직·지정 반납처럼 행동으로 옮긴 경우만 '필요')
 - 이미 알려진 사건·정책에 대한 후속 반응·논란·해설·전망 기사 (사건 이후 단체 반응, 수사 공방, 법안 찬반 공방 등). 새 결정·시행이 없으면 '불필요'
 - 약 관련: 개별 약제의 급여·허가·신속등재·심의(약평위·중앙약심), 식약처 안전성 서한, 의약품 수급·제형, 비만약, 약가·심사 수수료 (병원 진료체계 전체가 바뀌는 제도가 아니면)
 - 개별 병원의 수상·표창·인증·적정성 평가 등급·우수기관 선정, 개원 기념행사, 교수 개인의 성과·n례 달성 (국내 첫 사례나 병원 단위의 큰 이정표만 예외)
 - 연구 결과·논문·임상 결과·학회 발표, 질병·인구 통계, 실태조사·설문 결과
 - 업체 소식: 제품 출시, 해외 진출·수출·해외 허가, 기업 간 협약·MOU·교육, 투자·실적, 중소병원·의원의 도입 사례
 - 정부·경찰이 특정 의료기관 몇 곳을 점검·조사·수사·행정처분하는 기사, 개별 병원·의료인의 의료분쟁·소송
 - 지방의료원·중소병원·전문병원·의원·한의원·개원가·약국의 소식과 이들만의 이슈
 - 국회의원 개인 발언·정치 공방, 인사 동정, 해외 동향·국제 선언
 - 병원 경영과 먼 정부 사업: 소득·복지 지원, 자살예방, 재난 훈련, 소방·군 의료, 바이오·산업 육성, 연구 클러스터, 보건소·지자체·위탁기관 대상 공모
 - 채용공고·기관장 공모·단순 행정 공지, 기업 실적·주가·M&A, 칼럼·인터뷰 위주 기사, 단순 행사·캠페인·기부
'검토필요': 거의 쓰지 않는다. 본문을 읽지 못해 제목만으로는 도저히 판단할 수 없을 때만 쓴다.

[중복 보도]
 - '최근에 이미 고른 기사' 목록이나 이번 기사 묶음 안에 같은 사건·같은 발표를 다룬 기사가 있으면, 새로운 결정·수치·시행이 더해지지 않는 한 '불필요'로 하고 reason 은 '중복보도'로 쓴다.
 - 이번 묶음 안에서 같은 사건 기사가 여러 건이면 가장 구체적인 1건만 '필요'로 한다. 복지부 보도자료 원문이 있으면 그것을 남긴다.`;

const TAIL = `[분류] 아래 9개 중 하나. 기획팀이 이 기사를 찾을 때 가장 먼저 떠올릴 것.
 국가정책/수가제도: 정부·공공기관 정책, 법령·고시, 수가·급여·약가, 의료전달체계, 의료인력, 필수·응급·지역의료 제도, 국감 지적, 통합돌봄 제도
 복지부 사업공고: 공모·지원사업·보조사업자 선정·시범사업 참여기관 모집·지정 공고와 그 선정 결과, R&D 과제 공고
 로봇수술/첨단장비: 수술로봇·방사선치료기·영상장비 등 장비 도입·첫 시행·누적 성과
 신의료기술: 새 시술·수술법·치료법(세포·유전자치료, CAR-T 등)의 병원 적용, 임상 성과
 AI·디지털헬스: 의료 AI, 디지털치료, 스마트병원, 비대면진료 기술, 의료데이터 활용
 특성화센터/인프라: 전문센터·병동 개소, 신축·증축·분원, 병상·시설 확충
 병원경영/전략: 병원 경영지표·재정, 운영 전략, 인력 운영, 평가·인증 결과, 의료분쟁·판결
 업체기술: 의료기기·제약·바이오 업체의 제품·기술·허가·출시·실적
 기타: 위 어디에도 맞지 않는 것(채용·인사·행정 공지, 의료 외 복지정책, 행사 등)

[나머지]
- reason: 판정 사유 10자 이내 (예: 수가개편, 복지부공모, 로봇수술도입, 기업실적, 채용공고, 적용불확실)
- summary: 기사 핵심 사실 1~2문장, 명사형 문체(~함, ~예정, ~추진). "~해야 함" 같은 당위 표현 금지. 기사에 없는 내용 추가 금지
- org: 기사의 주체가 된 병원·기관명. 없으면 빈 문자열
- region: 기사 주체가 있는 시·도(서울, 경기, 울산 등). 정부·전국 단위 기관(복지부·심평원·건보공단 등)의 정책이면 전국, 해외면 해외. 본문에 근거가 없으면 빈 문자열`;

export const VERSIONS = ['v1', 'v2r', 'v2'];  // v2r = v2 기준 문구만 (예시·중복 거르기 없음, 검증용)

const clean = s => String(s || '').replace(/﻿/g, '').replace(/\s+/g, ' ').trim();
const line = x => `- ${clean(x.title)} (${clean(x.source).replace(/\(.*$/, '').slice(0, 8)})`;

/** 시스템 지시문: v2 는 담당자 판정 예시({keep, drop})를 덧붙임 */
export function buildSystem(version, examples) {
  if (version === 'v1') return `${INTRO}\n\n${STATUS_V1}\n\n${TAIL}`;
  let s = `${INTRO}\n\n${STATUS_V2}\n\n${TAIL}`;
  if (version === 'v2' && examples && (examples.keep.length || examples.drop.length)) {
    s += `\n\n[담당자 판정 예시] 기획팀 담당자가 최근 직접 확인해 정한 판정이다. 위 기준과 함께 이 예시의 판단 경향을 따른다.`;
    if (examples.keep.length) s += `\n담당자가 '필요'로 둔 기사:\n${examples.keep.map(line).join('\n')}`;
    if (examples.drop.length) s += `\nAI가 '필요'로 판정했지만 담당자가 '불필요'로 바꾼 기사:\n${examples.drop.map(line).join('\n')}`;
  }
  return s;
}

/** 묶음 프롬프트: recent(최근 고른 기사)가 있으면 중복 판단용으로 앞에 붙임 */
export function buildPrompt(part, recent) {
  const head = recent && recent.length
    ? `최근에 이미 고른 기사 (같은 사건 중복 판단용, 판정 대상 아님):\n${recent.slice(0, 80).map(line).join('\n')}\n\n` : '';
  return head + `새로 수집된 기사 ${part.length}건이다. 모든 기사를 빠짐없이 판정해 id 순서대로 배열로 답하라.\n\n` +
    part.map((t, k) => `[id ${k + 1}] ${clean(t.title)}\n출처: ${t.source} | 보도: ${t.date}\n본문: ${(t.body || '(읽지 못함, 제목으로 판단)').replace(/\s+/g, ' ')}`).join('\n\n');
}

// ---------- 시트 ----------
export const prefixOf = s => (String(s || '').trim().match(/^\[(필요|검토필요|불필요)-/) || [])[1] || '';

/** 시트를 읽어 행 목록으로. 실패하면 { error } */
export async function readSheet(sheetUrl) {
  const res = await fetch(toCsvUrl(sheetUrl));
  const csv = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(csv)) return { error: `시트를 읽지 못함 (HTTP ${res.status})` };
  const [headers = [], ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  const col = re => headers.findIndex(h => re.test(h.trim()));
  const C = {
    source: col(/출처|매체/), title: col(/제목/), status: col(/선별|상태/), date: col(/보도/), link: col(/기사\s*url|링크/i),
    summary: col(/요약|판정/), collected: col(/수집/),
  };
  if (['source', 'title', 'status', 'date', 'link'].some(k => C[k] < 0)) return { error: `시트 머리글을 찾지 못함 (${headers.join(', ')})` };
  const v = (r, k) => (C[k] < 0 ? '' : String(r[C[k]] || '').trim());
  const items = rows.map((r, i) => ({
    row: i + 2, source: v(r, 'source'), title: v(r, 'title'), status: v(r, 'status'), date: v(r, 'date'),
    link: v(r, 'link'), ai: prefixOf(v(r, 'summary')), collected: v(r, 'collected').slice(0, 10),
  }));
  return { items };
}

/**
 * 담당자 판정 예시: 담당자가 직접 고친 기사가 minFix 건 이상인 날짜(= 담당자가 정리한 날)에서
 * - keep: 담당자가 '필요'로 둔 기사 (그날 마지막으로 고친 행까지만 — 아직 안 본 오후 기사는 빼려고)
 * - drop: AI가 '필요·검토필요'로 판정했는데 담당자가 '불필요'로 바꾼 기사
 * 최근 행부터 maxKeep·maxDrop 건. beforeDate 를 주면 그 날짜보다 앞선 날짜만 (검증용)
 */
export function userExamples(items, { beforeDate = '9999-99-99', minFix = 3, maxKeep = 30, maxDrop = 50 } = {}) {
  const fixes = {}, lastFix = {};
  for (const x of items) {
    if (!x.ai || !STATUSES.includes(x.status) || x.ai === x.status) continue;
    fixes[x.collected] = (fixes[x.collected] || 0) + 1;
    lastFix[x.collected] = Math.max(lastFix[x.collected] || 0, x.row);
  }
  const pool = items.filter(x => x.collected < beforeDate && (fixes[x.collected] || 0) >= minFix && x.title)
    .sort((a, b) => b.row - a.row);
  return {
    keep: pool.filter(x => x.status === '필요' && x.row <= lastFix[x.collected]).slice(0, maxKeep),
    drop: pool.filter(x => x.status === '불필요' && (x.ai === '필요' || x.ai === '검토필요')).slice(0, maxDrop),
  };
}

/** 최근 고른 기사: fromDate 이후 수집된 '필요·검토필요' 기사 (beforeRow 보다 앞 행만), 최근 행부터 max 건 */
export function recentPicks(items, { fromDate, beforeRow = Infinity, max = 60 }) {
  return items.filter(x => x.collected >= fromDate && x.row < beforeRow && (x.status === '필요' || x.status === '검토필요') && x.title)
    .sort((a, b) => b.row - a.row).slice(0, max);
}

/** 한국 시간 기준 날짜 (offsetDays 만큼 더함) */
export const kstDate = (offsetDays = 0, from = Date.now()) => new Date(from + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10);

// ---------- 원문 앞부분 ----------
const UA = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9',
};
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const plain = h => decode(h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
export async function bodyOf(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return '';
    const h = await r.text();
    const view = h.match(/<article class="board_view"[\s\S]*?<\/article>/i);  // 복지부 게시판
    if (view) return plain(view[0]).replace(/\n?(첨부파일|다운로드|미리보기)[\s\S]*$/, '').slice(0, 1200);
    const og = h.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
      || h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    return og ? decode(og[1]).replace(/^﻿+/, '').trim().slice(0, 800) : '';
  } catch { return ''; }
}
/** 목록의 각 항목에 body 를 채움 (6건씩 동시에) */
export async function fillBodies(list) {
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async t => { t.body = await bodyOf(t.link); }));
  }
  return list.filter(t => t.body).length;
}
