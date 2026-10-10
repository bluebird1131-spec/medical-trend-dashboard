/**
 * 구글 시트를 CSV로 읽어 data.json 으로 저장함 (GitHub Actions 에서 30분마다 실행).
 * - 시트 주소: 저장소 Settings → Variables 의 SHEET_URL
 * - 내용이 그대로면 파일을 건드리지 않음 → 바뀐 날만 커밋되어 이력이 깔끔하게 남음
 */
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data.json', import.meta.url);
const title = process.env.SITE_TITLE || '의료계 동향';
const src = toCsvUrl(process.env.SHEET_URL || '');

if (!src) {
  console.log('SHEET_URL 이 설정되지 않아 건너뜀');
  process.exit(0);
}

const res = await fetch(src);
if (!res.ok) fail(`구글 시트를 읽지 못했습니다 (HTTP ${res.status}).`);
const text = await res.text();
// 공유 설정이 안 돼 있으면 CSV 대신 로그인 페이지(HTML)가 옴
if (/^\s*<(!doctype|html)/i.test(text)) fail('시트가 공개 상태가 아닙니다. 공유를 "링크가 있는 모든 사용자"로 바꿔 주세요.');

const [headers = [], ...rows] = parseCsv(text.replace(/^﻿/, ''));
const data = {
  title,
  headers: headers.map(h => h.trim()),
  rows: rows.filter(r => r.some(c => c.trim() !== '')),
};

const prev = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
if (prev && prev.title === data.title && JSON.stringify([prev.headers, prev.rows]) === JSON.stringify([data.headers, data.rows])) {
  console.log(`변경 없음 (${data.rows.length}건)`);
  process.exit(0);
}

data.fetchedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
await writeFile(OUT, JSON.stringify(data, null, 1) + '\n');
console.log(`data.json 갱신: ${data.rows.length}건 (${data.fetchedAt})`);

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
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
