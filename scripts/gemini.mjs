/**
 * Gemini API 호출 공통 (ai-brief.mjs · classify.mjs)
 * - 키: GEMINI_API_KEY, 모델: GEMINI_MODEL(선택). 앞에서부터 시도하고 붐비면 가벼운 모델(lite)로 넘어감
 * - 모델이 없으면(404) 다음 모델, 일시적으로 바쁘면(429·5xx) 기다렸다 재시도 후 다음 모델
 * - 키 문제(400·401·403)는 e.fatal, 서버 혼잡으로 끝나면 e.busy
 */
export const KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite'].filter(Boolean))];

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

export async function generate({ system, prompt, schema, temperature = 0.3 }) {
  let last;
  for (const m of await usableModels()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
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
