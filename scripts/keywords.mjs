/**
 * 분류별 보기의 '키워드 TOP 10'을 만들어 keywords.json 에 저장함 (fetch-sheet.mjs 다음에 실행).
 * - 사이트에 올리지 않는 '불필요' 기사까지 시트의 모든 기사 제목을 대상으로 함
 * - 키워드는 Gemini 가 제목 목록을 보고 고른 1~3단어 이슈 구문(예: '식약처 국정감사', '비대면 진료')
 *   Gemini 는 키워드와 제목에서 찾을 표기만 정하고, 기사 수는 여기서 제목을 직접 맞춰 셈 → 순위는 실제 기사 수
 * - 기간: 어제~오늘(today) · 최근 7일(7) · 최근 30일(30) · 전체(all) — 사이트의 기간 버튼과 같은 기준(보도일)
 * - 기사 수는 실행마다 다시 세고, Gemini 는 제목 묶음이 바뀌었고 기간별 최소 간격이 지났을 때만 다시 부름
 * - 실패하면 이전 키워드로 기사 수만 다시 세고, 키워드가 하나도 없으면 사이트는 예전처럼 제목 단어로 셈
 */
import { readFile, writeFile } from 'node:fs/promises';
import { toCsvUrl, parseCsv } from './csv.mjs';
import { KEY, generate as gemini } from './gemini.mjs';

const OUT = new URL('../keywords.json', import.meta.url);
const src = toCsvUrl(process.env.SHEET_URL || '');
const PROMPT_V = 2;      // 지시문을 바꾸면 올려서 키워드를 다시 고르게 함
const ASK = 16;          // Gemini 에게 받을 후보 수 (기사 수로 다시 줄 세워 10개 표시)
const SHOW = 10;
const MAX_TITLES = 2500; // 한 번에 보여 줄 제목 수 (전체 기간은 최근 기사부터)

if (!src) { console.log('SHEET_URL 이 설정되지 않아 건너뜀'); process.exit(0); }

const res = await fetch(src);
if (!res.ok) { console.log(`::warning::시트를 읽지 못해 키워드를 건너뜀 (HTTP ${res.status})`); process.exit(0); }
const [headers = [], ...raw] = parseCsv((await res.text()).replace(/^﻿/, ''));
const col = re => headers.findIndex(h => re.test(h.trim()));
const C = { title: col(/제목/), date: col(/보도|게재|발행/), source: col(/출처|매체/) };
if (C.title < 0) { console.log('::warning::제목 열을 찾지 못해 키워드를 건너뜀'); process.exit(0); }
const cell = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
const ymd = s => { const m = String(s).match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

// 같은 출처·같은 보도일의 같은 제목은 한 번만 (데일리메디 &page=1 중복 등. 날짜만 다른 복지부 재공고는 따로 셈)
const seen = new Set();
const arts = [];
for (const r of raw) {
  const title = cell(r, C.title).replace(/\s+/g, ' ');
  if (!title) continue;
  const key = cell(r, C.source) + '|' + cell(r, C.date) + '|' + title.replace(/[\s'"‘’“”·….]/g, '');
  if (seen.has(key)) continue;
  seen.add(key);
  arts.push({ title, low: title.toLowerCase(), date: ymd(cell(r, C.date)) });
}
arts.sort((a, b) => b.date.localeCompare(a.date));

const kst = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const now = Date.now();
const today = kst(now);
const from = n => kst(now - (n - 1) * 86400e3);
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const PERIODS = {
  today: { label: '어제~오늘', list: () => arts.filter(a => a.date >= from(2) && a.date <= today), gap: 1 },
  7: { label: '최근 7일', list: () => arts.filter(a => a.date >= from(7) && a.date <= today), gap: 3 },
  30: { label: '최근 30일', list: () => arts.filter(a => a.date >= from(30) && a.date <= today), gap: 6 },
  all: { label: '전체 기간', list: () => arts, gap: 24 },
};

const SYSTEM = `너는 울산대학교병원 기획 부서의 의료계 동향 분석 담당자다.
기사 제목 목록에서 지금 의료계에서 많이 다뤄지는 이슈 키워드를 고른다.
규칙:
- 키워드(label)는 1~3단어의 명사구로, 2~3단어 구문을 우선한다 (예: '식약처 국정감사', '비대면 진료', '의대 정원', '민간구급차 운행정보', '비만치료제').
- '병원', '환자', '의사', '진료', '국내', '우려', '관리', 'AI' 같은 넓은 단어 하나만으로 된 키워드는 쓰지 않는다. 'AI'는 '의료 AI', 'AI 진단'처럼 구체적으로 쓴다.
- 채용·합격자·인사·부고·행사 안내 같은 공지성 제목, 특정 기사 1건에만 나오는 고유명사는 키워드로 고르지 않는다.
- 숫자·건수(예: '500례')나 병원 한 곳의 이름은 키워드에 넣지 않는다.
- 여러 기사에 반복해 나오는 이슈를 고르고, 같은 이슈를 다른 표현으로 두 번 고르지 않는다.
  같은 이슈의 제품명·세부 표현은 따로 고르지 말고 한 키워드의 groups 표기로 묶는다 (예: '비만치료제' → [["비만","위고비","마운자로"]]).
- label 은 제목에 쓰인 표현을 그대로 살려 맞춤법에 맞게 쓴다.
- groups 는 제목에서 그 키워드를 찾는 표기다. 바깥 배열의 각 묶음이 모두 제목에 들어 있어야 하고, 묶음 안에서는 표기 하나만 있으면 된다.
  예: '식약처 국정감사' → [["식약처","식품의약품안전처"],["국감","국정감사"]], '비대면 진료' → [["비대면"]], '의대 정원' → [["의대","의과대학"],["정원","증원"]]
  표기는 제목에 실제로 쓰인 글자 그대로, 짧고 흔한 형태(조사 없이)로 적는다. 묶음은 1~3개.
- search 는 사이트 검색창에 넣을 대표 표기 하나다 (groups 의 표기 중 가장 그 이슈다운 것).`;
const SCHEMA = {
  type: 'OBJECT', required: ['keywords'],
  properties: {
    keywords: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT', required: ['label', 'groups', 'search'],
        properties: {
          label: { type: 'STRING' },
          groups: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } } },
          search: { type: 'STRING' },
        },
      },
    },
  },
};

