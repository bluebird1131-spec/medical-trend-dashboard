/**
 * 선별 기사를 Gemini API 로 정리해 brief.json 에 저장함 (fetch-sheet.mjs 다음에 실행).
 * - 오늘(daily): 앞선 날짜의 브리핑에 들어가지 않은, 최근 3일 안에 보도된 새 기사 → 30일치 보관
 *   (수집 봇의 과거분 일괄 수집으로 오늘 분석된 옛 기사는 빼고, 주간·월간에서 다룸)
 * - 주간(weekly): 최근 7일 보도 기사 / 월간(monthly): 최근 30일 보도 기사 → 최신본만 보관 (이력은 git 커밋에 남음)
 * - API 키: 저장소 Settings → Secrets 의 GEMINI_API_KEY (없으면 건너뜀)
 * - 모델: Variables 의 GEMINI_MODEL (선택, 기본 gemini-2.5-flash)
 * - 기사 묶음이 그대로면 다시 부르지 않음. 주간·월간은 바뀌어도 3시간에 한 번만 → 하루 호출 수가 적어 무료 한도 안에서 운영
 * - 실패해도 페이지 갱신은 계속되도록 경고만 남기고 끝냄
 */
import { readFile, writeFile } from 'node:fs/promises';

const DATA = new URL('../data.json', import.meta.url);
const OUT = new URL('../brief.json', import.meta.url);
const KEY = (process.env.GEMINI_API_KEY || '').trim();
// 앞에서부터 시도. 붐비면 가벼운 모델(lite)로 넘어감
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite'].filter(Boolean))];
const KEEP_DAYS = 30;
const RECENT = 3;       // 이 일수 안에 보도된 기사만 '오늘 새 기사'로 봄
const REGEN_HOURS = 3;  // 주간·월간 다시 만드는 최소 간격

if (!KEY) {
  console.log('GEMINI_API_KEY 가 없어 AI 브리핑을 건너뜀');
  process.exit(0);
}

