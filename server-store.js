/* 서버 쪽 영구 저장소. 브라우저 localStorage 대신 data/app-store.json 사용 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, 'data', 'app-store.json');

const DEFAULT_ACCOUNT = {
  name: '',
  email: '',
  joined: '',
  goal: '',
  targetDate: '',
  subjects: [],
  dailyTarget: 30,
  notify: { study: true, review: true, event: false },
};

function emptyStore() {
  return {
    users: [],
    sessions: {},
    accounts: {},
    plan: 'premium',
    payments: [],
    wrongNotes: [],
    studyLog: {},
    questionUsage: null,
  };
}

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { ...emptyStore(), ...raw, sessions: raw.sessions || {}, accounts: raw.accounts || {} };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function todayLabel() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    if (k) out[k] = v;
  });
  return out;
}

function cookieString(name, value, maxAgeSec) {
  const parts = [
    `${name}=${encodeURIComponent(value || '')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  const list = Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

function setSessionCookie(res, value, maxAgeSec) {
  appendSetCookie(res, cookieString('passcoach_session', value, maxAgeSec));
}

function setAuthCookies(res, { accessToken, refreshToken, accessMaxAge, refreshMaxAge }) {
  appendSetCookie(res, cookieString('passcoach_access', accessToken, accessMaxAge));
  appendSetCookie(res, cookieString('passcoach_refresh', refreshToken, refreshMaxAge));
}

function clearSessionCookie(res) {
  setSessionCookie(res, '', 0);
}

function clearAuthCookies(res) {
  appendSetCookie(res, cookieString('passcoach_access', '', 0));
  appendSetCookie(res, cookieString('passcoach_refresh', '', 0));
  clearSessionCookie(res);
}

function guestId(req, res) {
  const current = parseCookies(req).passcoach_guest || '';
  if (/^[a-f0-9]{32,64}$/.test(current)) return current;
  const next = crypto.randomBytes(16).toString('hex');
  if (res) appendSetCookie(res, cookieString('passcoach_guest', next, 60 * 60 * 24 * 365));
  return next;
}

function currentUser(req) {
  const store = load();
  const cookies = parseCookies(req);
  const sid = cookies.passcoach_session;
  if (!sid || !store.sessions[sid]) return null;
  return store.sessions[sid];
}

function accountKey(user) {
  return user && user.email ? String(user.email).toLowerCase() : '_guest';
}

module.exports = {
  load,
  save,
  token,
  todayLabel,
  parseCookies,
  setSessionCookie,
  setAuthCookies,
  clearSessionCookie,
  clearAuthCookies,
  guestId,
  currentUser,
  accountKey,
  DEFAULT_ACCOUNT,
  STORE_PATH,
};
