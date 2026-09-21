// 로컬 저장소 : 데이터는 이 기기 브라우저에만 저장된다(서버 없음).
const KEY = 'mindone.customercare.v1';

const EMPTY = { sites: [], visits: [], tombstones: [], settings: { model: 'claude-sonnet-5', stt: 'browser' } };

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
  const s = site(id); if (!s) return; Object.assign(s, patch, { updatedAt: new Date().toISOString() }); save();
}
export function removeSite(id) {
  db.visits.filter(v => v.siteId === id).forEach(v => tomb('visit', v.id));
  tomb('site', id);
  db.sites = db.sites.filter(s => s.id !== id);
  db.visits = db.visits.filter(v => v.siteId !== id);
  save();
}

const touch = (siteId) => { const s2 = site(siteId); if (s2) s2.updatedAt = new Date().toISOString(); };
const tomb = (kind, id) => { db.tombstones = [...(db.tombstones || []).filter(t => !(t.kind === kind && t.id === id)),
  { kind, id, updatedAt: new Date().toISOString() }]; };

/* ───────── 상담 누적 · 담당자 · 후속 조치 */
export function addLog(siteId, log = {}) {
  const s = site(siteId); if (!s) return null;
  const l = { id: uid(), date: today(), counterpart: '', visitor: '', summary: '', request: '', issue: '', promise: '', ...log };
  s.logs.unshift(l); touch(siteId); save(); return l;
}
export function updateLog(siteId, logId, patch) {
  const l = site(siteId)?.logs.find(x => x.id === logId); if (!l) return; Object.assign(l, patch); touch(siteId); save();
}
export function removeLog(siteId, logId) {
  const s = site(siteId); if (!s) return; s.logs = s.logs.filter(x => x.id !== logId); touch(siteId); save();
}

export function addManager(siteId, m = {}) {
  const s = site(siteId); if (!s) return null;
  const x = { id: uid(), name: '', title: '', phone: '', traits: '', history: '', ...m };
  s.managers.push(x); touch(siteId); save(); return x;
}
export function updateManager(siteId, id, patch) {
  const m = site(siteId)?.managers.find(x => x.id === id); if (!m) return; Object.assign(m, patch); touch(siteId); save();
}
export function removeManager(siteId, id) {
  const s = site(siteId); if (!s) return; s.managers = s.managers.filter(x => x.id !== id); touch(siteId); save();
}

export function addAction(siteId, a = {}) {
  const s = site(siteId); if (!s) return null;
  const x = { id: uid(), text: '', owner: '', due: '', done: false, ...a };
  s.actions.push(x); touch(siteId); save(); return x;
}
export function updateAction(siteId, id, patch) {
  const a = site(siteId)?.actions.find(x => x.id === id); if (!a) return; Object.assign(a, patch); touch(siteId); save();
}
export function removeAction(siteId, id) {
  const s = site(siteId); if (!s) return; s.actions = s.actions.filter(x => x.id !== id); touch(siteId); save();
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
  const v = visit(id); if (!v) return; Object.assign(v, patch, { updatedAt: new Date().toISOString() }); save();
}
export function removeVisit(id) { tomb('visit', id); db.visits = db.visits.filter(v => v.id !== id); save(); }

export function lastVisitDate(siteId) {
  const v = visits(siteId)[0];
  const l = site(siteId)?.logs?.[0];
  return [v?.date, l?.date].filter(Boolean).sort().pop() || '';
}

/* ───────── 백업 */
/** share=true 면 설정(API 키)을 빼고 내보낸다. 동료에게 줄 파일은 반드시 공유용으로 */
export function exportJson({ share = false } = {}) {
  const out = share ? { sites: db.sites, visits: db.visits, sharedAt: new Date().toISOString() } : db;
  return JSON.stringify(out, null, 1);
}
export function importJson(text) {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.sites)) throw new Error('형식이 올바르지 않습니다');
  db = { ...structuredClone(EMPTY), ...d, settings: { ...EMPTY.settings, ...(d.settings || {}) } };
  save();
}
export function wipe() { db = structuredClone(EMPTY); save(); }

/* ───────── 병합 (동료 백업 파일 합치기)
   같은 항목은 한 번만 남기고, 상담 기록처럼 쌓이는 자료는 양쪽을 모두 살린다.
   설정(API 키)은 가져오지 않는다. */

const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
const newer = (a, b) => (b.updatedAt || b.createdAt || '') > (a.updatedAt || a.createdAt || '');

