/**
 * 분류 기준 검증 (시트에 쓰지 않음): 담당자가 이미 정리한 최근 기사를 판정 기준별로 다시 판정해 담당자 판정과 비교함
 * - 실행: Actions '분류 기준 검증' (Run workflow). 필요한 값: SHEET_URL, GEMINI_API_KEY
 * - 대상: 담당자가 정리한 날짜(직접 고친 기사가 5건 이상) 중 최근 날짜(EVAL_BEFORE 를 주면 그 앞)부터, EVAL_N 건 이상이 되도록 날짜 단위로 채움
 * - 비교: 당시 실제 판정(요약 열의 [상태] 표시), v1(이전 기준), v2r(새 기준 문구만), v2(새 기준 + 담당자 예시 + 중복 거르기)
 *   v2 의 담당자 예시는 검증 날짜보다 앞선 날짜에서만 뽑음 (답을 미리 보여 주지 않게)
 * - '보임' = 필요·검토필요 (사이트에 올라가는 것). 맞춤률·잘못 올린 기사·놓친 기사를 기준별로 셈
 */
import { appendFileSync } from 'node:fs';
import { KEY, generate } from './gemini.mjs';
import { STATUSES, SCHEMA, VERSIONS, buildSystem, buildPrompt, readSheet, userExamples, recentPicks, kstDate, fillBodies } from './classify-lib.mjs';

const SHEET = (process.env.SHEET_URL || '').trim();
const N = Number(process.env.EVAL_N) || 120;
const BEFORE = (process.env.EVAL_BEFORE || '').trim() || '9999-99-99';  // 이 날짜보다 앞선 날짜만 (기준을 고친 날짜와 다른 날로 확인할 때)
const BATCH = 20;
const variants = (process.env.EVAL_VARIANTS || 'v1,v2r,v2').split(/[\s,]+/).filter(v => VERSIONS.includes(v));
if (!SHEET || !KEY) { console.log('SHEET_URL·GEMINI_API_KEY 가 없어 검증을 건너뜀'); process.exit(0); }

const { items, error } = await readSheet(SHEET);
if (error) { console.log(`::error::${error}`); process.exit(1); }

