/* 로그인 · 회원가입 · 상단바 계정 (서버 세션 쿠키, localStorage 없음) */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (str) =>
    String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  let currentUser = null;

  function toast(message) {
    if (typeof Shell !== 'undefined') Shell.showToast(message);
  }

  function renderTopbar() {
    const wrap = $('#topbarAuth');
    if (!wrap) return;

    if (currentUser) {
      wrap.innerHTML = `
        <span class="topbar__user" title="${esc(currentUser.email)}">${esc(currentUser.name)}</span>
        <button class="topbar__btn topbar__btn--ghost" type="button" data-logout="true">로그아웃</button>`;
      return;
    }

    wrap.innerHTML = `
      <a class="topbar__btn topbar__btn--ghost" href="login.html">로그인</a>
      <a class="topbar__btn topbar__btn--primary" href="signup.html">회원가입</a>`;
  }

  async function refreshSession() {
    try {
      const data = await AppApi.get('/api/session');
      currentUser = data.user || null;
    } catch {
      currentUser = null;
    }
    renderTopbar();
    if (currentUser && /(?:login|signup)\.html$/i.test(location.pathname)) {
      location.replace(safeNext());
    }
  }

  function safeNext() {
    const raw = String(new URLSearchParams(location.search).get('next') || '').trim();
    if (!raw || raw.includes('://') || raw.startsWith('//') || raw.includes('..')) return 'index.html';
    const value = raw.replace(/^\//, '');
    const file = value.split(/[?#]/)[0] || '';
    if (!/^[A-Za-z0-9._-]+\.html$/i.test(file)) return 'index.html';
    if (/^(login|signup|find-account|reset-password)\.html$/i.test(file)) return 'index.html';
    return value;
  }

  refreshSession();

  const recoveryHash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (recoveryHash.get('type') === 'recovery' && recoveryHash.get('access_token') && !location.pathname.endsWith('reset-password.html')) {
    location.replace(`reset-password.html${location.hash}`);
    return;
  }

  const snsParams = new URLSearchParams(location.search);
  const sns = snsParams.get('sns');
  const snsError = snsParams.get('sns_error');
  if (snsError) {
    const label = sns === 'naver' ? '네이버' : '카카오';
    let msg = `${label} 로그인에 실패했습니다.`;
    if (snsError === 'nokey') {
      msg =
        sns === 'naver'
          ? '네이버 로그인 키가 없습니다. .env에 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET를 넣은 뒤 서버를 다시 실행해 주세요.'
          : '카카오 로그인 키가 없습니다. .env에 KAKAO_REST_API_KEY를 넣은 뒤 서버를 다시 실행해 주세요.';
    } else if (snsError === 'denied') {
      msg = `${label} 로그인을 취소했습니다.`;
    }
    toast(msg);
    const row = document.querySelector('.auth-sns__row');
    if (row && snsError === 'nokey') {
      const p = document.createElement('p');
      p.className = 'auth-sns-error';
      p.textContent = msg;
      row.insertAdjacentElement('afterend', p);
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-auth-help]')) {
      toast('아이디는 가입한 이메일입니다. 비밀번호는 6자 이상이어야 합니다.');
    }
    const snsBtn = event.target.closest('a.sns-btn, a[href*="/api/auth/kakao"], a[href*="/api/auth/naver"]');
    if (snsBtn && typeof Cloud !== 'undefined' && Cloud.isPages()) {
      event.preventDefault();
      toast('GitHub Pages에서는 이메일로 로그인·가입해 주세요.');
    }
  });

  function bindSubmit(form, submitBtn, handler) {
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.busy === '1') return;
      form.dataset.busy = '1';
      if (submitBtn) submitBtn.disabled = true;
      try {
        await handler();
      } finally {
        form.dataset.busy = '';
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  const loginForm = $('#loginForm');
  if (loginForm) {
    bindSubmit(loginForm, loginForm.querySelector('.auth-login-btn'), async () => {
      const email = $('#loginEmail').value.trim();
      const password = $('#loginPassword').value;
      if (!email || !email.includes('@')) {
        toast('아이디는 이메일 주소로 입력해 주세요.');
        return;
      }
      if (!password) {
        toast('비밀번호를 입력해 주세요.');
        return;
      }
      if (password.length < 6) {
        toast('비밀번호는 6자 이상이어야 합니다.');
        return;
      }
      try {
        await AppApi.post('/api/auth/login', { email, password });
        toast('로그인했습니다.');
        location.href = safeNext();
      } catch (err) {
        toast(err.message || '로그인에 실패했습니다.');
      }
    });
  }

  const signupForm = $('#signupForm');
  if (signupForm) {
    bindSubmit(signupForm, signupForm.querySelector('.auth-login-btn'), async () => {
      const name = $('#signupName').value.trim();
      const email = $('#signupEmail').value.trim();
      const password = $('#signupPassword').value;
      const again = $('#signupPasswordAgain').value;

      if (!name) {
        toast('이름을 입력해 주세요.');
        return;
      }
      if (!email || !email.includes('@')) {
        toast('아이디는 이메일 주소로 입력해 주세요.');
        return;
      }
      if (password.length < 6) {
        toast('비밀번호는 6자 이상이어야 합니다.');
        return;
      }
      if (password !== again) {
        toast('비밀번호가 서로 다릅니다.');
        return;
      }

      try {
        const data = await AppApi.post('/api/auth/signup', { name, email, password });
        if (data && data.user) {
          toast('회원가입이 완료되었습니다.');
          location.href = safeNext();
          return;
        }
        toast((data && data.message) || '가입 확인 메일을 확인해 주세요.');
        location.href = 'login.html';
      } catch (err) {
        toast(err.message || '회원가입에 실패했습니다.');
      }
    });
  }

  function showFindResult(message, empty) {
    const box = $('#findResult');
    if (!box) return;
    box.hidden = !message;
    box.textContent = message || '';
    box.classList.toggle('is-empty', !!empty);
  }

  function setFindTab(tab) {
    const idOn = tab === 'id';
    document.querySelectorAll('[data-find-tab]').forEach((btn) => {
      const on = btn.dataset.findTab === tab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    const idForm = $('#findIdForm');
    const pwForm = $('#findPasswordForm');
    if (idForm) idForm.hidden = !idOn;
    if (pwForm) pwForm.hidden = idOn;
    showFindResult('', false);
  }

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-find-tab]');
    if (tab) setFindTab(tab.dataset.findTab);
  });

  const findIdForm = $('#findIdForm');
  if (findIdForm) {
    bindSubmit(findIdForm, findIdForm.querySelector('.auth-login-btn'), async () => {
      const name = $('#findName').value.trim();
      const email = $('#findIdEmail').value.trim();
      if (!name && !email) {
        toast('이름 또는 이메일을 입력해 주세요.');
        return;
      }
      if (email && !email.includes('@')) {
        toast('올바른 이메일을 입력해 주세요.');
        return;
      }
      try {
        const data = await AppApi.post('/api/auth/find-id', { name, email });
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        if (!accounts.length) {
          showFindResult('일치하는 계정을 찾지 못했습니다. 이름 또는 이메일을 다시 확인해 주세요.', true);
          return;
        }
        const emails = accounts.map((item) => (typeof item === 'string' ? item : item.email)).filter(Boolean);
        showFindResult(`아이디(이메일): ${emails.join(', ')}`, false);
        toast('아이디를 찾았습니다.');
      } catch (err) {
        showFindResult(err.message || '아이디를 찾지 못했습니다.', true);
      }
    });
  }

  const findPasswordForm = $('#findPasswordForm');
  if (findPasswordForm) {
    bindSubmit(findPasswordForm, findPasswordForm.querySelector('.auth-login-btn'), async () => {
      const email = $('#findPasswordEmail').value.trim();
      if (!email || !email.includes('@')) {
        toast('가입한 이메일을 입력해 주세요.');
        return;
      }
      try {
        const data = await AppApi.post('/api/auth/reset-password', { email });
        showFindResult(data.message || '가입된 이메일이면 비밀번호 재설정 메일을 보냈습니다.', false);
        toast('재설정 메일을 보냈습니다. 메일함을 확인해 주세요.');
      } catch (err) {
        showFindResult(err.message || '메일을 보내지 못했습니다.', true);
      }
    });
  }

  function recoveryTokens() {
    const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const query = new URLSearchParams(location.search);
    return {
      type: hash.get('type') || query.get('type') || '',
      accessToken: hash.get('access_token') || '',
      refreshToken: hash.get('refresh_token') || '',
      code: query.get('code') || '',
    };
  }

  const resetForm = $('#resetForm');
  if (resetForm) {
    const tokens = recoveryTokens();
    if (!tokens.accessToken && !tokens.code) {
      const lead = $('#resetLead');
      if (lead) lead.textContent = '비밀번호 찾기에서 재설정 메일을 받은 뒤, 메일 속 링크로 들어와 주세요.';
    }
    bindSubmit(resetForm, resetForm.querySelector('.auth-login-btn'), async () => {
      const password = $('#resetPassword').value;
      const again = $('#resetPasswordAgain').value;
      if (password.length < 6) {
        toast('비밀번호는 6자 이상이어야 합니다.');
        return;
      }
      if (password !== again) {
        toast('비밀번호가 서로 다릅니다.');
        return;
      }
      const next = recoveryTokens();
      if (!next.accessToken && !next.code) {
        toast('유효한 재설정 링크가 아닙니다. 비밀번호 찾기에서 메일을 다시 받아 주세요.');
        return;
      }
      try {
        await AppApi.post('/api/auth/recover-password', {
          password,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          code: next.code,
        });
        toast('비밀번호를 바꿨습니다. 로그인해 주세요.');
        location.href = 'login.html';
      } catch (err) {
        toast(err.message || '비밀번호를 바꾸지 못했습니다.');
      }
    });
  }
})();
