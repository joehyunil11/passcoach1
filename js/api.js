/* 브라우저 ↔ 서버 API 헬퍼 (localStorage 없음) */

const AppApi = (() => {
  'use strict';

  function handleUnauthorized() {
    const page = location.pathname.split(/[/\\]/).pop() || 'index.html';
    if (/^(login|signup|find-account|reset-password)\.html/i.test(page)) return;
    if (page === 'index.html' || page === '') {
      if (typeof Shell !== 'undefined') Shell.showToast('로그인 후 이용하세요');
      return;
    }
    location.replace('index.html?needLogin=1');
  }

  async function request(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && path !== '/api/session' && !String(path).startsWith('/api/auth/')) {
        handleUnauthorized();
      }
      const err = new Error(data.error || data.hint || `요청 실패 (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

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

  function compactSubject(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function resolveSubjectId(value) {
    if (value && typeof value === 'object') {
      return resolveSubjectId(value.name) || resolveSubjectId(value.code) || '';
    }
    const key = compactSubject(value);
    if (!key) return '';
    const ids = Object.keys(SUBJECT_ALIASES);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const aliases = SUBJECT_ALIASES[id];
      if (compactSubject(id) === key || aliases.some((alias) => compactSubject(alias) === key)) return id;
    }
    return String(value || '').trim();
  }

  function getQuestions(subjects) {
    const code = resolveSubjectId(subjects) || 'korean';
    return request(`/api/questions?subjects=${encodeURIComponent(code)}`);
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body || {}) }),
    del: (path, body) => request(path, { method: 'DELETE', body: JSON.stringify(body || {}) }),
    getQuestions,
    resolveSubjectId,
  };
})();
