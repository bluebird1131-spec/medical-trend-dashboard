/**
 * 구글 시트를 CSV로 읽어 data.json 으로 저장함 (GitHub Actions 에서 30분마다 실행).
 * - 시트 주소: 저장소 Settings → Secrets 의 SHEET_URL
 * - 선별상태가 '필요'·'검토필요'(예전 시트의 '선별(필요)' 포함)인 행만 공개
 *   '불필요'·'제외(…)' 행과, 수집 봇이 넣었지만 아직 AI가 분석하지 않은 빈 행은 올리지 않음
 * - 기사마다 쓸 수 있는 대표 사진 1장을 골라 data.json 의 thumbs 에 넣음 (조회 결과는 thumbs.json 에 캐시)
 *   1) 시트의 대표사진 URL — 실제로 열리는 이미지일 때만
 *   2) 원문의 og:image — 사이트 로고 제외
 *   3) 원문 본문의 첫 기사 사진
 *   여러 기사(3건 이상)에 똑같이 쓰인 사진은 기관 배너·로고로 보고 쓰지 않음
 * - 내용이 그대로면 파일을 건드리지 않음 → 바뀐 날만 커밋되어 이력이 깔끔하게 남음
 */
import { readFile, writeFile } from 'node:fs/promises';
import { toCsvUrl, parseCsv } from './csv.mjs';

const OUT = new URL('../data.json', import.meta.url);
const THUMBS = new URL('../thumbs.json', import.meta.url);
const title = process.env.SITE_TITLE || '의료계 동향';
const src = toCsvUrl(process.env.SHEET_URL || '');
const MAX_NEW = 80;          // 한 번 실행에서 새로 조회할 주소 수 (처음 연결 시 과부하 방지)
const CACHE_V = 2;           // 사진 찾는 규칙이 바뀌면 올려서 '못 찾음' 기록을 다시 조회
const GENERIC = 3;           // 이만큼 많은 기사에 같은 사진이 쓰이면 배너·로고로 봄
const BAD_IMG = /logo|noimage|no_image|no-image|default|blank|spacer|homeimg|og_img|og-img|icon|btn_|banner/i;
const BODY_IMG = /\/(news\/photo|news\/thumbnail|data\/photos|data\/news_cont|data\/editor|upload\/news|upload\/editor|files\/attach)\//i;
const NONE = '-';            // 조회했지만 쓸 만한 사진이 없음
const UA = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'ko-KR,ko;q=0.9',
};

if (!src) {
  console.log('SHEET_URL 이 설정되지 않아 건너뜀');
  process.exit(0);
}

const res = await fetch(src);
if (!res.ok) fail(`구글 시트를 읽지 못했습니다 (HTTP ${res.status}). 시트 공유가 "링크가 있는 모든 사용자"인지 확인해 주세요.`);
const text = await res.text();
// 공유 설정이 안 돼 있으면 CSV 대신 로그인 페이지(HTML)가 옴
if (/^\s*<(!doctype|html)/i.test(text)) fail('시트가 공개 상태가 아닙니다. 공유를 "링크가 있는 모든 사용자"로 바꿔 주세요.');

const [rawHeaders = [], ...rawRows] = parseCsv(text.replace(/^﻿/, ''));
const headers = rawHeaders.map(h => h.trim());
let rows = rawRows.filter(r => r.some(c => c.trim() !== ''));

