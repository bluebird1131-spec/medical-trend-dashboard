/**
 * 새로 수집된 기사(선별상태가 빈 행)를 Gemini API 로 분석해 시트 D~H 열에 기록함 (fetch-sheet.mjs 앞에서 실행).
 * Gemini Spark 가 시트에 직접 쓰지 못하게 막혀서(보안 정책 PERMISSION_DENIED) 대신 맡는 단계.
 * - 원문에서 본문 앞부분을 읽어 판단 (복지부는 게시판 본문, 언론사는 og:description). 못 읽으면 제목으로 판단
 * - 판정 기준·프롬프트는 classify-lib.mjs. CLASSIFY_RULES(v1·v2)로 고름
 *   v2 는 시트에서 담당자의 최근 판정을 예시로 붙이고, 최근 3일 고른 기사 제목으로 중복 보도를 거름
 * - 기록은 Apps Script 웹앱의 setFields: 그사이 관리자·Spark 가 상태를 넣은 행은 덮어쓰지 않음
 * - 한 번에 MAX 건까지, BATCH 건씩 묶어 호출. 실패한 묶음은 빈 행으로 남아 다음 실행(30분 뒤)에 다시 시도
 * - 필요한 값: SHEET_URL, GEMINI_API_KEY, GAS_URL, GAS_TOKEN (하나라도 없으면 건너뜀)
 */
import { KEY, generate } from './gemini.mjs';
import { STATUSES, CATEGORIES, SCHEMA, VERSIONS, buildSystem, buildPrompt, readSheet, userExamples, recentPicks, kstDate, fillBodies } from './classify-lib.mjs';

const SHEET = (process.env.SHEET_URL || '').trim();
const GAS_URL = (process.env.GAS_URL || '').trim();
const GAS_TOKEN = (process.env.GAS_TOKEN || '').trim();
const MAX = Number(process.env.CLASSIFY_MAX) || 200;
const BATCH = 20;
const RULES = VERSIONS.includes((process.env.CLASSIFY_RULES || '').trim()) ? process.env.CLASSIFY_RULES.trim() : 'v2';

if (!SHEET || !KEY || !GAS_URL || !GAS_TOKEN) {
  console.log('SHEET_URL·GEMINI_API_KEY·GAS_URL·GAS_TOKEN 중 빠진 값이 있어 기사 분석을 건너뜀');
  process.exit(0);
}

// ---------- 시트에서 빈 행 찾기 ----------
const { items, error } = await readSheet(SHEET);
if (error) {
  console.log(`::warning::${error} → 기사 분석을 건너뜀`);
  process.exit(0);
}
const todo = items.filter(x => !x.status && /^https?:\/\//.test(x.link) && x.title).slice(0, MAX);
if (!todo.length) { console.log('분석할 새 기사가 없음'); process.exit(0); }
console.log(`분석할 새 기사 ${todo.length}건`);

// ---------- 판정 기준 ----------
const examples = RULES === 'v2' ? userExamples(items) : null;
const system = buildSystem(RULES, examples);
const recent = RULES === 'v2' ? recentPicks(items, { fromDate: kstDate(-3) }) : null;
console.log(`판정 기준 ${RULES}` + (RULES === 'v2'
  ? ` (담당자 예시: 필요 ${examples.keep.length}건·불필요로 바꾼 것 ${examples.drop.length}건, 최근 고른 기사 ${recent.length}건)` : ''));

// ---------- 원문 앞부분 ----------
console.log(`본문을 읽은 기사 ${await fillBodies(todo)}/${todo.length}건 (나머지는 제목으로 판단)`);

// ---------- 분석 → 시트 기록 ----------
let saved = 0, skipped = 0, failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const part = todo.slice(i, i + BATCH);
  try {
    const { out, model } = await generate({ system, schema: SCHEMA, prompt: buildPrompt(part, recent), temperature: 0.2 });
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
      if (recent && o.status !== '불필요') recent.unshift(t);  // 다음 묶음의 중복 판단에 이번 결과도 반영
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