const hash = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const clean = t => ({
  label: String(t.label || '').trim().slice(0, 30),
  groups: (t.groups || []).map(g => [...new Set((g || []).map(v => String(v).trim().toLowerCase()).filter(v => v.length >= 2))])
    .filter(g => g.length).slice(0, 3),
  search: String(t.search || '').trim(),
});
// 영문 표기(AI 등)는 다른 영단어 속 글자와 섞이지 않게 앞뒤가 영문이 아닐 때만
const has = (low, v) => (/^[a-z0-9 .+-]+$/.test(v)
  ? new RegExp(`(^|[^a-z])${v.replace(/[.+]/g, c => '\\' + c)}($|[^a-z])`).test(low) : low.includes(v));
const hit = (a, t) => t.groups.length && t.groups.every(g => g.some(v => has(a.low, v)));
// 기사 수로 줄 세우기. 앞 키워드와 기사가 대부분(60% 이상) 겹치면 같은 이슈로 보고 뺌
// 키워드 단어가 기간 안 어느 제목에도 없으면(오타·지어낸 말) 뺌
function rank(terms, list) {
  const inTitles = w => list.some(a => has(a.low, w.toLowerCase()));
  const rows = terms.filter(t => t.label.split(/\s+/).every(w => w.length < 2 || inTitles(w) || t.groups.flat().includes(w.toLowerCase()))).map(t => {
    const ms = list.filter(a => hit(a, t));
    const lows = ms.map(a => a.low);
    const q = [t.search.toLowerCase(), ...t.groups.flat()].find(v => v && lows.some(l => has(l, v))) || '';
    return { label: t.label, n: ms.length, q, ids: new Set(ms) };
  }).filter(x => x.n > 0 && x.label).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'ko'));
  const out = [];
  for (const x of rows) {
    if (out.some(y => y.label === x.label || [...x.ids].filter(a => y.ids.has(a)).length >= x.n * 0.6)) continue;
    out.push(x);
    if (out.length === SHOW) break;
  }
  return out.map(({ label, n, q }) => ({ label, n, q }));
}

const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));
const next = { periods: {} };
let asked = 0;
for (const [k, P] of Object.entries(PERIODS)) {
  const list = P.list();
  const old = prev.periods?.[k] || {};
  const sig = PROMPT_V + ':' + hash(list.map(a => a.title).sort().join('\n'));
  const age = old.at ? (now - new Date(old.at.replace(' ', 'T') + ':00+09:00').getTime()) / 3600e3 : Infinity;
  let { terms = [], at = '', model = '' } = old, ok = false;
  const want = list.length && KEY && old.sig !== sig &&
    (!terms.length || !String(old.sig).startsWith(PROMPT_V + ':') || age >= P.gap);
  if (want) {
    const titles = list.slice(0, MAX_TITLES).map((a, i) => `${i + 1}. ${a.title}`).join('\n');
    try {
      const r = await gemini({
        system: SYSTEM, schema: SCHEMA, temperature: 0.2,
        prompt: `${P.label} 의료계 기사 제목 ${list.length.toLocaleString()}건${list.length > MAX_TITLES ? ` 중 최근 ${MAX_TITLES}건` : ''}이다.\n` +
          `많이 다뤄진 이슈 키워드 ${ASK}개를 많이 나온 순서로 골라라.\n\n${titles}`,
      });
      const got = (r.out.keywords || []).map(clean).filter(t => t.label && t.groups.length);
      if (got.length) { terms = got; at = stamp(); model = r.model; asked++; ok = true; }
      console.log(`${P.label}: 기사 ${list.length}건에서 키워드 ${got.length}개 받음 (${r.model})`);
    } catch (e) {
      console.log(`::warning::${P.label} 키워드를 새로 고르지 못해 이전 키워드로 셉니다 (${e.message.slice(0, 200)})`);
    }
  } else if (!KEY) {
    console.log(`${P.label}: GEMINI_API_KEY 가 없어 이전 키워드로 셈`);
  }
  // 새로 고르지 못했으면 sig 를 그대로 둬서 다음 실행에서 다시 시도
  next.periods[k] = { sig: ok ? sig : old.sig || '', at, model, total: list.length, items: rank(terms, list), terms };
  console.log(`${P.label} TOP: ${next.periods[k].items.map(x => `${x.label}(${x.n})`).join(', ') || '(없음)'}`);
}

if (JSON.stringify(prev.periods || {}) === JSON.stringify(next.periods)) {
  console.log('키워드 변경 없음');
} else {
  next.updatedAt = stamp();
  await writeFile(OUT, JSON.stringify(next, null, 1) + '\n');
  console.log(`keywords.json 갱신 (Gemini ${asked}회 호출)`);
}