// 상태 열: '필요/검토필요/불필요'(예전 시트는 '선별(필요)/제외(…)') 값이 대부분인 열.
// 아직 분석 전이라 값이 비어 있으면 머리글(선별상태)로 찾음
const SHOW = /^\[?\s*(필요|선별|검토)/;
const statusCol = (i => i >= 0 ? i : headers.findIndex(h => /선별|상태|status/i.test(h)))(
  findCol(v => /^\[?\s*(필요|불필요|선별|검토|제외)/.test(v), 0.5));
if (statusCol >= 0) {
  const before = rows.length;
  rows = rows.filter(r => SHOW.test((r[statusCol] || '').trim()));
  console.log(`상태 열 "${headers[statusCol]}" 기준 ${before}건 중 ${rows.length}건 공개 (불필요·제외·미분석 숨김)`);
}

// 사진 열(대표사진 URL 등)과 링크 열(기사 URL 등). "대표사진 URL"이 링크로 잡히지 않게 사진 열부터 찾음
const imageCol = headers.findIndex(h => /이미지|썸네일|사진|image|thumb/i.test(h));
let linkCol = headers.findIndex((h, i) => i !== imageCol && /링크|url|주소|원문|link/i.test(h));
if (linkCol < 0) linkCol = findCol(v => /^https?:\/\//i.test(v), 0.6);
const cell = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
const isUrl = u => /^https?:\/\//i.test(u);

// 같은 기사가 주소만 조금 달라 여러 번 들어간 경우(데일리메디 &page=1 등) 하나만 남김
// 기준: 목록 쪽수·추적용 값을 뺀 주소, 또는 같은 출처의 같은 제목
const titleCol = headers.findIndex(h => /제목/.test(h)), sourceCol = headers.findIndex(h => /출처|매체/.test(h));
const linkKey = u => u.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/([?&])(page|nPage|sca|sfl|stx)=[^&]*/gi, '$1').replace(/[?&]+$/, '').replace(/&&+/g, '&');
const titleKey = r => cell(r, sourceCol) + '|' + cell(r, titleCol).replace(/[\s'"‘’“”·….]/g, '').replace(/^﻿/, '');
{
  const seen = new Set(), before = rows.length;
  rows = rows.filter(r => {
    const keys = [isUrl(cell(r, linkCol)) && linkKey(cell(r, linkCol)), cell(r, titleCol) && titleKey(r)].filter(Boolean);
    if (keys.some(k => seen.has(k))) return false;
    keys.forEach(k => seen.add(k));
    return true;
  });
  if (rows.length < before) console.log(`중복 기사 ${before - rows.length}건 제외`);
}

const cache = await readFile(THUMBS, 'utf8').then(JSON.parse).catch(() => ({}));
if (cache.__v !== CACHE_V) {
  for (const k of Object.keys(cache)) {
    const old = !/^(page|chk):/.test(k);  // 예전 형식(기사 주소만 키로 쓴 기록)
    if (k !== '__v' && (old || cache[k] === NONE || BAD_IMG.test(cache[k]))) delete cache[k];
  }
  cache.__v = CACHE_V;
}

const links = rows.map(r => cell(r, linkCol)).filter(isUrl);
const sheetImgs = rows.map(r => cell(r, imageCol)).filter(isUrl);
await collect(links, 'page', pageImage);                                 // 원문에서 사진 찾기
await collect(sheetImgs.filter(u => !BAD_IMG.test(u)), 'chk', checkImage); // 시트 사진이 실제로 열리는지

// 기사별 최종 사진 고르기
const candidates = rows.map(r => {
  const s = cell(r, imageCol), p = cache['page:' + cell(r, linkCol)];
  return [cache['chk:' + s] === 'ok' ? s : '', p && p !== NONE ? p : ''];
});
const used = new Map();
candidates.flat().filter(Boolean).forEach(u => used.set(u, (used.get(u) || 0) + 1));
const thumbs = {};
rows.forEach((r, i) => {
  const pick = candidates[i].find(u => u && used.get(u) < GENERIC);
  if (pick) thumbs[cell(r, linkCol)] = pick;
});
await writeFile(THUMBS, JSON.stringify(cache, null, 1) + '\n');

const data = { title, headers, rows, thumbs };
const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
if (prev && prev.title === data.title &&
    JSON.stringify([prev.headers, prev.rows, prev.thumbs || {}]) === JSON.stringify([data.headers, data.rows, data.thumbs])) {
  console.log(`변경 없음 (${data.rows.length}건, 사진 ${Object.keys(thumbs).length}건)`);
  process.exit(0);
}

data.fetchedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');
console.log(`data.json 갱신: ${data.rows.length}건, 사진 ${Object.keys(thumbs).length}건 (${data.fetchedAt})`);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function findCol(test, ratio) {
  return headers.findIndex((_, i) => {
    const v = rows.map(r => (r[i] || '').trim()).filter(Boolean);
    return v.length && v.filter(test).length / v.length >= ratio;
  });
}

// 주소마다 한 번만 조회하고 결과를 '<종류>:<주소>' 키로 캐시
async function collect(urls, kind, fn) {
  const todo = [...new Set(urls)].filter(u => !((kind + ':' + u) in cache)).slice(0, MAX_NEW);
  let hit = 0;
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async u => {
      const v = await fn(u);
      if (v === null) return;  // 접속 자체가 실패하면 기록하지 않고 다음 실행에서 다시 시도
      cache[kind + ':' + u] = v;
      if (v !== NONE && v !== 'bad') hit++;
    }));
  }
  if (todo.length) console.log(`${kind === 'page' ? '원문 사진 조회' : '시트 사진 확인'} ${todo.length}건 중 ${hit}건 사용 가능`);
}

// 시트 사진 주소가 실제 이미지로 열리면 'ok', 404·이미지 아님이면 'bad'
async function checkImage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: UA });
    const ok = r.ok && /^image\//i.test(r.headers.get('content-type') || '');
    r.body?.cancel().catch(() => {});
    return ok ? 'ok' : 'bad';
  } catch { return null; }
}

// 원문 HTML 에서 og:image(로고 제외) → 본문 기사 사진 순으로 찾음
async function pageImage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: UA });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return NONE;
    const html = (await r.text()).slice(0, 500000);
    const abs = v => new URL(v.replace(/&amp;/g, '&').trim(), r.url).href.replace(/^http:\/\//i, 'https://');
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (!/^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src)$/i.test(key)) continue;
      const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (content && !BAD_IMG.test(content)) return abs(content);
    }
    for (const m of html.matchAll(/<img\b[^>]*\b(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) {
      if (BODY_IMG.test(m[1]) && !BAD_IMG.test(m[1])) return abs(m[1]);
    }
    return NONE;
  } catch { return null; }
}


