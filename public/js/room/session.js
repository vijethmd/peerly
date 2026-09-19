// Persisted preferences (localStorage) and per-tab call session (sessionStorage).

function storage(kind) {
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage;
    const probe = '__peerly__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null; // private mode or blocked storage
  }
}

const local = storage('local');
const session = storage('session');

function readJson(store, key) {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(store, key, value) {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or blocked: preferences are best-effort */
  }
}

const PREFS_KEY = 'peerly-prefs';

export const prefs = {
  get(key, fallback) {
    const all = readJson(local, PREFS_KEY) || {};
    return key in all ? all[key] : fallback;
  },
  set(key, value) {
    const all = readJson(local, PREFS_KEY) || {};
    all[key] = value;
    writeJson(local, PREFS_KEY, all);
  }
};

export function getName() {
  return (local && local.getItem('peerly-name')) || '';
}

export function setName(name) {
  try {
    local?.setItem('peerly-name', name);
  } catch {
    /* ignore */
  }
}

/** Stable per-browser id; lets a host's removal stick across rejoin attempts. */
export function getClientId() {
  let id = local && local.getItem('peerly-client-id');
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    try {
      local?.setItem('peerly-client-id', id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

export function rememberRoom(roomId) {
  try {
    const recent = (readJson(local, 'peerly-recent') || []).filter((entry) => entry && entry.roomId !== roomId);
    recent.unshift({ roomId, at: Date.now() });
    writeJson(local, 'peerly-recent', recent.slice(0, 5));
  } catch {
    /* ignore */
  }
}

const sessionKey = (roomId) => `peerly-session:${roomId}`;

export function loadSession(roomId) {
  return readJson(session, sessionKey(roomId));
}

export function saveSession(roomId, data) {
  writeJson(session, sessionKey(roomId), { ...data, savedAt: Date.now() });
}

/** Marks the saved call as current again, so the next load rejoins directly. */
export function touchSession(roomId) {
  const stored = loadSession(roomId);
  if (stored) saveSession(roomId, { ...stored, inCall: true });
}

export function clearSession(roomId) {
  try {
    session?.removeItem(sessionKey(roomId));
  } catch {
    /* ignore */
  }
}