const data = JSON.parse(await readFile(DATA, 'utf8'));
const brief = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => ({}));
brief.days ||= [];
const headers = data.headers || [];
const col = re => headers.findIndex(h => re.test(h));
const C = {
  collected: col(/수집/), date: col(/보도|게재|발행/), title: col(/제목/), status: col(/선별|상태/),
  category: col(/분류/), summary: col(/요약|내용/), org: col(/병원|기관/), region: col(/지역/),
  source: col(/출처|매체/), link: col(/url|링크|주소/i),
};
const cell = (r, k) => (C[k] >= 0 ? String(r[C[k]] ?? '').trim() : '');
const ymd = s => { const m = String(s).match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
const kst = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const now = Date.now();
const today = kst(now);
const daysBack = n => kst(now - (n - 1) * 86400e3);   // n일 기간의 첫날
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
const rows = data.rows.filter(r => cell(r, 'link'));
const pubDate = r => ymd(cell(r, 'date')) || ymd(cell(r, 'collected'));
// '필요'(병원 신기술 도입) 먼저, 같은 상태면 최신 보도 먼저
const order = (a, b) => (/^\[?\s*검토/.test(cell(a, 'status')) - /^\[?\s*검토/.test(cell(b, 'status'))) || pubDate(b).localeCompare(pubDate(a));

const SYSTEM = `너는 울산대학교병원(울산 지역 상급종합병원) 기획 부서의 의료계 동향 분석 담당자다.
타지역 병원의 신규 의료서비스·의료기술 도입과 보건의료 정책 동향을 경영진과 실무진에게 보고한다.
규칙:
- 아래 기사 목록에 적힌 사실만 쓴다. 목록에 없는 수치·병원명·일정을 지어내지 않는다.
- 보고서 개조식 문체로 쓴다. 문장은 "~ 도입", "~ 추진", "~ 예정", "~ 검토"처럼 명사형으로 끝낸다. "~해야 함", "~할 필요가 있음"은 쓰지 않는다.
- 비슷한 기사는 하나의 동향으로 묶고, 각 동향에 근거 기사 번호를 refs 로 단다.
- 각 동향의 section 은 '정책'(정부·공공기관의 정책·제도·수가·사업 방향) 또는 '병원'(병원 현장의 신기술 도입·센터 개소·연구 성과) 중 하나로 단다.
- 기사 앞의 '[정부 발표]' 표시는 보건복지부 등 정부가 직접 낸 자료라는 뜻이다.`;
// 지시문을 바꾸면 올려서 같은 기사라도 브리핑을 다시 만들게 함
const PROMPT_V = 3;
const GOV = /보건복지부|복지부|질병관리청|식품의약품안전처|식약처|건강보험심사평가원|심평원|국민건강보험공단|건보공단/;

const KINDS = {
  daily: {
    label: '오늘',
    pick: () => {
      const covered = new Set(brief.days.filter(d => d.date < today).flatMap(d => d.links || []));
      const cutoff = daysBack(RECENT);
      return rows.filter(r => !covered.has(cell(r, 'link')) && pubDate(r) >= cutoff && pubDate(r) <= today);
    },
    max: 60, sumLen: 400, from: today,
    ask: `오늘(${today}) 새로 선별된 기사다. 오늘의 동향 브리핑을 작성하라.
- headline: 오늘 동향 전체를 한 문장(60자 안팎)으로
- points: 핵심 동향 3~5개. 병원 현장의 신기술 도입 소식을 먼저, 정책 소식을 그다음에. title 은 20자 안팎, body 는 1~2문장
- implications: 울산대학교병원이 벤치마킹하거나 검토할 만한 점 1~3개 (기사 근거가 분명한 것만)`,
  },
  weekly: {
    label: '주간',
    pick: () => rows.filter(r => pubDate(r) >= daysBack(7) && pubDate(r) <= today),
    max: 150, sumLen: 220, from: daysBack(7),
    ask: `최근 7일(${daysBack(7)} ~ ${today}) 선별 기사다. 주간 브리핑을 작성하라. 이번 주 **정부 정책 방향이 중심**이다.
- headline: 이번 주 정부 보건의료 정책의 방향을 한 문장(70자 안팎)으로
- points: 5~6개. 먼저 section '정책' 3~4개 — 정부가 이번 주 무엇을 발표·추진했고 어디로 가는지
  (수가·급여, 의료전달체계, 필수·응급의료, 지역의료, 의료인력, 의료 AI·디지털 제도, 국고 지원사업·공모 등).
  [정부 발표] 자료와 정책·제도 기사를 근거로 삼는다. 그다음 section '병원' 1~2개 — 정책과 맞물린 병원 현장 움직임.
  title 은 20자 안팎, body 는 2문장 이내
- implications: 정책 방향에 비추어 울산대학교병원이 대응·준비할 점 2~3개 (신청할 만한 사업, 바뀌는 수가·제도에 대한 준비 등, 기사 근거가 분명한 것만)`,
  },
  monthly: {
    label: '월간',
    pick: () => rows.filter(r => pubDate(r) >= daysBack(30) && pubDate(r) <= today),
    max: 300, sumLen: 120, from: daysBack(30),
    ask: `최근 30일(${daysBack(30)} ~ ${today}) 선별 기사다. 월간 브리핑을 작성하라. 한 달간의 **국가 보건의료 정책 방향이 중심**이다.
- headline: 이번 달 정부 정책이 향하는 방향을 한 문장(70자 안팎)으로
- points: 6~7개. 먼저 section '정책' 4~5개 — 한 달간 여러 발표에 걸쳐 반복된 정책 기조와 그 방향
  (수가·급여 개편, 의료전달체계·상급종합병원 구조전환, 필수·응급·외상의료, 지역완결 의료, 의료인력, 의료 AI·디지털 제도, 국고 지원사업 등).
  개별 발표 나열이 아니라 '어떤 방향으로 가고 있는지'를 쓰고, 가능하면 관련 발표 수를 담는다.
  그다음 section '병원' 2개 — 한 달간 여러 병원에 걸쳐 나타난 신기술 도입·센터 개소 패턴.
  title 은 20자 안팎, body 는 2문장 이내
- implications: 정책 방향에 비추어 울산대학교병원이 중기적으로 대응·준비할 점 2~4개 (기사 근거가 분명한 것만)`,
  },
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    points: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          section: { type: 'STRING', enum: ['정책', '병원'] },
          title: { type: 'STRING' }, body: { type: 'STRING' }, refs: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['section', 'title', 'body', 'refs'],
      },
    },
    implications: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'points', 'implications'],
};

let changed = false;
for (const [kind, K] of Object.entries(KINDS)) {
  try {
    if (await make(kind, K)) {
      changed = true;
      await new Promise(r => setTimeout(r, 30000));  // 무료 등급의 분당 요청 한도(429)에 걸리지 않게 간격을 둠
    }
  } catch (e) {
    console.log(`::warning::AI ${K.label} 브리핑을 만들지 못했습니다 (${e.message}). 기사 페이지는 그대로 갱신됩니다.`);
    if (e.fatal || e.busy) break;  // 키 문제·서버 혼잡은 다음 종류도 똑같이 실패 → 다음 실행에서 다시 시도
  }
}
if (changed) await writeFile(OUT, JSON.stringify(brief, null, 1) + '\n');