function mergeList(target, incoming, sig) {
  let added = 0;
  const byId = new Map(target.map(x => [x.id, x]));
  const bySig = new Map(target.map(x => [sig(x), x]));
  for (const item of incoming || []) {
    const cur = byId.get(item.id) || bySig.get(sig(item));
    if (!cur) {
      const copy = { ...item, id: byId.has(item.id) ? uid() : (item.id || uid()) };
      target.push(copy); byId.set(copy.id, copy); bySig.set(sig(copy), copy); added++;
      continue;
    }
    for (const [k, v] of Object.entries(item)) {          // 빈 칸만 채운다
      if (k === 'id') continue;
      if (v && !String(cur[k] ?? '').trim()) cur[k] = v;
    }
  }
  return added;
}

export function mergeJson(text) {
  const inc = JSON.parse(text);
  if (!inc || !Array.isArray(inc.sites)) throw new Error('형식이 올바르지 않습니다');
  const st = { sitesAdded: 0, sitesMerged: 0, managers: 0, logs: 0, actions: 0, visitsAdded: 0, visitsMerged: 0 };
  const idMap = {};

  for (const s2 of inc.sites) {
    let cur = db.sites.find(x => x.id === s2.id) || db.sites.find(x => norm(x.org) === norm(s2.org));
    if (!cur) {
      cur = { ...structuredClone(s2), id: db.sites.some(x => x.id === s2.id) ? uid() : (s2.id || uid()) };
      cur.managers ||= []; cur.logs ||= []; cur.actions ||= []; cur.memo ||= {};
      db.sites.push(cur); st.sitesAdded++;
    } else {
      st.sitesMerged++;
      for (const k of ['org', 'ourTeam', 'system', 'amount', 'method']) {
        if (s2[k] && !String(cur[k] ?? '').trim()) cur[k] = s2[k];
      }
      cur.memo = { ...(s2.memo || {}), ...(cur.memo || {}) };          // 내 값 우선
      st.managers += mergeList(cur.managers ||= [], s2.managers, m => norm(m.name) + '|' + norm(m.title));
      st.logs += mergeList(cur.logs ||= [], s2.logs, l => norm(l.date) + '|' + norm(l.counterpart) + '|' + norm((l.summary || '').slice(0, 30)));
      st.actions += mergeList(cur.actions ||= [], s2.actions, a => norm(a.text) + '|' + norm(a.owner));
    }
    idMap[s2.id] = cur.id;
  }

  for (const v of inc.visits || []) {
    const siteId = idMap[v.siteId] || v.siteId;
    if (!db.sites.some(x => x.id === siteId)) continue;               // 사이트 없는 방문은 건너뜀
    const cur = db.visits.find(x => x.id === v.id);
    if (!cur) { db.visits.push({ ...structuredClone(v), siteId }); st.visitsAdded++; continue; }
    st.visitsMerged++;
    for (const key of ['answers', 'pre', 'close']) {
      const src = v[key] || {}; const dst = cur[key] ||= {};
      for (const [k, val] of Object.entries(src)) if (val && !String(dst[k] ?? '').trim()) dst[k] = val;
    }
    for (const k of ['dept', 'counterpart', 'counterpartInfo', 'visitor', 'purpose', 'transcript']) {
      if (v[k] && !String(cur[k] ?? '').trim()) cur[k] = v[k];
    }
    if (newer(cur, v) && v.date) cur.date = v.date;
  }

  save();
  return st;
}


/* ═════════ 서버 동기화 지원 ═════════ */

const stamp = (o) => o.updatedAt || o.createdAt || '1970-01-01T00:00:00.000Z';

/** since 이후에 바뀐 것만 모아 올릴 형태로 만든다 */
export function changedSince(since = '') {
  const out = [];
  for (const s2 of db.sites) if (stamp(s2) > since) out.push({ kind: 'site', id: s2.id, updatedAt: stamp(s2), data: s2 });
  for (const v of db.visits) if (stamp(v) > since) out.push({ kind: 'visit', id: v.id, updatedAt: stamp(v), data: v });
  for (const t of db.tombstones || []) if (t.updatedAt > since) out.push({ kind: t.kind, id: t.id, updatedAt: t.updatedAt, deleted: true });
  return out;
}

