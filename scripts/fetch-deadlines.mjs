/**
 * 국고사업 탭용: 보건복지부 공지(공모·지원사업 공고)의 게시판 '기간'(접수·의견제출 기간)을 원문에서 읽어 deadlines.json 에 저장
 * - 수집 봇·시트는 건드리지 않음. data.json 에 올라온 복지부 공지만 대상
 * - 신청 대상 등 세부 내용은 대부분 첨부 공고문(hwp·pdf)에 있어 읽지 않음
 * - 한 번 읽은 공고는 다시 읽지 않음(캐시). 실패해도 페이지 갱신은 계속됨
 */
import { readFile, writeFile } from 'node:fs/promises';

const DATA = new URL('../data.json', import.meta.url);
const OUT = new URL('../deadlines.json', import.meta.url);
const MAX_NEW = +process.env.MAX_NEW || 80;  // 한 번 실행에서 새로 읽는 공고 수
const KEEP_DAYS = 400;

const data = JSON.parse(await readFile(DATA, 'utf8'));
const cache = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));
const headers = data.headers || [];
const linkCol = headers.findIndex(h => /url|링크|주소/i.test(h) && !/사진|이미지/.test(h));
const titleCol = headers.findIndex(h => /제목/.test(h));
// 접수기간이 있는 글: 복지부 공지 게시판(bid=0003) 중 제목에 공모·모집·신청 등이 들어간 공고
const CALL = /공모|모집|신청|선정|지정|위탁|참여기관|보조사업자|수행기관|행정예고/;
const targets = (data.rows || []).map(r => ({ link: String(r[linkCol] || '').trim(), title: String(r[titleCol] || '') }))
  .filter(x => /mohw\.go\.kr/.test(x.link) && /bid=0003/.test(x.link) && CALL.test(x.title));

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&sim;/g, '~').replace(/&rsquo;|&lsquo;|&#39;|&apos;/g, "'")
  .replace(/&middot;/g, '·').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const plain = h => decode(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|li|div|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');

// "2026.8.3.(월) ~ 8.14.(금)", "'26.9.14 ~ '26.9.29", "2026-09-07 ~ 2026-09-30" → ['2026-08-03', '2026-08-14']
function parseDates(text, baseYear) {
  const out = [];
  let year = baseYear;
  const re = /(?:(\d{4})|['`’‘](\d{2}))?\s*[.\-년]?\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})(?!\d)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) year = +m[1]; else if (m[2]) year = 2000 + +m[2];
    else if (!out.length && !/\d{4}|['`’‘]\d{2}/.test(text)) continue;
    const mo = +m[3], d = +m[4];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || !year) continue;
    out.push(`${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

const todo = targets.filter(x => !(x.link in cache)).slice(0, MAX_NEW);
let ok = 0;
for (const x of todo) {
  try {
    const res = await fetch(x.link, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }, signal: AbortSignal.timeout(30000) });
    const html = await res.text();
    const view = html.slice(Math.max(0, html.indexOf('class="board_view"')));
    const posted = (view.match(/작성일<\/strong>[\s\S]*?(\d{4})-\d{2}-\d{2}/) || [])[1];
    // 게시판 정보 칸의 '기간'(또는 '접수기간'): 2026-09-07 ~ 2026-09-30
    const info = view.match(/<strong>(?:접수)?기간<\/strong>([\s\S]*?)<\/li>/);
    let period = info ? plain(info[1]).replace(/^[\s:]+/, '').replace(/\s+/g, ' ').trim() : '';
    if (!/\d/.test(period)) {  // 정보 칸이 비었으면 본문의 '접수기간·신청기간·공모기간'
      const text = plain(view.slice(view.indexOf('class="contents"')));
      const b = text.match(/(?:접수|신청|공모|제출)\s*기간\s*[:：]?\s*([^\n]{6,70})/);
      period = b && /\d/.test(b[1]) ? b[1].replace(/\s+/g, ' ').trim() : '';
    }
    const dates = parseDates(period, posted ? +posted : new Date().getFullYear());
    cache[x.link] = { period, start: dates[0] || '', end: dates.length > 1 ? dates[dates.length - 1] : '', at: new Date().toISOString().slice(0, 10) };
    ok++;
  } catch (e) {
    console.log(`읽기 실패: ${x.title.slice(0, 30)} (${e.message})`);
  }
  await new Promise(r => setTimeout(r, 400));
}
// 오래된 기록 정리
const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
const live = new Set(targets.map(x => x.link));
for (const [k, v] of Object.entries(cache)) if (v.at && v.at < cut && !live.has(k)) delete cache[k];
await writeFile(OUT, JSON.stringify(cache, null, 1) + '\n');
console.log(`국고사업 공고 ${targets.length}건 중 새로 읽음 ${ok}건, 기간이 확인된 공고 ${Object.values(cache).filter(v => v.end).length}건`);
