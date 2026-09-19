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
    };
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

  async function refreshIfNeeded() {
    const session = saved();
    if (!session || !session.refresh_token) return session;
    const exp = Number(session.expires_at);
    if (exp && exp * 1000 > Date.now() + 30_000) return session;
    try {
      const data = await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      const next = {
        ...session,
        ...data,
        user: data.user || session.user,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      };
      save(next);
      return next;
    } catch {
      save(null);
      return null;
    }
  }

  async function rest(path, options = {}) {
    const session = await refreshIfNeeded();
    const token = (session && session.access_token) || SUPABASE_ANON_KEY;
    const method = String(options.method || 'GET').toUpperCase();
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail((data && (data.message || data.error || data.hint)) || `요청 실패 (${res.status})`, res.status);
    return data;
  }

  async function rpc(name, args) {
    return rest(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args || {}) });
  }

  async function currentUser() {
    const session = await refreshIfNeeded();
    return publicUser(session && session.user);
  }

  async function login({ email, password }) {
    const data = await authPost('/auth/v1/token?grant_type=password', { email, password });
    save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: data.user,
    });
    return { user: publicUser(data.user) };
  }

  async function signup({ name, email, password }) {
    const redirect = encodeURIComponent(`${pageDir()}index.html`);
    const data = await authPost(`/auth/v1/signup?redirect_to=${redirect}`, {
      email,
      password,
      data: { name, nickname: name, provider: 'email' },
    });
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0 && !data.access_token) {
      fail('이미 가입된 이메일입니다.', 409);
    }
    if (data.access_token) {
      save({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user: data.user,
      });
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

  async function fetchPages(makePath) {
    const out = [];
    let from = 0;
    while (from < 50000) {
      const to = from + 999;
      const rows = await rest(makePath(), { headers: { Range: `${from}-${to}` } });
      const list = Array.isArray(rows) ? rows : [];
      out.push(...list);
      if (list.length < 1000) break;
      from += 1000;
    }
    return out;
  }

  async function loadSubjectRows() {
    if (subjectRowCache) return subjectRowCache;
    const rows = await rest('/rest/v1/subjects?select=id,name,code,created_at&order=id.asc');
    subjectRowCache = Array.isArray(rows) ? rows : [];
    return subjectRowCache;
  }

  async function listSubjects() {
    const subjects = await loadSubjectRows();
    const tallies = {};
    try {
      const rows = await fetchPages(() => '/rest/v1/questions?select=subjects');
      subjectNameCache = [...new Set(rows.map((row) => String(row.subjects || '').trim()).filter(Boolean))];
      rows.forEach((row) => {
        const id = resolveSubjectId(row.subjects);
        if (id) tallies[id] = (tallies[id] || 0) + 1;
      });
    } catch {
      subjectNameCache = subjectNameCache || [];
    }
    countCache = tallies;
    return { source: 'supabase', subjects, counts: tallies };
  }

  async function listQuestions(search) {
    const subjects = search.get('subjects') || search.get('subject') || 'korean';
    const wanted = resolveSubjectId(subjects) || subjects;
    if (questionCache.has(wanted)) {
      return { source: 'supabase', subjects: wanted, questions: questionCache.get(wanted) };
    }
    const filter = subjectQuery(wanted);
    const rows = await fetchPages(() => `/rest/v1/questions?select=*&${filter}&order=id.asc`);
    const questions = rows.map(mapQuestion);
    questionCache.set(wanted, questions);
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
    const user = await currentUser();
    if (!user) return { user: null, account: null, plan: 'premium', payments: [], profile: null };
    let profile = null;
    try {
      const rows = await rest(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`);
      profile = Array.isArray(rows) ? rows[0] : rows;
    } catch {
      profile = null;
    }
    return {
      user,
      account: {
        name: (profile && (profile.nickname || profile.name)) || user.name,
        email: (profile && profile.email) || user.email,
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
      const rows = await rpc('list_wrong_notes');
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
      await rpc('upsert_wrong_note', {
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
      await rpc('delete_wrong_note', {
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
    let stats = null;
    let grades = null;
    let weakness = null;
    try {
      const row = await rpc('get_study_stats');
      stats = Array.isArray(row) ? row[0] : row;
    } catch {
      stats = statsFromLog(log);
    }
    try {
      const rows = await rpc('list_subject_grades');
      grades = Array.isArray(rows) ? rows : [];
    } catch {
      grades = gradesFromLog(log, await questionCounts());
    }
    try {
      const rows = await rpc('list_weakness');
      weakness = Array.isArray(rows) ? rows : [];
    } catch {
      weakness = weaknessFromLog(log);
    }
    if (!stats) stats = statsFromLog(log);
    if (!grades || !grades.length) grades = gradesFromLog(log, await questionCounts());
    if (!weakness || !weakness.length) weakness = weaknessFromLog(log);
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
    const counts = await questionCounts();
    const grades = gradesFromLog(log, counts);
    const weakness = weaknessFromLog(log);
    try {
      await rpc('save_study_stats', {
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
      await rpc('save_subject_grades', {
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
      await rpc('save_weakness', {
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

  async function askAi(body) {
    const session = await refreshIfNeeded();
    const token = (session && session.access_token) || SUPABASE_ANON_KEY;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ask-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: body.messages || [] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data.error || data.message || 'AI 응답에 실패했습니다.', res.status);
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
    if (pathname === '/api/entitlements' && method === 'GET') return premiumEntitlements();
    if (pathname === '/api/ai-usage' && method === 'GET') return { usage: premiumEntitlements().ai, source: 'supabase' };
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
      await logout();
      return { ok: true };
    }
    fail('지원하지 않는 요청입니다.', 404);
  }

  return { isPages, request, currentUser, pageDir, resolveSubjectId };
})();
