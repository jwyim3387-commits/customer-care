/**
 * 마인드원 컨설턴트 공용 서버 (Cloudflare Workers + D1)
 *
 * 두 가지 일을 한다.
 *   POST /transcribe : 음성 파일을 글로 바꿔 준다 (Cloudflare Workers AI, 별도 키 불필요)
 *   POST /analyze  : 회사 Claude 키로 녹취를 분석해 돌려준다 (휴대폰에 키를 넣지 않아도 된다)
 *   GET  /sync     : 마지막 동기화 이후 바뀐 자료를 내려준다
 *   POST /sync     : 내 자료를 올린다 (같은 항목은 나중에 고친 쪽이 이긴다)
 *
 * 배포
 *   npm i -g wrangler && wrangler login
 *   wrangler d1 create mindone-cc                 # 나온 database_id 를 wrangler.toml 에 적는다
 *   wrangler d1 execute mindone-cc --remote --file server/schema.sql
 *   wrangler deploy
 *   wrangler secret put ANTHROPIC_API_KEY         # 회사 Claude 키
 *   wrangler secret put TEAM_CODE                 # 사내 공용 암구호
 *
 * 앱 설정에 주소(https://mindone-cc.<계정>.workers.dev)와 팀 코드를 넣으면 끝이다.
 */

const MAX_TOKENS = 4000;
const MAX_BODY = 2 * 1024 * 1024; // 2MB

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'content-type,x-team-code,x-user',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // 팀 코드 확인 (모든 요청 공통)
    if (env.TEAM_CODE && request.headers.get('x-team-code') !== env.TEAM_CODE) {
      return json({ error: '팀 코드가 올바르지 않습니다' }, 403, cors);
    }

    try {
      if (url.pathname === '/transcribe' && request.method === 'POST') return transcribe(request, env, cors);
      if (url.pathname === '/analyze' && request.method === 'POST') return analyze(request, env, cors);
      if (url.pathname === '/sync' && request.method === 'GET') return pull(request, env, cors);
      if (url.pathname === '/sync' && request.method === 'POST') return push(request, env, cors);
      if (url.pathname === '/health') return json({ ok: true, db: !!env.DB, ai: !!env.ANTHROPIC_API_KEY, stt: !!env.AI }, 200, cors);
      return json({ error: '없는 주소입니다' }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  },
};

/* ───────── 음성 → 글 (Cloudflare Workers AI, 추가 키·비용 없음)
   요청 본문에 음성 파일 바이트를 그대로 담아 보낸다. */
const STT_LIMIT = 24 * 1024 * 1024;

async function transcribe(request, env, cors) {
  if (!env.AI) return json({ error: '서버에 음성 인식(AI)이 연결되지 않았습니다' }, 500, cors);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return json({ error: '음성 파일이 비어 있습니다' }, 400, cors);
  if (buf.length > STT_LIMIT) {
    return json({ error: `파일이 ${(buf.length / 1048576).toFixed(0)}MB 입니다. 24MB 이하로 나눠 올리거나 클로바노트를 쓰세요` }, 413, cors);
  }

  // base64 로 바꿔 whisper 에 넘긴다
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const b64 = btoa(bin);

  try {
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: b64, task: 'transcribe', language: 'ko',
    });
    const text = (r && (r.text || r.transcription_info && r.transcript)) || '';
    return json({ text, words: r && r.word_count, model: 'whisper-large-v3-turbo' }, 200, cors);
  } catch (e) {
    // 구형 모델로 한 번 더 시도
    try {
      const r2 = await env.AI.run('@cf/openai/whisper', { audio: [...buf] });
      return json({ text: (r2 && r2.text) || '', model: 'whisper', turboError: String(e && e.message || e).slice(0, 300) }, 200, cors);
    } catch (e2) {
      return json({ error: '전사 실패 : ' + String(e && e.message || e).slice(0, 200) }, 502, cors);
    }
  }
}

/* ───────── 녹취 분석 (회사 키 사용) */
async function analyze(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: '서버에 Claude 키가 설정되지 않았습니다' }, 500, cors);
  const raw = await request.text();
  if (raw.length > 200 * 1024) return json({ error: '녹취가 너무 깁니다. 나눠서 분석해 주세요' }, 413, cors);
  const body = JSON.parse(raw);

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: body.model || 'claude-sonnet-5',
      max_tokens: Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS),
      system: body.system,
      messages: body.messages,
    }),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', ...cors },
  });
}

/* ───────── 내려받기 : since 이후 바뀐 것만 */
async function pull(request, env, cors) {
  if (!env.DB) return json({ error: '서버에 저장소(D1)가 연결되지 않았습니다' }, 500, cors);
  const since = new URL(request.url).searchParams.get('since') || '';
  const rows = await env.DB.prepare(
    'SELECT kind, id, data, updated_at, deleted FROM docs WHERE updated_at > ?1 ORDER BY updated_at LIMIT 2000'
  ).bind(since).all();

  const items = (rows.results || []).map(r => ({
    kind: r.kind, id: r.id, updatedAt: r.updated_at, deleted: !!r.deleted,
    data: r.deleted ? null : JSON.parse(r.data),
  }));
  return json({ now: new Date().toISOString(), count: items.length, items }, 200, cors);
}

/* ───────── 올리기 : 나중에 고친 쪽이 이긴다 */
async function push(request, env, cors) {
  if (!env.DB) return json({ error: '서버에 저장소(D1)가 연결되지 않았습니다' }, 500, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: '보낼 자료가 너무 큽니다' }, 413, cors);
  const { items = [] } = JSON.parse(raw);
  let user = (request.headers.get('x-user') || '').slice(0, 120);
  try { user = decodeURIComponent(user); } catch (e) { /* 그대로 둔다 */ }
  const now = new Date().toISOString();

  let saved = 0, skipped = 0;
  const stmt = env.DB.prepare(
    `INSERT INTO docs (kind, id, data, updated_at, deleted, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(kind, id) DO UPDATE SET
       data = excluded.data, updated_at = excluded.updated_at,
       deleted = excluded.deleted, updated_by = excluded.updated_by
     WHERE excluded.updated_at > docs.updated_at`
  );

  const batch = [];
  for (const it of items.slice(0, 1000)) {
    if (!it || !it.kind || !it.id) { skipped++; continue; }
    const at = it.updatedAt || now;
    batch.push(stmt.bind(it.kind, it.id, it.deleted ? '{}' : JSON.stringify(it.data || {}), at, it.deleted ? 1 : 0, user));
    saved++;
  }
  if (batch.length) await env.DB.batch(batch);
  return json({ now, saved, skipped }, 200, cors);
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors } });
