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
      'Access-Control-Allow-Headers': 'content-type,x-team-code,x-user,authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // 누구인지 먼저 본다. 출입증이 있으면 그 사람, 없으면 익명.
      const user = await resolveSession(request, env);

      // 문 ① 팀 코드 — 출입증이 있으면 건너뛴다
      if (!user && env.TEAM_CODE && request.headers.get('x-team-code') !== env.TEAM_CODE) {
        return json({ error: '팀 코드가 올바르지 않습니다' }, 403, cors);
      }

      // 로그인 관련 창구
      if (url.pathname === '/auth/google' && request.method === 'POST') return authGoogle(request, env, cors);
      if (url.pathname === '/auth/logout' && request.method === 'POST') return authLogout(request, env, cors, user);
      if (url.pathname === '/auth/me') {
        return user ? json(user, 200, cors) : json({ error: '로그인이 필요합니다' }, 401, cors);
      }
      if (url.pathname === '/health') {
        return json({
          ok: true, db: !!env.DB, ai: !!env.ANTHROPIC_API_KEY, stt: !!env.AI,
          login: !!env.GOOGLE_CLIENT_ID, requireLogin: needLogin(env), me: user ? user.email : null,
        }, 200, cors);
      }

      // 문 ② 로그인 — REQUIRE_LOGIN 을 켜면 자료를 다루는 요청은 반드시 로그인
      if (needLogin(env) && !user) {
        return json({ error: '구글 계정으로 로그인해 주세요' }, 401, cors);
      }

      if (url.pathname === '/transcribe' && request.method === 'POST') return transcribe(request, env, cors);
      if (url.pathname === '/analyze' && request.method === 'POST') return analyze(request, env, cors);
      if (url.pathname === '/sync' && request.method === 'GET') return pull(request, env, cors);
      if (url.pathname === '/sync' && request.method === 'POST') return push(request, env, cors, user);
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
  const ct = request.headers.get('content-type') || '';
  let b64;

  if (ct.includes('text/plain')) {
    // 휴대폰에서 이미 base64 로 바꿔 보낸 경우 (메모리 절약)
    b64 = (await request.text()).trim();
    if (!b64) return json({ error: '음성 파일이 비어 있습니다' }, 400, cors);
    if (b64.length > STT_LIMIT * 1.4) {
      return json({ error: '파일이 너무 큽니다. 24MB 이하로 나눠 올리거나 클로바노트를 쓰세요' }, 413, cors);
    }
  } else {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.length) return json({ error: '음성 파일이 비어 있습니다' }, 400, cors);
    if (buf.length > STT_LIMIT) {
      return json({ error: `파일이 ${(buf.length / 1048576).toFixed(0)}MB 입니다. 24MB 이하로 나눠 올리거나 클로바노트를 쓰세요` }, 413, cors);
    }
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    b64 = btoa(bin);
  }

  try {
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: b64, task: 'transcribe', language: 'ko',
    });
    const text = (r && (r.text || r.transcription_info && r.transcript)) || '';
    return json({ text, words: r && r.word_count, model: 'whisper-large-v3-turbo' }, 200, cors);
  } catch (e) {
    // 구형 모델로 한 번 더 시도
    try {
      const bin2 = atob(b64);
      const bytes = new Uint8Array(bin2.length);
      for (let i = 0; i < bin2.length; i++) bytes[i] = bin2.charCodeAt(i);
      const r2 = await env.AI.run('@cf/openai/whisper', { audio: [...bytes] });
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
  // 기기 시계가 서로 달라도 놓치지 않도록, 서버가 받은 시각(server_at)을 기준으로 고른다
  const rows = await env.DB.prepare(
    `SELECT kind, id, data, updated_at, deleted FROM docs
     WHERE COALESCE(server_at, updated_at) > ?1 ORDER BY COALESCE(server_at, updated_at) LIMIT 2000`
  ).bind(since).all();

  const items = (rows.results || []).map(r => ({
    kind: r.kind, id: r.id, updatedAt: r.updated_at, deleted: !!r.deleted,
    data: r.deleted ? null : JSON.parse(r.data),
  }));
  return json({ now: new Date().toISOString(), count: items.length, items }, 200, cors);
}

/* ───────── 올리기 : 나중에 고친 쪽이 이긴다 */
async function push(request, env, cors, user) {
  if (!env.DB) return json({ error: '서버에 저장소(D1)가 연결되지 않았습니다' }, 500, cors);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: '보낼 자료가 너무 큽니다' }, 413, cors);
  const { items = [] } = JSON.parse(raw);
  let who = user ? (user.name ? `${user.name} <${user.email}>` : user.email) : (request.headers.get('x-user') || '').slice(0, 120);
  if (!user) { try { who = decodeURIComponent(who); } catch (e) { /* 그대로 둔다 */ } }
  const now = new Date().toISOString();

  let saved = 0, skipped = 0;
  const stmt = env.DB.prepare(
    `INSERT INTO docs (kind, id, data, updated_at, deleted, updated_by, server_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(kind, id) DO UPDATE SET
       data = excluded.data, updated_at = excluded.updated_at,
       deleted = excluded.deleted, updated_by = excluded.updated_by,
       server_at = excluded.server_at
     WHERE excluded.updated_at > docs.updated_at`
  );

  const batch = [];
  for (const it of items.slice(0, 1000)) {
    if (!it || !it.kind || !it.id) { skipped++; continue; }
    const at = it.updatedAt || now;
    batch.push(stmt.bind(it.kind, it.id, it.deleted ? '{}' : JSON.stringify(it.data || {}), at, it.deleted ? 1 : 0, who, now));
    saved++;
  }
  if (batch.length) await env.DB.batch(batch);
  return json({ now, saved, skipped }, 200, cors);
}

