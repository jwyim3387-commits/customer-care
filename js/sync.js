// 회사 서버 동기화 : 기기에 먼저 저장하고, 통신이 될 때 서버와 주고받는다.
// 순서는 항상 '받기 → 합치기 → 보내기' 다. 그래야 다른 사람이 올린 기록을 지우지 않는다.
import * as S from './store.js';

export const serverBase = (st) => (st.serverUrl || '').replace(/\/+$/, '');
export const canSync = (st) => !!serverBase(st);

const headers = (st) => ({
  'content-type': 'application/json',
  ...(st.teamCode ? { 'x-team-code': st.teamCode } : {}),
  ...(st.userName ? { 'x-user': encodeURIComponent(st.userName) } : {}),   // 헤더는 영문만 가능해 인코딩
});

async function call(url, opt, timeout = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opt, signal: ac.signal });
    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch (e) { throw new Error('서버 응답을 읽지 못했습니다'); }
    if (!r.ok) throw new Error(j.error || `서버 오류 (${r.status})`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('서버가 응답하지 않습니다');
    throw e;
  } finally { clearTimeout(t); }
}

/** 서버 상태 확인 */
export async function health(st) {
  return call(`${serverBase(st)}/health`, { headers: headers(st) }, 8000);
}

/**
 * 한 번 동기화한다.
 * @param {object} [opt] full 을 켜면 마지막 시각을 무시하고 처음부터 모두 주고받는다
 * @returns {{pulled:number, pushed:number, applied:object, at:string}}
 */
export async function syncNow(st, onStatus, { full = false } = {}) {
  if (!canSync(st)) throw new Error('설정에서 회사 서버 주소를 먼저 넣어 주세요');
  const base = serverBase(st);
  // 전체 다시 받기 : 처음부터 모두 주고받아, 그동안 놓친 기록을 되살린다
  const since = full ? '' : (st.lastSync || '');

  onStatus?.('서버에서 받는 중…');
  const down = await call(`${base}/sync?since=${encodeURIComponent(since)}`, { headers: headers(st) });
  const applied = S.applyRemote(down.items || []);

  onStatus?.('내 기록을 올리는 중…');
  const items = S.changedSince(since);
  let pushed = 0;
  if (items.length) {
    const up = await call(`${base}/sync`, { method: 'POST', headers: headers(st), body: JSON.stringify({ items }) });
    pushed = up.saved || 0;
  }

  const at = down.now || new Date().toISOString();
  S.setSetting('lastSync', at);
  S.clearTombstones(since);
  return { pulled: down.count || 0, pushed, applied, at };
}

/** 앱을 열 때 조용히 한 번 (실패해도 앱 사용에는 지장 없음) */
export async function autoSync(st) {
  if (!canSync(st) || !navigator.onLine) return null;
  try { return await syncNow(st); } catch (e) { console.warn('자동 동기화 실패', e.message); return null; }
}

export const fmtWhen = (iso) => {
  if (!iso) return '아직 없음';
  const d = new Date(iso), now = new Date();
  const min = Math.round((now - d) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.round(min / 60)}시간 전`;
  return iso.slice(0, 16).replace('T', ' ');
};
