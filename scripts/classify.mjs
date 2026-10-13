/**
 * 새로 수집된 기사(선별상태가 빈 행)를 Gemini API 로 분석해 시트 D~H 열에 기록함 (fetch-sheet.mjs 앞에서 실행).
 * Gemini Spark 가 시트에 직접 쓰지 못하게 막혀서(보안 정책 PERMISSION_DENIED) 대신 맡는 단계.
 * - 원문에서 본문 앞부분을 읽어 판단 (복지부는 게시판 본문, 언론사는 og:description). 못 읽으면 제목으로 판단
 * - 기록은 Apps Script 웹앱의 setFields: 그사이 관리자·Spark 가 상태를 넣은 행은 덮어쓰지 않음
 * - 한 번에 MAX 건까지, BATCH 건씩 묶어 호출. 실패한 묶음은 빈 행으로 남아 다음 실행(30분 뒤)에 다시 시도
 * - 필요한 값: SHEET_URL, GEMINI_API_KEY, GAS_URL, GAS_TOKEN (하나라도 없으면 건너뜀)
 */
import { KEY, generate } from './gemini.mjs';
import { toCsvUrl, parseCsv } from './csv.mjs';

const SHEET = toCsvUrl(process.env.SHEET_URL || '');
const GAS_URL = (process.env.GAS_URL || '').trim();
const GAS_TOKEN = (process.env.GAS_TOKEN || '').trim();
const MAX = Number(process.env.CLASSIFY_MAX) || 200;
const BATCH = 30;
const STATUSES = ['필요', '검토필요', '불필요'];
const CATEGORIES = ['국가정책/수가제도', '복지부 사업공고', '로봇수술/첨단장비', '신의료기술', 'AI·디지털헬스',
  '특성화센터/인프라', '병원경영/전략', '업체기술', '기타'];
const UA = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9',
};

if (!SHEET || !KEY || !GAS_URL || !GAS_TOKEN) {
  console.log('SHEET_URL·GEMINI_API_KEY·GAS_URL·GAS_TOKEN 중 빠진 값이 있어 기사 분석을 건너뜀');
  process.exit(0);
}

const SYSTEM = `너는 울산대학교병원(울산 지역 상급종합병원) 기획팀을 위해 의료계 뉴스를 선별하는 담당자다.
기획팀은 병원 전략·정책 대응·벤치마킹에 쓸 기사를 고른다. 기사마다 출처(매체)나 순서와 관계없이 내용만 보고 판단한다.

[선별상태]
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
'검토필요': 위 기준으로 필요/불필요가 정말 애매할 때만 쓴다. 남용하지 않는다.
 예: 정책과의 연관성이 간접적, 기초연구·해외 사례처럼 병원 적용이 불확실, 공고가 의료기관 대상인지 불분명, 기술 소개와 기업 홍보가 섞임

[분류] 아래 9개 중 하나. 기획팀이 이 기사를 찾을 때 가장 먼저 떠올릴 것.
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
- region: 시·도 단위(서울, 경기, 울산 등). 전국 단위 정책이면 전국, 해외면 해외. 모르면 빈 문자열`;

