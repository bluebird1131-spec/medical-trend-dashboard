/**
 * 그날 새로 올라온 기사를 Gemini API 로 정리해 brief.json 에 저장함 (fetch-sheet.mjs 다음에 실행).
 * - API 키: 저장소 Settings → Secrets 의 GEMINI_API_KEY (없으면 건너뜀)
 * - 모델: Variables 의 GEMINI_MODEL (선택, 기본 gemini-2.5-flash)
 * - '오늘 기사' = 앞선 날짜의 브리핑에 들어가지 않았고, 수집일자·보도일자가 최근 3일 안인 기사
 * - 같은 기사 묶음으로 이미 만들었으면 다시 부르지 않음 → 하루 몇 번만 호출되어 무료 한도 안에서 운영
 * - 실패해도 페이지 갱신은 계속되도록 경고만 남기고 끝냄
 */
import { readFile, writeFile } from 'node:fs/promises';

const DATA = new URL('../data.json', import.meta.url);
const OUT = new URL('../brief.json', import.meta.url);
const KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean))];
const KEEP_DAYS = 30;   // brief.json 에 남길 브리핑 수
const MAX_ARTICLES = 60;
const RECENT = 3;       // 이 일수 안에 수집·보도된 기사만 '오늘 기사'로 봄

if (!KEY) {
  console.log('GEMINI_API_KEY 가 없어 AI 브리핑을 건너뜀');
  process.exit(0);
}

const data = JSON.parse(await readFile(DATA, 'utf8'));
const brief = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({ days: [] }));
const headers = data.headers || [];
const col = re => headers.findIndex(h => re.test(h));
const C = {
  collected: col(/수집/), date: col(/보도|게재|발행/), title: col(/제목/), status: col(/선별|상태/),
  category: col(/분류/), summary: col(/요약|내용/), org: col(/병원|기관/), region: col(/지역/),
  source: col(/출처|매체/), link: col(/url|링크|주소/i),
};
const cell = (r, k) => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');

const kst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const today = kst(new Date());
const cutoff = kst(new Date(Date.now() - (RECENT - 1) * 86400e3));
const ymd = s => { const m = String(s).match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };

const covered = new Set(brief.days.filter(d => d.date < today).flatMap(d => d.links || []));
const fresh = data.rows
  .filter(r => cell(r, 'link') && !covered.has(cell(r, 'link')))
  .filter(r => [ymd(cell(r, 'collected')), ymd(cell(r, 'date'))].some(d => d && d >= cutoff))
  .sort((a, b) => (/^\[?\s*검토/.test(cell(a, 'status')) - /^\[?\s*검토/.test(cell(b, 'status'))) ||
    ymd(cell(b, 'date')).localeCompare(ymd(cell(a, 'date'))))
  .slice(0, MAX_ARTICLES);

if (!fresh.length) {
  console.log(`오늘(${today}) 새로 올라온 기사가 없어 AI 브리핑을 건너뜀`);
  process.exit(0);
}

const sig = hash(fresh.map(r => [cell(r, 'link'), cell(r, 'status'), cell(r, 'summary')].join('|')).sort().join('\n'));
const prev = brief.days.find(d => d.date === today);
if (prev && prev.sig === sig) {
  console.log(`오늘 브리핑이 이미 최신 (${fresh.length}건 기준)`);
  process.exit(0);
}

const list = fresh.map((r, i) => [
  `[${i + 1}] ${cell(r, 'title')}`,
  `선별: ${cell(r, 'status')} | 분류: ${cell(r, 'category')} | 출처: ${cell(r, 'source')} | 보도: ${cell(r, 'date')}`,
  `기관: ${cell(r, 'org') || '-'} | 지역: ${cell(r, 'region') || '-'}`,
  `요약: ${cell(r, 'summary').replace(/\s+/g, ' ').slice(0, 400)}`,
].join('\n')).join('\n\n');

const system = `너는 울산대학교병원(울산 지역 상급종합병원) 기획 부서의 의료계 동향 분석 담당자다.
타지역 병원의 신규 의료서비스·의료기술 도입과 보건의료 정책 동향을 매일 아침 경영진과 실무진에게 보고한다.
규칙:
- 아래 기사 목록에 적힌 사실만 쓴다. 목록에 없는 수치·병원명·일정을 지어내지 않는다.
- 보고서 개조식 문체로 쓴다. 문장은 "~ 도입", "~ 추진", "~ 예정"처럼 명사형으로 끝낸다.
- 비슷한 기사는 하나의 동향으로 묶고, 각 동향에 근거 기사 번호를 refs 로 단다.
- '필요' 기사(실제 병원의 신기술 도입·센터 개소)를 먼저, '검토필요' 기사(정책·제도·가이드라인)를 그다음에 다룬다.`;

const prompt = `${today} 새로 선별된 기사 ${fresh.length}건이다. 오늘의 동향 브리핑을 작성하라.
- headline: 오늘 동향 전체를 한 문장(60자 안팎)으로
- points: 핵심 동향 3~5개. title 은 20자 안팎, body 는 1~2문장, refs 는 근거 기사 번호
- implications: 울산대학교병원이 벤치마킹하거나 검토할 만한 점 1~3개 (기사 내용에서 근거가 분명한 것만)

${list}`;

const schema = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    points: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, body: { type: 'STRING' }, refs: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        required: ['title', 'body', 'refs'],
      },
    },
    implications: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'points', 'implications'],
};

let out, model;
try {
  ({ out, model } = await generate());
} catch (e) {
  console.log(`::warning::AI 브리핑을 만들지 못했습니다 (${e.message}). 기사 페이지는 그대로 갱신됩니다.`);
  process.exit(0);
}

const linkOf = n => (Number.isInteger(n) && fresh[n - 1] ? cell(fresh[n - 1], 'link') : '');
const day = {
  date: today,
  headline: String(out.headline || '').trim(),
  points: (out.points || []).map(p => ({
    title: String(p.title || '').trim(),
    body: String(p.body || '').trim(),
    links: [...new Set((p.refs || []).map(linkOf).filter(Boolean))],
  })).filter(p => p.title || p.body),
  implications: (out.implications || []).map(s => String(s).trim()).filter(Boolean),
  count: fresh.length,
  links: fresh.map(r => cell(r, 'link')),
  model,
  generatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16),
  sig,
};
if (!day.headline && !day.points.length) {
  console.log('::warning::AI 응답이 비어 있어 브리핑을 저장하지 않았습니다.');
  process.exit(0);
}

brief.days = [day, ...brief.days.filter(d => d.date !== today)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
await writeFile(OUT, JSON.stringify(brief, null, 1) + '\n');
console.log(`AI 브리핑 저장: ${today}, 기사 ${fresh.length}건, 동향 ${day.points.length}개 (${model})`);

// 모델이 없거나(404) 일시적으로 바쁘면(429·5xx) 다음 모델·재시도
async function generate() {
  let last;
  for (const m of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: schema },
        }),
        signal: AbortSignal.timeout(120000),
      }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const j = await res.json();
        const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        try { return { out: JSON.parse(text), model: m }; } catch { last = `${m}: JSON 해석 실패`; break; }
      }
      const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
      last = `${m}: HTTP ${res.status} ${body}`;
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error(last);  // 키 문제는 재시도해도 같음
      if (res.status === 404) break;
      await new Promise(r => setTimeout(r, 15000));
    }
  }
  throw new Error(last || '응답 없음');
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}
