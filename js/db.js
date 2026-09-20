// 녹음 파일 보관 (IndexedDB). 서버 없이 기기 안에만 저장한다.
const NAME = 'mindone-cc';
const STORE = 'audio';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: 'id' });
        st.createIndex('siteId', 'siteId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
};

export const putAudio = (rec) => tx('readwrite', (s) => s.put(rec));
export const getAudio = (id) => tx('readonly', (s) => s.get(id));
export const delAudio = (id) => tx('readwrite', (s) => s.delete(id));

export async function listAudio(siteId) {
  const all = await tx('readonly', (s) => s.getAll());
  const rows = (all || []).map(({ blob, ...meta }) => meta);
  return rows
    .filter(r => !siteId || r.siteId === siteId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function usage() {
  const all = await tx('readonly', (s) => s.getAll());
  const bytes = (all || []).reduce((n, r) => n + (r.size || 0), 0);
  return { count: (all || []).length, bytes };
}

export const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB');
