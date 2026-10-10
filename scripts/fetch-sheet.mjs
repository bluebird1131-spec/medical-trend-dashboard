/**
 * 구글 시트를 CSV로 읽어 data.json 으로 저장함 (GitHub Actions 에서 30분마다 실행).
 * - 시트 주소: 저장소 Settings → Variables 의 SHEET_URL
 * - '제외(중복)', '제외(불필요)' 행은 올리지 않음 (선별·검토필요만 공개)
 * - 기사 원문의 대표 이미지(og:image)를 모아 thumbs.json 에 캐시 → 목록 썸네일로 사용
 * - 내용이 그대로면 파일을 건드리지 않음 → 바뀐 날만 커밋되어 이력이 깔끔하게 남음
 */
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data.json', import.meta.url);
const THUMBS = new URL('../thumbs.json', import.meta.url);
const title = process.env.SITE_TITLE || '의료계 동향';
const src = toCsvUrl(process.env.SHEET_URL || '');
const MAX_NEW_THUMBS = 80;  // 한 번 실행에서 새로 조회할 기사 수 (처음 연결 시 과부하 방지)

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

// 상태 열: '선별(필요)/검토필요/제외(…)' 값이 대부분인 열
const statusCol = findCol(v => /^(선별|검토|제외)/.test(v), 0.5);
if (statusCol >= 0) {
  const before = rows.length;
  rows = rows.filter(r => !/^제외/.test((r[statusCol] || '').trim()));
  console.log(`상태 열 "${headers[statusCol]}" 기준 제외 ${before - rows.length}건 숨김`);
}

// 링크 열: 머리글 이름 또는 값이 대부분 http 로 시작하는 열
let linkCol = headers.findIndex(h => /링크|url|주소|원문|link/i.test(h));
if (linkCol < 0) linkCol = findCol(v => /^https?:\/\//i.test(v), 0.6);

const cache = await readFile(THUMBS, 'utf8').then(JSON.parse).catch(() => ({}));
if (linkCol >= 0) await collectThumbs(rows.map(r => (r[linkCol] || '').trim()).filter(u => /^https?:\/\//i.test(u)));
const thumbs = {};
if (linkCol >= 0) rows.forEach(r => { const u = (r[linkCol] || '').trim(); if (cache[u]) thumbs[u] = cache[u]; });
await writeFile(THUMBS, JSON.stringify(cache, null, 1) + '\n');

const data = { title, headers, rows, thumbs };
const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
if (prev && prev.title === data.title &&
    JSON.stringify([prev.headers, prev.rows, prev.thumbs || {}]) === JSON.stringify([data.headers, data.rows, data.thumbs])) {
  console.log(`변경 없음 (${data.rows.length}건)`);
  process.exit(0);
}

data.fetchedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');
console.log(`data.json 갱신: ${data.rows.length}건, 썸네일 ${Object.keys(thumbs).length}건 (${data.fetchedAt})`);

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

// 원문 HTML 의 og:image / twitter:image 주소를 모음. 실패하면 빈 값으로 기록해 다시 조회하지 않음
async function collectThumbs(urls) {
  const todo = [...new Set(urls)].filter(u => !(u in cache)).slice(0, MAX_NEW_THUMBS);
  let found = 0;
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async u => {
      cache[u] = await ogImage(u);
      if (cache[u]) found++;
    }));
  }
  if (todo.length) console.log(`대표 이미지 조회 ${todo.length}건 중 ${found}건 찾음`);
}

async function ogImage(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; medical-trend-dashboard/1.0)', 'accept-language': 'ko-KR,ko;q=0.9' },
    });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return '';
    const html = (await r.text()).slice(0, 300000);
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      if (!/^(og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src)$/i.test(key)) continue;
      const content = (tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (content) return new URL(content.replace(/&amp;/g, '&').trim(), r.url).href.replace(/^http:\/\//i, 'https://');
    }
  } catch {}
  return '';
}

// 일반 시트 주소(/edit), 웹에 게시 주소(/pubhtml), CSV 주소 모두 받아 CSV 주소로 변환
export function toCsvUrl(url) {
  url = url.trim();
  if (!url) return '';
  const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
  const pub = url.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) {
    return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv` + (gid ? `&gid=${gid}` : '');
  }
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (id) {
    return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv&gid=${gid || 0}`;
  }
  return url;
}

// RFC 4180 CSV 파서 (따옴표 안의 쉼표·줄바꿈 처리)
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