/* ═════════ 구글 계정 로그인 ═════════
   구글이 발급한 신분증(ID 토큰)을 구글 공개키로 검사하고,
   허용된 계정이면 30일짜리 출입증을 내준다. 비밀번호는 서버가 보지 않는다. */

const SESSION_DAYS = 30;
const needLogin = (env) => String(env.REQUIRE_LOGIN || '') === '1';

/** 요청에 붙은 출입증으로 사용자를 찾는다 */
async function resolveSession(request, env) {
  if (!env.DB) return null;
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
  if (!m) return null;
  const hash = await sha256hex(m[1]);
  const row = await env.DB.prepare(
    'SELECT email, name, expires_at FROM sessions WHERE token_hash = ?1'
  ).bind(hash).first();
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
    return null;
  }
  return { email: row.email, name: row.name || '', expiresAt: row.expires_at };
}

/** 구글 신분증 → 회사 출입증 */
async function authGoogle(request, env, cors) {
  if (!env.DB) return json({ error: '서버에 저장소(D1)가 연결되지 않았습니다' }, 500, cors);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: '서버에 구글 클라이언트 ID 가 설정되지 않았습니다' }, 500, cors);

  const body = await request.json().catch(() => ({}));
  if (!body.credential) return json({ error: '구글 신분증이 없습니다' }, 400, cors);

  let p;
  try { p = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID, env); }
  catch (e) { return json({ error: '구글 확인 실패 : ' + String(e && e.message || e).slice(0, 160) }, 401, cors); }

  const email = String(p.email || '').toLowerCase();
  if (!email || p.email_verified === false) {
    return json({ error: '구글에서 확인되지 않은 메일 주소입니다' }, 403, cors);
  }
  if (!allowedAccount(email, p.hd, env)) {
    return json({ error: `허용되지 않은 계정입니다 (${email}). 관리자에게 등록을 요청하세요` }, 403, cors);
  }

  const token = randomToken();
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now.toISOString()),
    env.DB.prepare(
      'INSERT OR REPLACE INTO sessions (token_hash, email, name, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(await sha256hex(token), email, p.name || '', now.toISOString(), exp.toISOString()),
  ]);
  return json({ token, email, name: p.name || '', picture: p.picture || '', expiresAt: exp.toISOString() }, 200, cors);
}

async function authLogout(request, env, cors, user) {
  if (env.DB && user) {
    const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') || '').trim());
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256hex(m[1])).run();
  }
  return json({ ok: true }, 200, cors);
}

/** 허용 계정 : 도메인(ALLOWED_DOMAIN) 또는 개별 주소(ALLOWED_EMAILS). 둘 다 없으면 아무도 못 들어온다 */
function allowedAccount(email, hd, env) {
  const list = (s) => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const domains = list(env.ALLOWED_DOMAIN);
  const emails = list(env.ALLOWED_EMAILS);
  if (!domains.length && !emails.length) return false;
  if (emails.includes(email)) return true;
  const dom = (email.split('@')[1] || '').toLowerCase();
  return domains.includes(dom) || (!!hd && domains.includes(String(hd).toLowerCase()));
}

/* ─── 구글 신분증 검사 (RS256 서명 확인) */
let jwks = { at: 0, keys: null };
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';

async function googleKeys(env) {
  // GOOGLE_JWKS_URL 은 시험용 우회로다. 운영에서는 비워 둔다.
  const url = env.GOOGLE_JWKS_URL || GOOGLE_CERTS;
  if (jwks.keys && jwks.url === url && Date.now() - jwks.at < 3600000) return jwks.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error('구글 공개키를 받지 못했습니다');
  const j = await r.json();
  jwks = { at: Date.now(), url, keys: j.keys || [] };
  return jwks.keys;
}

function b64uBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

async function verifyGoogleIdToken(jwt, clientId, env) {
  const part = String(jwt).split('.');
  if (part.length !== 3) throw new Error('형식이 올바르지 않습니다');

  const head = b64uJson(part[0]);
  if (head.alg !== 'RS256') throw new Error('서명 방식이 다릅니다');

  const jwk = (await googleKeys(env)).find(k => k.kid === head.kid);
  if (!jwk) throw new Error('서명 키를 찾지 못했습니다');

  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64uBytes(part[2]),
    new TextEncoder().encode(part[0] + '.' + part[1])
  );
  if (!ok) throw new Error('서명이 맞지 않습니다');

  const p = b64uJson(part[1]);
  if (p.iss !== 'accounts.google.com' && p.iss !== 'https://accounts.google.com') {
    throw new Error('발급처가 구글이 아닙니다');
  }
  if (p.aud !== clientId) throw new Error('다른 앱에서 발급된 신분증입니다');
  const now = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp < now - 60) throw new Error('신분증이 만료되었습니다');
  return p;
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors } });
