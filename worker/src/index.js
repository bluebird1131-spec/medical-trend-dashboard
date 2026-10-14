/**
 * 의료계 동향 API (Cloudflare Worker)
 * - 관리자: 구글 시트 기사 목록 읽기 · 선별상태 수정 · 사이트 재배포 (Apps Script 웹앱 경유)
 * - 게시판: 팀원 의견 읽기·쓰기 (D1 데이터베이스), 관리자는 숨김·답변 가능
 * - AI 브리핑 우선 기사: 관리자가 고르고(D1 brief_picks), ai-brief.mjs 가 읽음 (기사 주소뿐이라 읽기는 공개)
 * 병원망은 구글을 막지만 Cloudflare 는 열려 있어, 브라우저는 이 Worker 에만 접속함.
 *
 * Secrets (wrangler secret put):
 *   ADMIN_PASSWORD  관리자 암호
 *   GAS_URL         구글 시트 Apps Script 웹앱 주소 (…/exec)
 *   GAS_TOKEN       Apps Script 에 넣은 관리자 토큰과 같은 값
 *   GITHUB_TOKEN    대시보드·수집 봇 저장소 Actions 쓰기 권한만 있는 fine-grained 토큰
 *
 * 예약 실행 (wrangler.toml 의 crons, UTC) — GitHub 자체 예약은 몇 시간씩 밀리거나 빠져서 여기서 깨움
 *   매 30분          대시보드 update.yml (새 기사 분석 → 시트 → 홈페이지)
 *   06:10·13:10 KST  수집 봇 scrape.yml
 *   매시 정각        02 이슈 키워드 collect.yml (30분 예약의 정각 회차에 같이 실행)
 */
const REPO = 'bluebird1131-spec/medical-trend-dashboard';
const WORKFLOW = 'update.yml';
const BOT_REPO = 'bluebird1131-spec/medical-news-bot';
const BOT_WORKFLOW = 'scrape.yml';
const CRON_BOT = '10 21,4 * * *';
const KW_REPO = 'bluebird1131-spec/issue-keyword';   // 02 이슈 키워드 사이트 (매시 정각)
const KW_WORKFLOW = 'collect.yml';
const ALLOWED_ORIGINS = ['https://bluebird1131-spec.github.io', 'http://localhost:8811'];
const STATUSES = ['필요', '검토필요', '불필요'];
const KINDS = ['의견', '오류 신고', '기능 요청', '기사 제보'];

export default {
  async scheduled(event, env, ctx) {
    // auto=1: 예약이 드물게 두 번 와도 각 워크플로가 중복 실행을 건너뜀
    const jobs = event.cron === CRON_BOT ? [[BOT_REPO, BOT_WORKFLOW, { auto: '1' }]] : [[REPO, WORKFLOW, { auto: '1' }]];
    // 02 이슈 키워드 사이트: 30분 예약 중 정각 회차에 같이 깨움 (무료 플랜 예약 개수 한도 때문에 예약을 새로 만들지 않음)
    if (event.cron !== CRON_BOT && new Date(event.scheduledTime).getUTCMinutes() < 30) jobs.push([KW_REPO, KW_WORKFLOW, {}]);
    for (const [repo, wf, inputs] of jobs) {
      const res = await gh(env, `/repos/${repo}/actions/workflows/${wf}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs }) });
      if (res.status === 204) console.log(`예약 실행 요청: ${repo} ${wf}`);
      else console.log(`예약 실행 실패: ${repo} ${wf} HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  },

  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    const cors = {
      'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-key',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });

    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '');
      const isAdmin = await checkAdmin(req, env);

      /* ---------- 게시판 (누구나) ---------- */
      if (path === '/api/posts' && req.method === 'GET') {
        const showHidden = isAdmin && url.searchParams.get('all') === '1';
        const { results } = await env.DB.prepare(
          `SELECT id, created_at, name, kind, body, link, title, state, reply, replied_at, hidden
             FROM posts ${showHidden ? '' : 'WHERE hidden = 0'} ORDER BY id DESC LIMIT 300`).all();
        return json({ posts: results, kinds: KINDS });
      }
      if (path === '/api/posts' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (b.website) return json({ ok: true });  // 스팸 봇용 숨은 칸
        const name = clean(b.name, 20), body = clean(b.body, 2000), kind = KINDS.includes(b.kind) ? b.kind : KINDS[0];
        const link = /^https?:\/\//i.test(b.link || '') ? clean(b.link, 500) : '';
        const title = link ? clean(b.title, 200) : '';
        if (!name) return json({ error: '이름을 적어 주세요.' }, 400);
        if (body.length < 2) return json({ error: '내용을 적어 주세요.' }, 400);
        const ip = req.headers.get('cf-connecting-ip') || '';
        const ipHash = await sha(ip + '|medical-trend');
        const recent = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM posts WHERE ip_hash = ? AND created_at > datetime('now', '-1 minute')`).bind(ipHash).first();
        if (recent.n >= 3) return json({ error: '잠시 후 다시 올려 주세요. (1분에 3건까지)' }, 429);
        const r = await env.DB.prepare(
          `INSERT INTO posts (created_at, name, kind, body, link, title, ip_hash) VALUES (datetime('now'), ?, ?, ?, ?, ?, ?)`)
          .bind(name, kind, body, link, title, ipHash).run();
        return json({ ok: true, id: r.meta.last_row_id });
      }
      const m = path.match(/^\/api\/posts\/(\d+)$/);
      if (m && req.method === 'PATCH') {
        if (!isAdmin) return json({ error: '관리자 암호가 필요합니다.' }, 401);
        const b = await req.json().catch(() => ({}));
        const sets = [], args = [];
        if ('hidden' in b) { sets.push('hidden = ?'); args.push(b.hidden ? 1 : 0); }
        if ('state' in b && ['접수', '확인', '반영', '보류'].includes(b.state)) { sets.push('state = ?'); args.push(b.state); }
        if ('reply' in b) { sets.push("reply = ?, replied_at = datetime('now')"); args.push(clean(b.reply, 1000)); }
        if (!sets.length) return json({ error: '바꿀 내용이 없습니다.' }, 400);
        await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...args, +m[1]).run();
        return json({ ok: true });
      }

      /* ---------- AI 브리핑 우선 기사 (읽기는 누구나: GitHub Actions 의 ai-brief.mjs 가 읽음) ---------- */
      if (path === '/api/brief-picks' && req.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT link, title, picked_at FROM brief_picks WHERE picked_at > datetime('now', '-40 days') ORDER BY picked_at DESC`).all();
        return json({ picks: results });
      }

      /* ---------- 관리자 ---------- */
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin) return json({ error: '관리자 암호가 맞지 않습니다.' }, 401);

        if (path === '/api/admin/check') return json({ ok: true });

        // 시트에서 분석된(선별상태가 있는) 행 목록
        if (path === '/api/admin/rows' && req.method === 'GET') {
          const r = await gas(env, { action: 'list' });
          return json(r);
        }
        // 선별상태 수정: [{ row, link, status }]
        if (path === '/api/admin/status' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const updates = (b.updates || []).filter(u => Number.isInteger(u.row) && u.row >= 2 && STATUSES.includes(u.status) && u.link)
            .slice(0, 200);
          if (!updates.length) return json({ error: '수정할 항목이 없습니다.' }, 400);
          const r = await gas(env, { action: 'setStatus', updates });
          return json(r);
        }
        // AI 브리핑 우선 기사 고르기·빼기: { link, title, pick }
        if (path === '/api/admin/brief-picks' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const link = /^https?:\/\//i.test(b.link || '') ? clean(b.link, 500) : '';
          if (!link) return json({ error: '기사 주소가 없습니다.' }, 400);
          if (b.pick) {
            await env.DB.batch([
              env.DB.prepare(`INSERT INTO brief_picks (link, title, picked_at) VALUES (?, ?, datetime('now'))
                                ON CONFLICT(link) DO UPDATE SET title = excluded.title, picked_at = excluded.picked_at`).bind(link, clean(b.title, 200)),
              env.DB.prepare(`DELETE FROM brief_picks WHERE picked_at < datetime('now', '-60 days')`),
            ]);
          } else {
            await env.DB.prepare(`DELETE FROM brief_picks WHERE link = ?`).bind(link).run();
          }
          return json({ ok: true });
        }
        // 사이트 재배포 (GitHub Actions 실행)
        // brief 가 daily·weekly·monthly·all 이면 AI 브리핑도 새로 만듦
        if (path === '/api/admin/publish' && req.method === 'POST') {
          const b = await req.json().catch(() => ({}));
          const brief = ['daily', 'weekly', 'monthly', 'all'].includes(b.brief) ? b.brief : '';
          const res = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { brief } }) });
          if (res.status !== 204) return json({ error: `GitHub 실행 요청 실패 (HTTP ${res.status}) ${(await res.text()).slice(0, 200)}` }, 502);
          return json({ ok: true });
        }
        // 최근 배포 실행 상태
        if (path === '/api/admin/runs' && req.method === 'GET') {
          const res = await gh(env, `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=3`);
          if (!res.ok) return json({ error: `GitHub 조회 실패 (HTTP ${res.status})` }, 502);
          const j = await res.json();
          return json({ runs: (j.workflow_runs || []).map(r => ({ id: r.id, event: r.event, status: r.status, conclusion: r.conclusion, created_at: r.created_at, updated_at: r.updated_at, url: r.html_url })) });
        }
      }
      return json({ error: '없는 주소입니다.' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};

const clean = (s, n) => String(s ?? '').replace(/\r/g, '').trim().slice(0, n);

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 암호 비교는 해시끼리 (길이·시간 차로 새지 않게)
async function checkAdmin(req, env) {
  const key = req.headers.get('x-admin-key') || '';
  if (!key || !env.ADMIN_PASSWORD) return false;
  return (await sha(key)) === (await sha(env.ADMIN_PASSWORD));
}

async function gas(env, payload) {
  if (!env.GAS_URL || !env.GAS_TOKEN) throw new Error('Apps Script 주소·토큰이 설정되지 않았습니다.');
  const res = await fetch(env.GAS_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, token: env.GAS_TOKEN }),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Apps Script 응답을 읽지 못했습니다 (HTTP ${res.status}). 웹앱 배포를 확인해 주세요.`); }
  if (j.status === 'error') throw new Error(`Apps Script: ${j.message}`);
  return j;
}

function gh(env, path, init = {}) {
  const token = env.GITHUB_TOKEN || env.GITHB_TOKEN;  // 대시보드에서 GITHB_TOKEN 으로 등록됨
  if (!token) throw new Error('GitHub 토큰이 설정되지 않았습니다.');
  return fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'medical-trend-api', 'content-type': 'application/json',
    },
  });
}