/** 서버에서 받은 것을 반영한다. 목록(상담 기록 등)은 합치고, 겹치는 값은 나중에 고친 쪽을 쓴다 */
export function applyRemote(items = []) {
  const st = { sitesNew: 0, sitesUpdated: 0, visitsNew: 0, visitsUpdated: 0, removed: 0 };
  for (const it of items) {
    if (!it || !it.kind || !it.id) continue;

    if (it.deleted) {
      if (it.kind === 'site' && db.sites.some(x => x.id === it.id)) {
        db.sites = db.sites.filter(x => x.id !== it.id);
        db.visits = db.visits.filter(v => v.siteId !== it.id);
        st.removed++;
      } else if (it.kind === 'visit' && db.visits.some(x => x.id === it.id)) {
        db.visits = db.visits.filter(x => x.id !== it.id); st.removed++;
      }
      db.tombstones = (db.tombstones || []).filter(t => !(t.kind === it.kind && t.id === it.id));
      continue;
    }

    const R = it.data || {};
    if (it.kind === 'site') {
      // 번호가 다르더라도 이름이 같으면 같은 사이트로 본다
      const cur = db.sites.find(x => x.id === it.id) || db.sites.find(x => norm(x.org) === norm(R.org));
      if (!cur) { db.sites.push(structuredClone(R)); st.sitesNew++; continue; }
      const remoteNewer = stamp(R) > stamp(cur);
      for (const k of ['org', 'ourTeam', 'system', 'amount', 'method']) {
        if (R[k] && (remoteNewer || !String(cur[k] ?? '').trim())) cur[k] = R[k];
      }
      cur.memo = remoteNewer ? { ...(cur.memo || {}), ...(R.memo || {}) } : { ...(R.memo || {}), ...(cur.memo || {}) };
      mergeList(cur.managers ||= [], R.managers, m => norm(m.name) + '|' + norm(m.title));
      mergeList(cur.logs ||= [], R.logs, l => norm(l.date) + '|' + norm(l.counterpart) + '|' + norm((l.summary || '').slice(0, 30)));
      mergeList(cur.actions ||= [], R.actions, a => norm(a.text) + '|' + norm(a.owner));
      if (remoteNewer) cur.updatedAt = R.updatedAt;
      st.sitesUpdated++;
    } else if (it.kind === 'visit') {
      const cur = db.visits.find(x => x.id === it.id);
      if (!cur) { db.visits.push(structuredClone(R)); st.visitsNew++; continue; }
      const remoteNewer = stamp(R) > stamp(cur);
      for (const key of ['answers', 'pre', 'close']) {
        const src = R[key] || {}; const dst = cur[key] ||= {};
        for (const [k, val] of Object.entries(src)) {
          if (val && (remoteNewer || !String(dst[k] ?? '').trim())) dst[k] = val;
        }
      }
      for (const k of ['date', 'dept', 'counterpart', 'counterpartInfo', 'visitor', 'purpose', 'transcript']) {
        if (R[k] && (remoteNewer || !String(cur[k] ?? '').trim())) cur[k] = R[k];
      }
      if (remoteNewer) cur.updatedAt = R.updatedAt;
      st.visitsUpdated++;
    }
  }
  const merged = dedupeSites();
  if (merged) st.duplicatesMerged = merged;
  save();
  return st;
}

/** 서버가 받아 간 삭제 기록은 정리한다 */
export function clearTombstones(upTo) {
  db.tombstones = (db.tombstones || []).filter(t => t.updatedAt > upTo);
  save();
}


/** 이름이 같은 사이트를 하나로 합친다 (기기마다 따로 만들어 번호가 다른 경우) */
export function dedupeSites() {
  const groups = new Map();
  for (const s2 of db.sites) {
    const key = norm(s2.org);
    if (!key) continue;
    (groups.get(key) || groups.set(key, []).get(key)).push(s2);
  }
  let merged = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // 기록이 많은 쪽, 같으면 먼저 만든 쪽을 남긴다
    list.sort((a, b) => (b.logs?.length || 0) - (a.logs?.length || 0)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const keep = list[0];
    for (const dup of list.slice(1)) {
      for (const k of ['ourTeam', 'system', 'amount', 'method']) {
        if (dup[k] && !String(keep[k] ?? '').trim()) keep[k] = dup[k];
      }
      keep.memo = { ...(dup.memo || {}), ...(keep.memo || {}) };
      mergeList(keep.managers ||= [], dup.managers, m => norm(m.name) + '|' + norm(m.title));
      mergeList(keep.logs ||= [], dup.logs, l => norm(l.date) + '|' + norm(l.counterpart) + '|' + norm((l.summary || '').slice(0, 30)));
      mergeList(keep.actions ||= [], dup.actions, a => norm(a.text) + '|' + norm(a.owner));
      db.visits.forEach(v => { if (v.siteId === dup.id) { v.siteId = keep.id; v.updatedAt = new Date().toISOString(); } });
      tomb('site', dup.id);                       // 다른 기기에서도 지워지도록
      db.sites = db.sites.filter(x => x.id !== dup.id);
      merged++;
    }
    keep.updatedAt = new Date().toISOString();
  }
  if (merged) save();
  return merged;
}