// 담당자가 정리한 날짜 (직접 고친 기사 5건 이상)
const fixes = {}, lastFix = {};
for (const x of items) {
  if (!x.ai || !STATUSES.includes(x.status) || x.ai === x.status) continue;
  fixes[x.collected] = (fixes[x.collected] || 0) + 1;
  lastFix[x.collected] = Math.max(lastFix[x.collected] || 0, x.row);
}
const days = Object.keys(fixes).filter(d => fixes[d] >= 5 && d < BEFORE).sort().reverse();
const evalDays = [];
let count = 0;
for (const d of days) {
  if (count >= N) break;
  evalDays.push(d);
  count += items.filter(x => x.collected === d && STATUSES.includes(x.status)).length;
}
// 그날 담당자가 마지막으로 고친 행까지만 (그 뒤에 들어온 기사는 아직 안 봤을 수 있음)
const evalSet = items.filter(x => evalDays.includes(x.collected) && x.row <= lastFix[x.collected] && STATUSES.includes(x.status) && x.title && /^https?:\/\//.test(x.link))
  .sort((a, b) => a.row - b.row);
const first = evalDays[evalDays.length - 1];
console.log(`검증 대상: ${evalDays.slice().reverse().join(', ')} 수집 기사 ${evalSet.length}건 (담당자가 고친 기사 ${evalSet.filter(x => x.ai && x.ai !== x.status).length}건)`);
console.log(`비교할 기준: ${variants.join(', ')}`);

const examples = userExamples(items, { beforeDate: first });
console.log(`v2 담당자 예시 (${first} 이전 날짜에서): 필요 ${examples.keep.length}건 · 불필요로 바꾼 것 ${examples.drop.length}건`);
console.log(`본문을 읽은 기사 ${await fillBodies(evalSet)}/${evalSet.length}건`);

// ---------- 기준별 판정 ----------
for (const v of variants) {
  const system = buildSystem(v, examples);
  for (let i = 0; i < evalSet.length; i += BATCH) {
    const part = evalSet.slice(i, i + BATCH);
    // 중복 판단용 최근 고른 기사: 이 묶음 첫 행보다 앞선 행 중 3일 안 (앞 행은 담당자 최종 판정 기준)
    const recent = v === 'v2' ? recentPicks(items, { fromDate: kstDate(-3, Date.parse(part[0].collected) - 9 * 3600e3), beforeRow: part[0].row }) : null;
    try {
      const { out, model } = await generate({ system, schema: SCHEMA, prompt: buildPrompt(part, recent), temperature: 0.2 });
      let got = 0;
      for (const o of Array.isArray(out) ? out : []) {
        const t = part[o.id - 1];
        if (t && STATUSES.includes(o.status)) { t[v] = o.status; t[v + 'Why'] = String(o.reason || '').slice(0, 12); got++; }
      }
      console.log(`  ${v} ${i + 1}~${i + part.length}: ${got}건 판정 (${model})`);
    } catch (e) {
      console.log(`::warning::${v} ${i + 1}~${i + part.length} 판정 실패 (${e.message})`);
      if (e.fatal) process.exit(1);
    }
    await new Promise(r => setTimeout(r, 15000));
  }
}

// ---------- 비교 ----------
const shown = s => s === '필요' || s === '검토필요';
function score(key) {
  const s = { done: 0, same: 0, shownSame: 0, need: 0, review: 0, hit: 0, extra: 0, miss: 0 };
  for (const x of evalSet) {
    const a = x[key];
    if (!a) continue;
    s.done++;
    if (a === x.status) s.same++;
    if (shown(a) === shown(x.status)) s.shownSame++;
    if (a === '필요') s.need++;
    if (a === '검토필요') s.review++;
    if (shown(a) && shown(x.status)) s.hit++;
    if (shown(a) && !shown(x.status)) s.extra++;
    if (!shown(a) && shown(x.status)) s.miss++;
  }
  return s;
}
const userShown = evalSet.filter(x => shown(x.status)).length;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const cols = [['ai', '당시 판정'], ...variants.map(v => [v, { v1: 'v1 이전 기준', v2r: 'v2r 새 문구만', v2: 'v2 새 기준 전체' }[v]])];
const md = [
  `## 분류 기준 검증 (${evalDays.slice().reverse().join(', ')} · ${evalSet.length}건)`,
  `담당자가 사이트에 남긴 기사(필요·검토필요): **${userShown}건**`, '',
  '| 기준 | 판정 건수 | 3단계 일치 | 보임/숨김 일치 | 필요 | 검토필요 | 잘못 올림 | 놓침 | 올린 것 중 맞음 | 담당자 기사 중 잡음 |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
for (const [k, name] of cols) {
  const s = score(k);
  md.push(`| ${name} | ${s.done} | ${pct(s.same, s.done)} | ${pct(s.shownSame, s.done)} | ${s.need} | ${s.review} | ${s.extra} | ${s.miss} | ${pct(s.hit, s.hit + s.extra)} | ${pct(s.hit, s.hit + s.miss)} |`);
}
for (const [k, name] of cols.slice(1)) {
  const miss = evalSet.filter(x => x[k] && !shown(x[k]) && shown(x.status));
  if (miss.length) md.push('', `**${name} — 놓친 기사 ${miss.length}건**`, ...miss.map(x => `- ${x.row}행 ${x.title} (${x[k]}-${x[k + 'Why']})`));
}
const text = md.join('\n');
console.log('\n' + text);
console.log('\n--- 행별 (행 | 담당자 | 당시 | ' + variants.join(' | ') + ' | 제목)');
for (const x of evalSet) console.log([x.row, x.status, x.ai || '-', ...variants.map(v => x[v] ? `${x[v]}-${x[v + 'Why']}` : '?'), x.title.replace(/﻿/g, '')].join(' | '));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
