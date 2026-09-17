// 로컬 저장소 : 데이터는 이 기기 브라우저에만 저장된다(서버 없음).
const KEY = 'mindone.customercare.v1';

const EMPTY = { sites: [], visits: [], settings: { model: 'claude-sonnet-5', stt: 'browser' } };

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const today = () => new Date().toISOString().slice(0, 10);

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const d = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } };
  } catch (e) {
    console.warn('저장소 읽기 실패', e);
    return structuredClone(EMPTY);
  }
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    alert('저장 공간이 부족합니다. 설정에서 오래된 방문 기록을 내보낸 뒤 삭제해 주세요.');
  }
}

export const all = () => db;
export const settings = () => db.settings;

export function setSetting(k, v) { db.settings[k] = v; save(); }

/* ───────── 사이트(지자체) */
export function sites() {
  return [...db.sites].sort((a, b) => (lastVisitDate(b.id) || '').localeCompare(lastVisitDate(a.id) || ''));
}
export const site = (id) => db.sites.find(s => s.id === id);

export function addSite(org) {
  const s = {
    id: uid(), org: org || '새 지자체', ourTeam: '', system: '', amount: '', method: '',
    managers: [], logs: [], actions: [], memo: {}, createdAt: new Date().toISOString(),
  };
  db.sites.push(s); save(); return s;
}
export function updateSite(id, patch) {
  const s = site(id); if (!s) return; Object.assign(s, patch); save();
}
export function removeSite(id) {
  db.sites = db.sites.filter(s => s.id !== id);
  db.visits = db.visits.filter(v => v.siteId !== id);
  save();
}

/* ───────── 상담 누적 · 담당자 · 후속 조치 */
export function addLog(siteId, log = {}) {
  const s = site(siteId); if (!s) return null;
  const l = { id: uid(), date: today(), counterpart: '', visitor: '', summary: '', request: '', issue: '', promise: '', ...log };
  s.logs.unshift(l); save(); return l;
}
export function updateLog(siteId, logId, patch) {
  const l = site(siteId)?.logs.find(x => x.id === logId); if (!l) return; Object.assign(l, patch); save();
}
export function removeLog(siteId, logId) {
  const s = site(siteId); if (!s) return; s.logs = s.logs.filter(x => x.id !== logId); save();
}

export function addManager(siteId, m = {}) {
  const s = site(siteId); if (!s) return null;
  const x = { id: uid(), name: '', title: '', phone: '', traits: '', history: '', ...m };
  s.managers.push(x); save(); return x;
}
export function updateManager(siteId, id, patch) {
  const m = site(siteId)?.managers.find(x => x.id === id); if (!m) return; Object.assign(m, patch); save();
}
export function removeManager(siteId, id) {
  const s = site(siteId); if (!s) return; s.managers = s.managers.filter(x => x.id !== id); save();
}

export function addAction(siteId, a = {}) {
  const s = site(siteId); if (!s) return null;
  const x = { id: uid(), text: '', owner: '', due: '', done: false, ...a };
  s.actions.push(x); save(); return x;
}
export function updateAction(siteId, id, patch) {
  const a = site(siteId)?.actions.find(x => x.id === id); if (!a) return; Object.assign(a, patch); save();
}
export function removeAction(siteId, id) {
  const s = site(siteId); if (!s) return; s.actions = s.actions.filter(x => x.id !== id); save();
}

/* ───────── 방문(질문지) */
export const visits = (siteId) =>
  db.visits.filter(v => !siteId || v.siteId === siteId).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
export const visit = (id) => db.visits.find(v => v.id === id);

export function addVisit(siteId) {
  const s = site(siteId);
  const v = {
    id: uid(), siteId, date: today(), dept: s ? s.org : '', counterpart: '', counterpartInfo: '',
    visitor: '', purpose: '', pre: {}, answers: {}, close: {}, transcript: '', audioName: '',
    createdAt: new Date().toISOString(),
  };
  db.visits.push(v); save(); return v;
}
export function updateVisit(id, patch) {
  const v = visit(id); if (!v) return; Object.assign(v, patch); save();
}
export function removeVisit(id) { db.visits = db.visits.filter(v => v.id !== id); save(); }

export function lastVisitDate(siteId) {
  const v = visits(siteId)[0];
  const l = site(siteId)?.logs?.[0];
  return [v?.date, l?.date].filter(Boolean).sort().pop() || '';
}

/* ───────── 백업 */
export function exportJson() {
  return JSON.stringify(db, null, 1);
}
export function importJson(text) {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.sites)) throw new Error('형식이 올바르지 않습니다');
  db = { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } };
  save();
}
export function wipe() { db = structuredClone(EMPTY); save(); }
