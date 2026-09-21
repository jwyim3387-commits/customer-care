// 구글 계정 로그인
//
// 흐름 : 구글이 "이 사람이 누구인지" 확인해 신분증(ID 토큰)을 준다
//        → 회사 서버가 그 신분증을 구글 공개키로 검사하고, 허용된 계정이면 출입증(세션)을 내준다
//        → 앱은 이후 모든 요청에 출입증을 붙인다.
// 출입증은 이 기기에만 저장되고 30일 뒤 만료된다. 구글 비밀번호는 앱이 보지 않는다.
import { GOOGLE_CLIENT_ID } from './config.js';

const KEY = 'mindone.cc.session';
const GSI = 'https://accounts.google.com/gsi/client';

let mem;
export function session() {
  if (mem === undefined) {
    try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { mem = null; }
  }
  if (mem && mem.expiresAt && new Date(mem.expiresAt) <= new Date()) { drop(); }
  return mem || null;
}
function keep(s) { mem = s; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
function drop() { mem = null; try { localStorage.removeItem(KEY); } catch (e) {} }

export const isSignedIn = () => !!session();
export const myEmail = () => session()?.email || '';
export const myName = () => session()?.name || '';
export const configured = () => !!GOOGLE_CLIENT_ID;

/** 서버로 보낼 출입증 머리말 (로그인 전에는 빈 값) */
export function authHeaders() {
  const s = session();
  return s ? { authorization: `Bearer ${s.token}` } : {};
}

let loading;
function loadGoogle() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
  if (!loading) {
    loading = new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = GSI; el.async = true; el.defer = true;
      el.onload = () => res();
      el.onerror = () => { loading = null; rej(new Error('구글 로그인 창을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요')); };
      document.head.appendChild(el);
    });
  }
  return loading;
}

const base = (st) => (st.serverUrl || '').replace(/\/+$/, '');

/** 설정 화면에 구글 로그인 단추를 얹는다. 로그인이 끝나면 onDone(오류, 계정) 이 불린다 */
export async function mountSignIn(el, st, onDone) {
  if (!GOOGLE_CLIENT_ID) throw new Error('구글 클라이언트 ID 가 아직 설정되지 않았습니다 (js/config.js)');
  if (!base(st)) throw new Error('회사 서버 주소를 먼저 넣어 주세요');
  await loadGoogle();
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (res) => {
      exchange(st, res.credential).then(acc => onDone(null, acc)).catch(err => onDone(err));
    },
  });
  el.innerHTML = '';
  google.accounts.id.renderButton(el, {
    theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ko', width: 240,
  });
}

/** 구글 신분증을 회사 서버 출입증으로 바꾼다 */
async function exchange(st, credential) {
  const r = await fetch(`${base(st)}/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(st.teamCode ? { 'x-team-code': st.teamCode } : {}) },
    body: JSON.stringify({ credential }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `로그인 실패 (${r.status})`);
  keep(j);
  return j;
}

/** 이 기기에서 로그아웃하고 서버의 출입증도 없앤다 */
export async function signOut(st) {
  const s = session();
  drop();
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  if (s && base(st)) {
    try {
      await fetch(`${base(st)}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, ...(st.teamCode ? { 'x-team-code': st.teamCode } : {}) },
      });
    } catch (e) { /* 통신이 안 돼도 이 기기에서는 이미 지워졌다 */ }
  }
}

/** 출입증이 아직 살아 있는지 서버에 물어본다 */
export async function refresh(st) {
  const s = session();
  if (!s || !base(st)) return null;
  try {
    const r = await fetch(`${base(st)}/auth/me`, { headers: { authorization: `Bearer ${s.token}` } });
    if (r.status === 401) { drop(); return null; }
    const j = await r.json();
    if (j && j.email) keep({ ...s, ...j });
    return session();
  } catch (e) { return s; }
}