async function make(kind, K) {
  const list = K.pick().sort(order).slice(0, K.max);
  if (!list.length) { console.log(`${K.label}: 대상 기사가 없어 건너뜀`); return false; }

  const sig = PROMPT_V + ':' + hash(list.map(r => [cell(r, 'link'), cell(r, 'status'), cell(r, 'summary')].join('|')).sort().join('\n'));
  const prev = kind === 'daily' ? brief.days.find(d => d.date === today) : brief[kind];
  if (prev && prev.sig === sig) { console.log(`${K.label}: 이미 최신 (${list.length}건)`); return false; }
  // 지시문이 바뀐 경우(PROMPT_V)는 기다리지 않고 바로 다시 만듦
  if (kind !== 'daily' && prev && prev.date === today && prev.generatedAt && String(prev.sig).startsWith(PROMPT_V + ':') &&
      now - new Date(prev.generatedAt.replace(' ', 'T') + ':00+09:00').getTime() < REGEN_HOURS * 3600e3) {
    console.log(`${K.label}: ${REGEN_HOURS}시간 안에 만든 브리핑이 있어 다음 실행으로 미룸`);
    return false;
  }

  const text = list.map((r, i) => [
    `[${i + 1}] ${GOV.test(cell(r, 'source')) ? '[정부 발표] ' : ''}${cell(r, 'title')}`,
    `선별: ${cell(r, 'status')} | 분류: ${cell(r, 'category')} | 출처: ${cell(r, 'source')} | 보도: ${pubDate(r)}`,
    `기관: ${cell(r, 'org') || '-'} | 지역: ${cell(r, 'region') || '-'}`,
    `요약: ${cell(r, 'summary').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, K.sumLen)}`,
  ].join('\n')).join('\n\n');

  const { out, model } = await generate(`${K.ask}\n\n기사 ${list.length}건:\n\n${text}`);
  const linkOf = n => (Number.isInteger(n) && list[n - 1] ? cell(list[n - 1], 'link') : '');
  const item = {
    date: today,
    from: K.from,
    headline: String(out.headline || '').trim(),
    points: (out.points || []).map(p => ({
      section: p.section === '정책' ? '정책' : '병원',
      title: String(p.title || '').trim(),
      body: String(p.body || '').trim(),
      links: [...new Set((p.refs || []).map(linkOf).filter(Boolean))],
    })).filter(p => p.title || p.body),
    implications: (out.implications || []).map(s => String(s).trim()).filter(Boolean),
    count: list.length,
    model,
    generatedAt: stamp(),
    sig,
  };
  if (!item.headline && !item.points.length) throw new Error('응답이 비어 있음');

  if (kind === 'daily') {
    item.links = list.map(r => cell(r, 'link'));  // 다음 날 '새 기사'를 가리는 데 씀
    brief.days = [item, ...brief.days.filter(d => d.date !== today)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
  } else {
    brief[kind] = item;
  }
  console.log(`${K.label}: 브리핑 저장 — 기사 ${list.length}건, 동향 ${item.points.length}개 (${model})`);
  return true;
}

// 이 키로 쓸 수 있는 모델만 남김 (목록 조회가 실패하면 후보 그대로 시도)
async function usableModels() {
  if (usableModels.list) return usableModels.list;
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': KEY }, signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const names = new Set(((await res.json()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, '')));
    const ok = MODELS.filter(m => names.has(m));
    console.log(`사용 가능한 후보 모델: ${ok.join(', ') || '(없음)'}`);
    usableModels.list = ok.length ? ok : MODELS;
  } catch (e) {
    console.log(`모델 목록 조회 실패 (${e.message}), 후보 모델을 차례로 시도`);
    usableModels.list = MODELS;
  }
  return usableModels.list;
}

// 모델이 없으면(404) 다음 모델, 일시적으로 바쁘면(429·5xx) 기다렸다 재시도 후 다음 모델
async function generate(prompt) {
  let last;
  for (const m of await usableModels()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SCHEMA },
        }),
        signal: AbortSignal.timeout(180000),
      }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const j = await res.json();
        const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        try { return { out: JSON.parse(text), model: m }; } catch { last = `${m}: JSON 해석 실패`; break; }
      }
      const body = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
      last = `${m}: HTTP ${res.status} ${body}`;
      console.log(`  ${m} ${attempt + 1}차 시도 실패: HTTP ${res.status} ${body.match(/"status":\s*"(\w+)"/)?.[1] || ''}`);
      if (res.status === 400 || res.status === 401 || res.status === 403) throw Object.assign(new Error(last), { fatal: true });
      if (res.status === 404) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 20000));
    }
  }
  throw Object.assign(new Error(last || '응답 없음'), { busy: /HTTP (429|5\d\d)/.test(last || '') });
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}
