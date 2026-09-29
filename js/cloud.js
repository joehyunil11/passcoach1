/* GitHub Pages 등 정적 호스팅에서는 Node /api 가 없으므로
   브라우저가 Supabase Auth·REST 를 직접 호출합니다. */

const Cloud = (() => {
  'use strict';

  const SUPABASE_URL = 'https://oekdmpneohvcjcwrcudf.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9la2RtcG5lb2h2Y2pjd3JjdWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTQ1NjEsImV4cCI6MjEwMzY3MDU2MX0.6mtPIbKIXX-8YvUyYw_5aZGfdJxW6e1YnvREqlhLiIk';
  const AUTH_KEY = 'passcoach.auth';
  const LOG_KEY = 'passcoach.studyLog';
  const NOTES_KEY = 'passcoach.wrongNotes';
  const GUEST_KEY = 'passcoach.guestId';
  const AI_USED_KEY = 'passcoach.aiUsed';
  const CONFIG = (typeof window !== 'undefined' && window.PasscoachConfig) || {};
  const FREE_PERIOD = !!CONFIG.freePeriod;
  const AI_LIMIT = Number(CONFIG.aiLimit) || 100;
  const AI_LABEL = CONFIG.aiLabel || '무료 이용기간';

  function plainText(value, maxLen) {
    const xss = typeof PasscoachXss !== 'undefined' ? PasscoachXss : null;
    let s = xss && xss.stripTags ? xss.stripTags(value) : String(value == null ? '' : value);
    s = String(s).trim();
    if (Number.isInteger(maxLen) && maxLen > 0) s = s.slice(0, maxLen);
    return s;
  }
  const SUBJECT_IDS = [
    'korean',
    'english',
    'history',
    'adminlaw',
    'adminsci',
    'peducation',
    'localtax',
    'accounting',
    'socialwelfare',
  ];
  const SUBJECT_ALIASES = {
    korean: ['korean', '국어', '9급 국어', '9급국어'],
    english: ['english', '영어', '9급 영어', '9급영어'],
    history: ['history', '한국사'],
    adminlaw: ['adminlaw', '행정법'],
    adminsci: ['adminsci', '행정학'],
    peducation: ['peducation', '교육학개론', '교육학'],
    localtax: ['localtax', '지방세법', '지방세'],
    accounting: ['accounting', '회계학'],
    socialwelfare: ['socialwelfare', '사회복지학개론', '사회복지학', '사회복지'],
  };
  const SUBJECT_TITLES = {
    korean: '9급 국어',
    english: '9급 영어',
    history: '한국사',
    adminlaw: '행정법',
    adminsci: '행정학',
    peducation: '교육학개론',
    localtax: '지방세법',
    accounting: '회계학',
    socialwelfare: '사회복지학개론',
  };

  const questionCache = new Map();
  let subjectNameCache = null;
  let subjectRowCache = null;
  let countCache = null;

  function isPages() {
    return /\.github\.io$/i.test(location.hostname);
  }

  function fail(message, status) {
    const err = new Error(message || '요청에 실패했습니다.');
    err.status = status || 400;
    throw err;
  }

  function saved() {
    try {
      return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function save(session) {
    if (!session || !session.access_token) localStorage.removeItem(AUTH_KEY);
    else localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  }

  function publicUser(user) {
    if (!user) return null;
    const meta = user.user_metadata || {};
    const name = meta.name || meta.nickname || meta.full_name || (user.email ? String(user.email).split('@')[0] : '회원');
    return {
      id: user.id,
      name,
      email: user.email,
      provider: meta.provider || 'email',
      created_at: user.created_at || null,
    };
  }

  function formatJoined(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(d)
        .replace(/-/g, '.');
    } catch {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
    }
  }

  async function authUserRecord() {
    const session = await refreshIfNeeded();
    if (!session || !session.access_token) return session && session.user ? session.user : null;
    if (session.user && session.user.created_at) return session.user;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const user = await res.json().catch(() => null);
      if (user && user.id) {
        save({ ...session, user });
        return user;
      }
    } catch {
      /* ignore */
    }
    return session.user || null;
  }

  function translateAuth(data, fallback) {
    const msg = String((data && (data.error_description || data.msg || data.error || data.message)) || fallback || '');
    if (/invalid login|invalid credentials/i.test(msg)) return '아이디 또는 비밀번호가 올바르지 않습니다.';
    if (/already registered|already been registered|user already/i.test(msg)) return '이미 가입된 이메일입니다.';
    if (/email not confirmed/i.test(msg)) return '이메일 확인이 필요합니다.';
    return msg || fallback || '요청에 실패했습니다.';
  }

  async function authPost(path, body, token) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}${path}`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
      });
    } catch {
      fail('네트워크 오류로 요청하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(translateAuth(data), res.status);
    return data;
  }

  function expirySeconds(value, fallbackToken) {
    let exp = Number(value);
    if (exp > 1e12) exp = Math.floor(exp / 1000);
    if (exp > 1e9) return exp;
    if (fallbackToken) {
      try {
        const payload = JSON.parse(atob(String(fallbackToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const jwtExp = Number(payload.exp);
        if (jwtExp > 1e9) return jwtExp;
      } catch {
        /* ignore */
      }
    }
    return 0;
  }

  function sessionFresh(session) {
    if (!session || !session.access_token) return false;
    const exp = expirySeconds(session.expires_at, session.access_token);
    return exp * 1000 > Date.now() + 30_000;
  }

  async function refreshIfNeeded() {
    const session = saved();
    if (!session || !session.access_token) return session;
    if (sessionFresh(session)) return session;
    if (!session.refresh_token) return session;
    try {
      const data = await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      const next = {
        ...session,
        ...data,
        user: data.user || session.user,
        expires_at:
          expirySeconds(data.expires_at, data.access_token) ||
          Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
      };
      save(next);
      return next;
    } catch {
      return session;
    }
  }

  function isPublicRead(path, method) {
    if (method !== 'GET' && method !== 'HEAD') return false;
    const pathname = String(path || '').split('?')[0];
    return pathname === '/rest/v1/questions' || pathname === '/rest/v1/subjects' || pathname === '/rest/v1/legal_pages';
  }

  async function rest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const publicRead = options.anon === true || isPublicRead(path, method);
    const session = publicRead ? saved() : await refreshIfNeeded();
    const token = publicRead ? SUPABASE_ANON_KEY : (session && session.access_token) || SUPABASE_ANON_KEY;
    const headers = {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    };
    if (method !== 'GET' && method !== 'HEAD' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers,
      body: options.body,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return method === 'GET' ? [] : null;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      fail('문제 데이터를 읽지 못했습니다. 다시 시도해 주세요.', res.status || 500);
    }
    if (!res.ok) fail((data && (data.message || data.error || data.hint)) || `요청 실패 (${res.status})`, res.status);
    return data;
  }

  async function publicFetch(path, extraHeaders) {
    return fetch(`${SUPABASE_URL}${path}`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: 'application/json',
        'Accept-Profile': 'public',
        Prefer: 'return=representation',
        ...(extraHeaders || {}),
      },
    });
  }

  async function rpc(name, args) {
    return rest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args || {}) });
  }

  /* 비회원이 개인 학습 RPC를 부르면 user_id 가 비어 있는 공용 행에 섞이므로, 이 기기(localStorage)에만 저장한다 */
  async function userRpc(name, args) {
    const session = await refreshIfNeeded();
    if (!session || !session.access_token) fail('로그인 후 이용하세요', 401);
    return rpc(name, args);
  }

  async function currentUser() {
    return publicUser(await authUserRecord());
  }

  async function login({ email, password }) {
    const data = await authPost('/auth/v1/token?grant_type=password', { email, password });
    save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at:
        expirySeconds(data.expires_at, data.access_token) ||
        Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
      user: data.user,
    });
    await rejectWithdrawn();
    await ensureSignupProfile(publicUser(data.user));
    return { user: publicUser(data.user) };
  }

  async function signup({ name, email, password }) {
    const cleanName = plainText(name, 20);
    const redirect = encodeURIComponent(`${pageDir()}index.html`);
    const data = await authPost(`/auth/v1/signup?redirect_to=${redirect}`, {
      email,
      password,
      data: { name: cleanName, nickname: cleanName, provider: 'email' },
    });
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0 && !data.access_token) {
      fail('이미 가입된 이메일입니다.', 409);
    }
    if (data.access_token) {
      save({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at:
          expirySeconds(data.expires_at, data.access_token) ||
          Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600),
        user: data.user,
      });
      await ensureSignupProfile(publicUser(data.user));
      return { user: publicUser(data.user) };
    }
    try {
      return await login({ email, password });
    } catch (err) {
      if (/이메일 확인|email not confirmed/i.test(err.message || '')) {
        return { user: null, message: '가입 확인 메일을 보냈습니다. 메일함을 확인한 뒤 로그인해 주세요.' };
      }
      throw err;
    }
  }

  async function logout() {
    const session = saved();
    try {
      if (session && session.access_token) await authPost('/auth/v1/logout', {}, session.access_token);
    } catch {
      /* ignore */
    }
    save(null);
    return { ok: true };
  }

  function isWithdrawnProfile(row) {
    return String((row && row.status) || '').replace(/\s+/g, '') === '회원탈퇴';
  }

  async function rejectWithdrawn() {
    const user = await currentUser();
    if (!user) return;
    try {
      const rows = await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=status`);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (isWithdrawnProfile(row)) {
        await logout();
        fail('탈퇴한 계정입니다.', 403);
      }
    } catch (err) {
      if (err && err.status === 403 && /탈퇴/.test(err.message || '')) throw err;
    }
  }

  function seoulDate(iso) {
    const label = formatJoined(iso || new Date().toISOString());
    return label ? label.replace(/\./g, '-') : null;
  }

  async function ensureSignupProfile(user) {
    if (!user || !user.id) return;
    const joinedOn = seoulDate(user.created_at);
    const row = {
      id: user.id,
      nickname: user.name || null,
      email: user.email || null,
      joined_on: joinedOn,
      plan: 'premium',
      updated_at: new Date().toISOString(),
    };
    if (user.created_at) row.created_at = user.created_at;
    try {
      await rest('/rest/v1/profiles?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
    } catch {
      try {
        await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            email: user.email || undefined,
            joined_on: joinedOn,
            plan: 'premium',
            updated_at: row.updated_at,
          }),
        });
      } catch {
        /* profiles.joined_on 컬럼이 없으면 supabase-profiles-joined.sql 을 실행해야 합니다 */
      }
    }
  }

  async function leaveAccount() {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    try {
      await rpc('withdraw_account');
    } catch {
      try {
        await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: '회원탈퇴',
            email: user.email || undefined,
            updated_at: new Date().toISOString(),
          }),
        });
      } catch {
        /* status 컬럼이 없으면 supabase-profiles-withdraw.sql 을 실행해야 합니다 */
      }
    }
    await logout();
    return { ok: true };
  }

  function pageDir() {
    const path = location.pathname;
    const i = path.lastIndexOf('/');
    return `${location.origin}${path.slice(0, i + 1)}`;
  }

  async function resetPassword({ email }) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Redirect-To': `${pageDir()}reset-password.html`,
      },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(translateAuth(data, '메일을 보내지 못했습니다.'), res.status);
    return { message: '가입된 이메일이면 비밀번호 재설정 메일을 보냈습니다.' };
  }

  async function recoverPassword({ password, accessToken, refreshToken }) {
    if (!accessToken) fail('유효한 재설정 링크가 아닙니다.');
    save({ access_token: accessToken, refresh_token: refreshToken || '', user: null, expires_at: 0 });
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(translateAuth(data, '비밀번호를 바꾸지 못했습니다.'), res.status);
    save(null);
    return { ok: true };
  }

  async function findId({ name, email }) {
    if (email && email.includes('@')) return { accounts: [email] };
    if (name) fail('GitHub Pages에서는 가입한 이메일로 비밀번호 찾기를 이용해 주세요.');
    fail('이름 또는 이메일을 입력해 주세요.');
  }

  function compact(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function resolveSubjectId(value) {
    if (value && typeof value === 'object') {
      return resolveSubjectId(value.name) || resolveSubjectId(value.code) || resolveSubjectId(value.id) || '';
    }
    const key = compact(value);
    if (!key) return '';
    const ids = Object.keys(SUBJECT_ALIASES);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (compact(id) === key || SUBJECT_ALIASES[id].some((alias) => compact(alias) === key)) return id;
    }
    return String(value || '').trim();
  }

  function uniqueAliases(wanted) {
    const id = resolveSubjectId(wanted) || String(wanted || '').trim();
    const list = [id, wanted, ...(SUBJECT_ALIASES[id] || [])];
    if (subjectNameCache) {
      subjectNameCache.forEach((name) => {
        if (resolveSubjectId(name) === id) list.push(name);
      });
    }
    const out = [];
    const seen = new Set();
    list.forEach((item) => {
      const raw = String(item || '').trim();
      const key = compact(raw);
      if (!raw || seen.has(key)) return;
      seen.add(key);
      out.push(raw);
    });
    return out;
  }

  function subjectQuery(wanted) {
    const parts = uniqueAliases(wanted).map((alias) => `subjects.eq.${encodeURIComponent(alias)}`);
    return `or=(${parts.join(',')})`;
  }

  function mapQuestion(row) {
    const answerRaw = row.answer;
    let answerNo = Number(answerRaw);
    if (!Number.isFinite(answerNo) && typeof answerRaw === 'string') {
      const found = answerRaw.match(/[1-5]/);
      if (found) answerNo = Number(found[0]);
    }
    const options = [];
    const fromArray = Array.isArray(row.options) ? row.options : [];
    for (let i = 1; i <= 5; i += 1) {
      const keyed = row[`option${i}`];
      const listed = fromArray[i - 1];
      const value = keyed != null && String(keyed).trim() !== '' ? keyed : listed;
      if (value == null || String(value).trim() === '') continue;
      options.push(String(value));
    }
    let imageUrl = String(row.image_url || row.imageUrl || row.image || '').trim();
    if (imageUrl && !/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith('data:')) {
      const objectPath = imageUrl.replace(/^\/+/, '').replace(/^question-images\//, '');
      imageUrl = `${SUPABASE_URL}/storage/v1/object/public/question-images/${objectPath
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')}`;
    }
    return {
      id: row.id,
      topic: String(row.type || row.topic || '').trim(),
      type: String(row.type || row.topic || '').trim(),
      kind: row.kind || '',
      q: row.question || row.q || '',
      options,
      answer: answerNo >= 1 && answerNo <= options.length ? answerNo - 1 : 0,
      explain: row.explanation || row.explain || '',
      imageUrl,
      subjects: resolveSubjectId(row.subjects || row.subject) || row.subjects,
    };
  }

  async function fetchPages(makePath, pageSize = 200) {
    const out = [];
    const size = Math.max(50, Number(pageSize) || 200);
    let from = 0;
    while (from < 50000) {
      const to = from + size - 1;
      const rows = await rest(makePath(), { anon: true, headers: { Range: `${from}-${to}` } });
      const list = Array.isArray(rows) ? rows : [];
      out.push(...list);
      if (list.length < size) break;
      from += size;
    }
    return out;
  }

  async function loadSubjectRows() {
    if (subjectRowCache) return subjectRowCache;
    const rows = await rest('/rest/v1/subjects?select=id,name,code,created_at&order=id.asc');
    subjectRowCache = Array.isArray(rows) ? rows : [];
    return subjectRowCache;
  }

  async function countSubject(id) {
    const filter = subjectQuery(id);
    const res = await publicFetch(`/rest/v1/questions?select=id&${filter}`, {
      Prefer: 'count=exact',
      Range: '0-0',
    });
    if (!res.ok) return 0;
    const range = res.headers.get('content-range') || '';
    const total = range.split('/')[1];
    if (!total || total === '*') return 0;
    return Number(total) || 0;
  }

  async function listSubjects() {
    const subjects = await loadSubjectRows();
    const tallies = {};
    try {
      await Promise.all(
        SUBJECT_IDS.map(async (id) => {
          tallies[id] = await countSubject(id);
        })
      );
    } catch {
      /* counts optional */
    }
    countCache = tallies;
    return { source: 'supabase', subjects, counts: tallies };
  }

  async function loadQuestionRows(wanted) {
    const select = 'id,subjects,kind,type,question,option1,option2,option3,option4,option5,answer,explanation,image_url';
    const aliases = uniqueAliases(wanted).sort((a, b) => {
      const ah = /[가-힣]/.test(a) ? 0 : 1;
      const bh = /[가-힣]/.test(b) ? 0 : 1;
      return ah - bh;
    });
    const seen = new Set();
    const collected = [];
    const addRows = (rows) => {
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        if (!row || seen.has(row.id)) return;
        seen.add(row.id);
        collected.push(row);
      });
    };
    for (let i = 0; i < aliases.length; i += 1) {
      try {
        addRows(
          await fetchPages(
            () => `/rest/v1/questions?select=${select}&subjects=eq.${encodeURIComponent(aliases[i])}&order=id.asc`,
            150
          )
        );
        if (collected.length) return collected;
      } catch {
        /* next alias */
      }
    }
    try {
      addRows(await fetchPages(() => `/rest/v1/questions?select=${select}&${subjectQuery(wanted)}&order=id.asc`, 150));
    } catch {
      addRows(await fetchPages(() => `/rest/v1/questions?select=*&subjects=eq.${encodeURIComponent(aliases[0] || wanted)}&order=id.asc`, 80));
    }
    return collected;
  }

  async function listQuestions(search) {
    const subjects = search.get('subjects') || search.get('subject') || 'korean';
    const wanted = resolveSubjectId(subjects) || subjects;
    if (questionCache.has(wanted) && questionCache.get(wanted).length) {
      return { source: 'supabase', subjects: wanted, questions: questionCache.get(wanted) };
    }
    const rows = await loadQuestionRows(wanted);
    const questions = rows.map(mapQuestion);
    if (questions.length) questionCache.set(wanted, questions);
    return { source: 'supabase', subjects: wanted, questions };
  }

  function premiumEntitlements() {
    return {
      plan: 'premium',
      features: { review: true, record: true, grades: true, weakness: true, similar: true, teacher: true },
      questions: {
        used: 0,
        usedPeriod: 0,
        limit: null,
        remaining: null,
        unlimited: true,
        periodKind: 'day',
        periodLabel: '오늘',
        plan: 'premium',
      },
      ai: {
        used: 0,
        usedPeriod: 0,
        limit: 1000,
        remaining: 1000,
        unlimited: false,
        periodKind: 'month',
        periodLabel: '이번 달',
        plan: 'premium',
      },
      source: 'supabase',
    };
  }

  async function getAccount() {
    const raw = await authUserRecord();
    const user = publicUser(raw);
    if (!user) return { user: null, account: null, plan: 'premium', payments: [], profile: null };
    let profile = null;
    try {
      const rows = await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`);
      profile = Array.isArray(rows) ? rows[0] : rows;
    } catch {
      profile = null;
    }
    const created = (raw && raw.created_at) || user.created_at || (profile && profile.created_at) || '';
    const joined =
      formatJoined(profile && profile.joined_on) ||
      formatJoined(created);
    return {
      user,
      account: {
        name: (profile && (profile.nickname || profile.name)) || user.name,
        email: (profile && profile.email) || user.email,
        joined: joined,
        goal: (profile && (profile.target_exam || profile.goal)) || '',
        targetDate: (profile && profile.target_date) || '',
        subjects: (profile && profile.subjects) || [],
        dailyTarget: (profile && profile.daily_target) || 30,
        notify: (profile && profile.notify) || { study: true, review: true, event: false },
      },
      plan: (profile && profile.plan) || 'premium',
      payments: [],
      profile,
    };
  }

  async function saveAccount(body) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    const account = body.account || body || {};
    await rest('/rest/v1/profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: user.id,
        nickname: account.name || user.name,
        email: account.email || user.email,
        target_exam: account.goal || '',
        target_date: account.targetDate || null,
        subjects: Array.isArray(account.subjects) ? account.subjects : [],
        daily_target: Number(account.dailyTarget) || 30,
        notify: account.notify || { study: true, review: true, event: false },
        plan: 'premium',
        updated_at: new Date().toISOString(),
      }),
    });
    return { ok: true, ...(await getAccount()) };
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function mapWrongNote(row) {
    return {
      subject: resolveSubjectId(row.subjects || row.subject) || row.subjects || '',
      index: row.question_index != null ? Number(row.question_index) : Number(row.index),
      topic: row.topic || '',
      q: row.note || row.q || '',
      questionId: row.question_id || row.questionId || null,
      date: row.last_wrong_at || row.date || new Date().toISOString(),
      selectedAnswer: row.selected_answer,
    };
  }

  async function getWrongNotes() {
    const user = await currentUser();
    try {
      const rows = await userRpc('list_wrong_notes');
      const notes = (Array.isArray(rows) ? rows : []).map(mapWrongNote);
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      return { notes, source: 'supabase', user };
    } catch {
      try {
        if (user) {
          const rows = await rest(
            `/rest/v1/wrong_notes?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=last_wrong_at.desc`
          );
          const notes = (Array.isArray(rows) ? rows : []).map(mapWrongNote);
          return { notes, source: 'supabase', user };
        }
      } catch {
        /* local */
      }
      return { notes: readJson(NOTES_KEY, []), source: 'local', user };
    }
  }

  async function saveWrongNote(body) {
    try {
      await userRpc('upsert_wrong_note', {
        p_question_id: body.questionId || null,
        p_subjects: body.subject || null,
        p_question_index: Number.isInteger(Number(body.index)) ? Number(body.index) : null,
        p_topic: body.topic || null,
        p_note: body.q || null,
        p_selected_answer: Number.isFinite(Number(body.selectedAnswer)) ? Number(body.selectedAnswer) : null,
        p_last_wrong_at: new Date().toISOString(),
        p_increment: true,
      });
      return getWrongNotes();
    } catch {
      const notes = readJson(NOTES_KEY, []);
      notes.unshift({
        subject: body.subject || '',
        index: body.index,
        topic: body.topic || '',
        q: body.q || '',
        questionId: body.questionId || null,
        selectedAnswer: body.selectedAnswer,
        date: new Date().toISOString(),
      });
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes.slice(0, 500)));
      return { notes, source: 'local' };
    }
  }

  async function deleteWrongNote(body) {
    try {
      await userRpc('delete_wrong_note', {
        p_question_id: body.questionId || null,
        p_subjects: body.subject || null,
        p_question_index: Number.isInteger(Number(body.index)) ? Number(body.index) : null,
        p_all: !!body.all,
      });
      return getWrongNotes();
    } catch {
      let notes = readJson(NOTES_KEY, []);
      if (body && body.all) notes = [];
      else notes = notes.filter((item) => !(item.subject === body.subject && Number(item.index) === Number(body.index)));
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      return { notes, source: 'local' };
    }
  }

  function rateOf(correct, attempted) {
    return attempted ? Math.round((correct / attempted) * 100) : 0;
  }

  function gradesFromLog(log, counts) {
    return SUBJECT_IDS.map((id) => {
      const byIndex = (log && log[id]) || {};
      const attempted = Object.keys(byIndex).length;
      const correct = Object.values(byIndex).filter((item) => item && item.correct).length;
      const total = Number(counts[id]) || 0;
      const totalRate = rateOf(correct, total);
      return {
        id,
        subjects: id,
        title: SUBJECT_TITLES[id] || id,
        short: SUBJECT_TITLES[id] || id,
        total,
        attempted,
        correct,
        rate: rateOf(correct, attempted),
        totalRate,
        difficulty: !total ? 'empty' : totalRate >= 70 ? 'high' : totalRate >= 60 ? 'mid' : 'low',
      };
    });
  }

  function weaknessFromLog(log) {
    return Object.entries(log || {})
      .map(([subject, byIndex]) => {
        const buckets = {};
        Object.values(byIndex || {}).forEach((item) => {
          if (!item) return;
          const area = String(item.topic || '기타').split('·')[0].trim() || '기타';
          if (!buckets[area]) buckets[area] = { attempted: 0, correct: 0, wrong: 0, sampleTopic: item.topic || area };
          buckets[area].attempted += 1;
          if (item.correct) buckets[area].correct += 1;
          else buckets[area].wrong += 1;
        });
        const areas = Object.entries(buckets)
          .map(([area, row]) => ({
            name: area,
            area,
            attempted: row.attempted,
            correct: row.correct,
            wrong: row.wrong,
            wrongRate: rateOf(row.wrong, row.attempted),
            sampleTopic: row.sampleTopic,
          }))
          .filter((row) => row.wrong > 0)
          .sort((a, b) => b.wrongRate - a.wrongRate || b.wrong - a.wrong);
        const top = areas.slice(0, 2).map((row) => row.name);
        return {
          subjectId: subject,
          subjects: subject,
          headline: SUBJECT_TITLES[subject] || subject,
          analysis: top.length ? `${top.join(', ')} 영역에서 오답률이 높습니다.` : '',
          drillTopic: top.join(','),
          drillLabel: top.length ? `${top[0]} 문제 5개 풀기` : '',
          areas,
        };
      })
      .filter((row) => row.areas && row.areas.length);
  }

  function statsFromLog(log) {
    const attempts = [];
    Object.values(log || {}).forEach((byIndex) => {
      Object.values(byIndex || {}).forEach((item) => {
        if (item) attempts.push(item);
      });
    });
    const attempted = attempts.length;
    const correct = attempts.filter((item) => item.correct).length;
    const days = [
      ...new Set(
        attempts
          .map((item) => String(item.date || '').slice(0, 10))
          .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
      ),
    ].sort();
    let streak = 0;
    if (days.length) {
      streak = 1;
      for (let i = days.length - 1; i > 0; i -= 1) {
        const prev = new Date(`${days[i - 1]}T00:00:00`);
        const cur = new Date(`${days[i]}T00:00:00`);
        if ((cur - prev) / 86400000 === 1) streak += 1;
        else break;
      }
    }
    return {
      attempted,
      correct,
      rate: rateOf(correct, attempted),
      studyDays: days.length,
      streak,
      study_days: days.length,
      studyDates: days,
    };
  }

  async function questionCounts() {
    if (countCache) return countCache;
    try {
      const data = await listSubjects();
      countCache = data.counts || {};
      return countCache;
    } catch {
      return {};
    }
  }

  async function loadRemoteAnswers() {
    const user = await currentUser();
    if (!user) return [];
    try {
      const rows = await rest(
        `/rest/v1/user_answers?user_id=eq.${encodeURIComponent(user.id)}&select=id,question_id,selected_answer,is_correct,response_time,answered_at,questions(subjects,type)&order=answered_at.asc`
      );
      return Array.isArray(rows) ? rows : [];
    } catch {
      try {
        const rows = await rest(
          `/rest/v1/user_answers?user_id=eq.${encodeURIComponent(user.id)}&select=id,question_id,selected_answer,is_correct,response_time,answered_at&order=answered_at.asc`
        );
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    }
  }

  function mergeAnswersIntoLog(log, answers) {
    const next = { ...(log || {}) };
    (answers || []).forEach((row) => {
      const nested = row.questions && typeof row.questions === 'object' ? row.questions : {};
      const subject = resolveSubjectId(nested.subjects || row.subjects);
      if (!subject) return;
      const cached = questionCache.get(subject) || [];
      const index = cached.findIndex((item) => Number(item.id) === Number(row.question_id));
      const key = index >= 0 ? String(index) : `id:${row.question_id}`;
      if (!next[subject]) next[subject] = {};
      next[subject][key] = {
        topic: nested.type || row.type || '',
        correct: !!row.is_correct,
        date: row.answered_at || new Date().toISOString(),
      };
    });
    return next;
  }

  async function getStudyLog() {
    const local = readJson(LOG_KEY, {});
    const answers = await loadRemoteAnswers();
    const log = mergeAnswersIntoLog(local, answers);
    const localStats = statsFromLog(log);
    const localWeakness = weaknessFromLog(log);
    const [remoteStats, remoteGrades, remoteWeakness] = await Promise.all([
      userRpc('get_study_stats').catch(() => null),
      userRpc('list_subject_grades').catch(() => null),
      userRpc('list_weakness').catch(() => null),
    ]);
    let stats = Array.isArray(remoteStats) ? remoteStats[0] : remoteStats;
    if (!stats || localStats.attempted > (Number(stats.attempted) || 0)) stats = localStats;
    let grades = Array.isArray(remoteGrades) ? remoteGrades : [];
    if (!grades.length) grades = gradesFromLog(log, countCache || {});
    let weakness = Array.isArray(remoteWeakness) ? remoteWeakness : [];
    if (!weakness.length) weakness = localWeakness;
    return { log, answers, stats, grades, weakness, source: 'supabase' };
  }

  async function postStudyLog(body) {
    const log = readJson(LOG_KEY, {});
    const subject = resolveSubjectId(body.subject) || String(body.subject || '');
    if (!log[subject]) log[subject] = {};
    log[subject][String(body.index)] = {
      topic: body.topic || '',
      correct: !!body.correct,
      date: new Date().toISOString(),
    };
    localStorage.setItem(LOG_KEY, JSON.stringify(log));

    const user = await currentUser();
    if (user && body.questionId) {
      try {
        await rest('/rest/v1/user_answers', {
          method: 'POST',
          body: JSON.stringify({
            user_id: user.id,
            question_id: body.questionId,
            selected_answer: Number(body.selectedAnswer) || null,
            is_correct: !!body.correct,
            response_time: Number(body.responseTime) || null,
          }),
        });
      } catch {
        /* ignore */
      }
    }

    const stats = statsFromLog(log);
    const grades = gradesFromLog(log, countCache || {});
    const weakness = weaknessFromLog(log);
    try {
      await userRpc('save_study_stats', {
        p_attempted: stats.attempted,
        p_correct: stats.correct,
        p_study_days: stats.studyDays,
        p_streak: stats.streak,
        p_study_dates: stats.studyDates,
      });
    } catch {
      /* ignore */
    }
    try {
      await userRpc('save_subject_grades', {
        p_rows: grades.map((row) => ({
          subjects: row.id,
          title: row.title,
          total: row.total,
          attempted: row.attempted,
          correct: row.correct,
          rate: row.totalRate,
          difficulty: row.difficulty,
        })),
      });
    } catch {
      /* ignore */
    }
    try {
      await userRpc('save_weakness', {
        p_rows: weakness.map((row) => ({
          subjects: row.subjectId,
          headline: row.headline,
          analysis: row.analysis,
          drill_topic: row.drillTopic,
          drill_label: row.drillLabel,
          areas: row.areas,
        })),
      });
    } catch {
      /* ignore */
    }
    return { log, answers: [], stats, grades, weakness, questions: premiumEntitlements().questions, source: 'supabase' };
  }

  function guestId() {
    let id = '';
    try {
      id = localStorage.getItem(GUEST_KEY) || '';
    } catch {
      id = '';
    }
    if (/^[a-f0-9-]{32,40}$/i.test(id)) return id;
    id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    try {
      localStorage.setItem(GUEST_KEY, id);
    } catch {
      /* ignore */
    }
    return id;
  }

  async function aiOwner() {
    const user = await currentUser();
    return user ? `user:${user.id}` : `guest:${guestId()}`;
  }

  function readAiUsed(owner) {
    const all = readJson(AI_USED_KEY, {});
    return Number(all && all[owner]) || 0;
  }

  function writeAiUsed(owner, used) {
    const all = readJson(AI_USED_KEY, {}) || {};
    all[owner] = Math.max(0, Number(used) || 0);
    try {
      localStorage.setItem(AI_USED_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function aiUsageInfo(used) {
    const n = Math.max(0, Number(used) || 0);
    return {
      used: n,
      usedPeriod: n,
      limit: AI_LIMIT,
      remaining: Math.max(0, AI_LIMIT - n),
      unlimited: false,
      periodKind: 'total',
      periodLabel: AI_LABEL,
      plan: 'premium',
    };
  }

  async function callAskAi(payload) {
    const session = await refreshIfNeeded();
    const token = (session && session.access_token) || SUPABASE_ANON_KEY;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function getAiUsage() {
    const owner = await aiOwner();
    let used = readAiUsed(owner);
    try {
      const { res, data } = await callAskAi({ action: 'usage' });
      if (res.ok && data.usage && Number.isFinite(Number(data.usage.used))) {
        used = Math.max(used, Number(data.usage.used));
        writeAiUsed(owner, used);
      }
    } catch {
      /* 서버 집계가 없으면 이 기기 기록만 사용 */
    }
    return aiUsageInfo(used);
  }

  async function askAi(body) {
    const user = await currentUser();
    if (!user) fail('로그인 후 이용하세요', 401);
    const { res, data } = await callAskAi({ messages: body.messages || [] });
    if (!res.ok) {
      fail(data.error || data.message || 'AI 응답에 실패했습니다.', res.status);
    }
    return { answer: data.answer, usage: premiumEntitlements().ai, source: 'supabase' };
  }

  async function changePassword({ currentPassword, newPassword }) {
    const user = await currentUser();
    if (!user || !user.email) fail('로그인이 필요합니다.', 401);
    await login({ email: user.email, password: currentPassword });
    const session = saved();
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(translateAuth(data, '비밀번호를 바꾸지 못했습니다.'), res.status);
    return { ok: true };
  }

  async function requireBoardUser() {
    const user = await currentUser();
    if (!user) fail('로그인 후 이용하세요', 401);
    return user;
  }

  async function isAdminUser() {
    const user = await currentUser();
    if (!user) return false;
    try {
      const rows = await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=is_admin`);
      const row = Array.isArray(rows) ? rows[0] : rows;
      return !!(row && row.is_admin);
    } catch {
      return false;
    }
  }

  function noticeApiError(err) {
    const msg = String((err && err.message) || '');
    if (/does not exist|schema cache|could not find the table|PGRST205|relation .*notices/i.test(msg)) {
      fail('공지사항 테이블이 없습니다. supabase-notices.sql을 실행해 주세요.', 503);
    }
    if (/row-level security|permission denied|42501/i.test(msg)) {
      fail('관리자만 공지를 작성·수정·삭제할 수 있습니다.', 403);
    }
    throw err;
  }

  function mapNotice(row) {
    if (!row || typeof row !== 'object') return null;
    return {
      id: row.id,
      title: row.title || '',
      content: row.content || '',
      pinned: !!row.pinned,
      author_id: row.author_id || null,
      author_name: row.author_name || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function listNotices() {
    await requireBoardUser();
    let rows;
    try {
      rows = await rest('/rest/v1/notices?select=*&order=pinned.desc,created_at.desc');
    } catch (err) {
      noticeApiError(err);
    }
    return {
      notices: (Array.isArray(rows) ? rows : []).map(mapNotice).filter(Boolean),
      admin: await isAdminUser(),
    };
  }

  async function getNotice(id) {
    await requireBoardUser();
    let rows;
    try {
      rows = await rest(`/rest/v1/notices?id=eq.${encodeURIComponent(id)}&select=*`);
    } catch (err) {
      noticeApiError(err);
    }
    const notice = mapNotice(Array.isArray(rows) ? rows[0] : rows);
    if (!notice) fail('공지를 찾을 수 없습니다.', 404);
    return { notice, admin: await isAdminUser() };
  }

  async function createNotice(body) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    if (!(await isAdminUser())) fail('관리자만 공지를 작성할 수 있습니다.', 403);
    const title = plainText((body && body.title) || '', 80);
    const content = plainText((body && body.content) || '', 20000);
    if (!title || !content) fail('제목과 내용을 입력해 주세요.');
    let rows;
    try {
      rows = await rest('/rest/v1/notices', {
        method: 'POST',
        body: JSON.stringify({
          title,
          content,
          pinned: !!(body && body.pinned),
          author_id: user.id,
          author_name: plainText(user.name || '', 40),
        }),
      });
    } catch (err) {
      noticeApiError(err);
    }
    const notice = mapNotice(Array.isArray(rows) ? rows[0] : rows);
    return { ok: true, notice, notices: (await listNotices()).notices, admin: true };
  }

  async function updateNotice(id, body) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    if (!(await isAdminUser())) fail('관리자만 공지를 수정할 수 있습니다.', 403);
    const patch = {
      updated_at: new Date().toISOString(),
    };
    if (body && body.title != null) patch.title = plainText(body.title, 80);
    if (body && body.content != null) patch.content = plainText(body.content, 20000);
    if (body && body.pinned != null) patch.pinned = !!body.pinned;
    if (!patch.title && body && body.title != null) fail('제목을 입력해 주세요.');
    if (!patch.content && body && body.content != null) fail('내용을 입력해 주세요.');
    let rows;
    try {
      rows = await rest(`/rest/v1/notices?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    } catch (err) {
      noticeApiError(err);
    }
    const notice = mapNotice(Array.isArray(rows) ? rows[0] : rows);
    if (!notice) fail('공지를 찾을 수 없습니다.', 404);
    return { ok: true, notice, notices: (await listNotices()).notices, admin: true };
  }

  async function deleteNotice(id) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    if (!(await isAdminUser())) fail('관리자만 공지를 삭제할 수 있습니다.', 403);
    try {
      await rest(`/rest/v1/notices?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      noticeApiError(err);
    }
    return { ok: true, notices: (await listNotices()).notices, admin: true };
  }

  function reportApiError(err) {
    const msg = String((err && err.message) || '');
    if (/does not exist|schema cache|could not find the table|PGRST205|function .*reports|relation .*reports/i.test(msg)) {
      fail('오류 신고 테이블이 없습니다. supabase-reports.sql을 실행해 주세요.', 503);
    }
    throw err;
  }

  function mapReportSummary(row) {
    if (!row || typeof row !== 'object') return null;
    return {
      id: row.id,
      title: row.title || '',
      created_at: row.created_at,
      has_answer: !!row.has_answer,
    };
  }

  function mapReportDetail(row) {
    if (!row || typeof row !== 'object') return null;
    return {
      ...mapReportSummary(row),
      content: row.content || '',
      author_name: row.author_name || '',
      answer: row.answer || '',
      answered_at: row.answered_at || null,
      updated_at: row.updated_at,
    };
  }

  async function listReports() {
    await requireBoardUser();
    let rows;
    try {
      rows = await rpc('list_reports');
    } catch (err) {
      reportApiError(err);
    }
    const list = Array.isArray(rows) ? rows : [];
    return {
      reports: list.map(mapReportSummary).filter(Boolean),
      admin: await isAdminUser(),
    };
  }

  async function createReport(body) {
    await requireBoardUser();
    const title = plainText((body && body.title) || '', 80);
    const content = plainText((body && body.content) || '', 20000);
    const password = String((body && body.password) || '');
    if (!title || !content) fail('제목과 내용을 입력해 주세요.');
    if (password.length < 4) fail('비밀번호는 4자 이상이어야 합니다.');
    let row;
    try {
      row = await rpc('create_report', { p_title: title, p_content: content, p_password: password });
    } catch (err) {
      reportApiError(err);
    }
    return { ok: true, report: mapReportDetail(row), reports: (await listReports()).reports, admin: await isAdminUser() };
  }

  async function openReport(id, body) {
    await requireBoardUser();
    let row;
    try {
      row = await rpc('open_report', {
        p_id: Number(id),
        p_password: body && body.password != null ? String(body.password) : '',
      });
    } catch (err) {
      reportApiError(err);
    }
    const report = mapReportDetail(row);
    if (!report) fail('글을 찾을 수 없습니다.', 404);
    return { report, admin: await isAdminUser() };
  }

  async function replyReport(id, body) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    if (!(await isAdminUser())) fail('관리자만 답변할 수 있습니다.', 403);
    const answer = plainText((body && body.answer) || '', 20000);
    if (!answer) fail('답변을 입력해 주세요.');
    let row;
    try {
      row = await rpc('reply_report', { p_id: Number(id), p_answer: answer });
    } catch (err) {
      reportApiError(err);
    }
    return { ok: true, report: mapReportDetail(row), reports: (await listReports()).reports, admin: true };
  }

  async function deleteReport(id) {
    const user = await currentUser();
    if (!user) fail('로그인이 필요합니다.', 401);
    if (!(await isAdminUser())) fail('관리자만 삭제할 수 있습니다.', 403);
    try {
      await rpc('delete_report', { p_id: Number(id) });
    } catch (err) {
      reportApiError(err);
    }
    return { ok: true, reports: (await listReports()).reports, admin: true };
  }

  function mapLegalPage(row) {
    if (!row || typeof row !== 'object') return null;
    return {
      slug: row.slug,
      title: row.title || '',
      lead: row.lead || '',
      content: row.content || '',
      sort_order: Number(row.sort_order) || 0,
      updated_at: row.updated_at || null,
    };
  }

  async function listLegalPages() {
    let rows;
    try {
      rows = await rest('/rest/v1/legal_pages?select=slug,title,lead,content,sort_order,updated_at&order=sort_order.asc', { anon: true });
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (/does not exist|schema cache|could not find the table|PGRST205|relation .*legal_pages/i.test(msg)) {
        fail('약관 테이블이 없습니다. supabase-legal.sql을 실행해 주세요.', 503);
      }
      throw err;
    }
    return { pages: (Array.isArray(rows) ? rows : []).map(mapLegalPage).filter(Boolean) };
  }

  async function getLegalPage(slug) {
    const key = String(slug || '').toLowerCase();
    if (!/^(terms|privacy|support)$/.test(key)) fail('항목을 찾을 수 없습니다.', 404);
    const data = await listLegalPages();
    const page = (data.pages || []).find((item) => item.slug === key);
    if (!page) fail('항목을 찾을 수 없습니다.', 404);
    return { page };
  }

  async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const [pathname, query] = String(path || '').split('?');
    const search = new URLSearchParams(query || '');
    let body = {};
    if (options.body) {
      try {
        body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      } catch {
        body = {};
      }
    }

    if (pathname === '/api/health' && method === 'GET') return { ok: true, provider: 'supabase', supabase: true, ai: true };
    if (pathname === '/api/session' && method === 'GET') return { user: await currentUser() };
    if (pathname === '/api/auth/login' && method === 'POST') return login(body);
    if (pathname === '/api/auth/signup' && method === 'POST') return signup(body);
    if (pathname === '/api/auth/logout' && method === 'POST') return logout();
    if (pathname === '/api/auth/reset-password' && method === 'POST') return resetPassword(body);
    if (pathname === '/api/auth/recover-password' && method === 'POST') return recoverPassword(body);
    if (pathname === '/api/auth/find-id' && method === 'POST') return findId(body);
    if (pathname === '/api/subjects' && method === 'GET') return listSubjects();
    if (pathname === '/api/questions' && method === 'GET') return listQuestions(search);
    if (pathname === '/api/entitlements' && method === 'GET') {
      const pack = premiumEntitlements();
      return FREE_PERIOD ? { ...pack, ai: await getAiUsage() } : pack;
    }
    if (pathname === '/api/ai-usage' && method === 'GET') {
      return { usage: FREE_PERIOD ? await getAiUsage() : premiumEntitlements().ai, source: 'supabase' };
    }
    if (pathname === '/api/account' && method === 'GET') return getAccount();
    if (pathname === '/api/account' && method === 'PUT') return saveAccount(body);
    if (pathname === '/api/account/password' && method === 'POST') return changePassword(body);
    if (pathname === '/api/wrong-notes' && method === 'GET') return getWrongNotes();
    if (pathname === '/api/wrong-notes' && method === 'POST') return saveWrongNote(body);
    if (pathname === '/api/wrong-notes' && method === 'DELETE') return deleteWrongNote(body);
    if (pathname === '/api/study-log' && method === 'GET') return getStudyLog();
    if (pathname === '/api/study-log' && method === 'POST') return postStudyLog(body);
    if (pathname === '/api/ask' && method === 'POST') return askAi(body);
    if (pathname === '/api/billing/plan' && method === 'PUT') return { plan: 'premium' };
    if (pathname === '/api/billing/payments' && method === 'POST') return { ok: true };
    if (pathname === '/api/account/leave' && method === 'POST') {
      return leaveAccount();
    }
    if (pathname === '/api/legal' && method === 'GET') return listLegalPages();
    const legalMatch = pathname.match(/^\/api\/legal\/([^/]+)$/);
    if (legalMatch && method === 'GET') return getLegalPage(legalMatch[1]);
    const noticeMatch = pathname.match(/^\/api\/notices(?:\/([^/]+))?$/);
    if (noticeMatch) {
      if (method === 'GET' && !noticeMatch[1]) return listNotices();
      if (method === 'GET') return getNotice(noticeMatch[1]);
      if (method === 'POST' && !noticeMatch[1]) return createNotice(body);
      if ((method === 'PUT' || method === 'PATCH') && noticeMatch[1]) return updateNotice(noticeMatch[1], body);
      if (method === 'DELETE' && noticeMatch[1]) return deleteNotice(noticeMatch[1]);
    }
    const reportMatch = pathname.match(/^\/api\/reports(?:\/([^/]+)(?:\/(open|reply))?)?$/);
    if (reportMatch) {
      const reportId = reportMatch[1];
      const action = reportMatch[2];
      if (method === 'GET' && !reportId) return listReports();
      if (method === 'POST' && !reportId) return createReport(body);
      if (method === 'POST' && reportId && action === 'open') return openReport(reportId, body);
      if (method === 'POST' && reportId && action === 'reply') return replyReport(reportId, body);
      if (method === 'DELETE' && reportId && !action) return deleteReport(reportId);
    }
    fail('지원하지 않는 요청입니다.', 404);
  }

  return { isPages, request, currentUser, pageDir, resolveSubjectId };
})();