const SCHEMA = {
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

// ---------- 시트에서 빈 행 찾기 ----------
const res = await fetch(SHEET);
const csv = await res.text();
if (!res.ok || /^\s*<(!doctype|html)/i.test(csv)) {
  console.log(`::warning::시트를 읽지 못해 기사 분석을 건너뜀 (HTTP ${res.status})`);
  process.exit(0);
}
const [headers = [], ...rows] = parseCsv(csv.replace(/^﻿/, ''));
const col = re => headers.findIndex(h => re.test(h.trim()));
const C = { source: col(/출처|매체/), title: col(/제목/), status: col(/선별|상태/), date: col(/보도/), link: col(/기사\s*url|링크/i) };
if (Object.values(C).some(i => i < 0)) {
  console.log(`::warning::시트 머리글을 찾지 못해 기사 분석을 건너뜀 (${headers.join(', ')})`);
  process.exit(0);
}
const todo = rows.map((r, i) => ({ row: i + 2, r }))
  .filter(({ r }) => !String(r[C.status] || '').trim() && /^https?:\/\//.test(String(r[C.link] || '').trim()) && String(r[C.title] || '').trim())
  .slice(0, MAX)
  .map(({ row, r }) => ({ row, link: r[C.link].trim(), title: r[C.title].trim(), source: (r[C.source] || '').trim(), date: (r[C.date] || '').trim() }));
if (!todo.length) { console.log('분석할 새 기사가 없음'); process.exit(0); }
console.log(`분석할 새 기사 ${todo.length}건`);

// ---------- 원문 앞부분 ----------
const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const plain = h => decode(h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
async function bodyOf(url) {
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
for (let i = 0; i < todo.length; i += 6) {
  await Promise.all(todo.slice(i, i + 6).map(async t => { t.body = await bodyOf(t.link); }));
}
console.log(`본문을 읽은 기사 ${todo.filter(t => t.body).length}/${todo.length}건 (나머지는 제목으로 판단)`);

// ---------- 분석 → 시트 기록 ----------
let saved = 0, skipped = 0, failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const part = todo.slice(i, i + BATCH);
  const prompt = `새로 수집된 기사 ${part.length}건이다. 모든 기사를 빠짐없이 판정해 id 순서대로 배열로 답하라.\n\n` +
    part.map((t, k) => `[id ${k + 1}] ${t.title}\n출처: ${t.source} | 보도: ${t.date}\n본문: ${(t.body || '(읽지 못함, 제목으로 판단)').replace(/\s+/g, ' ')}`).join('\n\n');
  try {
    const { out, model } = await generate({ system: SYSTEM, schema: SCHEMA, prompt, temperature: 0.2 });
    const updates = [];
    for (const o of Array.isArray(out) ? out : []) {
      const t = part[o.id - 1];
      if (!t || !STATUSES.includes(o.status)) continue;
      const one = s => String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
      updates.push({
        row: t.row, link: t.link, status: o.status,
        category: CATEGORIES.includes(o.category) ? o.category : '기타',
        summary: `[${o.status}-${one(o.reason).slice(0, 12)}] ${one(o.summary)}`,
        org: one(o.org), region: one(o.region),
      });
    }
    const j = await gas({ action: 'setFields', updates });
    saved += (j.done || []).length; skipped += (j.skipped || []).length;
    const n = s => updates.filter(u => u.status === s).length;
    console.log(`  ${i + 1}~${i + part.length}: ${updates.length}건 판정 (필요 ${n('필요')} · 검토필요 ${n('검토필요')} · 불필요 ${n('불필요')}) → 시트 기록 ${(j.done || []).length}건 (${model})`);
  } catch (e) {
    failed += part.length;
    console.log(`::warning::기사 ${i + 1}~${i + part.length} 분석 실패 (${e.message}). 다음 실행에서 다시 시도합니다.`);
    if (e.fatal || e.busy) break;
  }
  if (i + BATCH < todo.length) await new Promise(r => setTimeout(r, 15000));  // 분당 요청 한도 여유
}
console.log(`기사 분석 끝: 시트 기록 ${saved}건, 이미 상태가 있어 건너뜀 ${skipped}건, 실패 ${failed}건`);

async function gas(payload) {
  // Apps Script 웹앱은 POST 뒤 302 로 결과 주소를 줌 → fetch 가 GET 으로 따라가 결과를 받음
  const r = await fetch(GAS_URL, {
    method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, token: GAS_TOKEN }), signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Apps Script 응답을 읽지 못함 (HTTP ${r.status})`); }
  if (j.status === 'error') throw new Error(`Apps Script: ${j.message}`);
  return j;
}
