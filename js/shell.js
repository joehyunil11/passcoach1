/* 모든 페이지가 공유하는 셸: 토스트 · 사이드바 메뉴 렌더링 · 모바일 드로어 */

const Shell = (() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let bound = false;
  let navigating = false;
  let currentUser = null;
  let sessionReady = null;
  let entitlementsReady = null;
  let entitlements = {
    plan: 'premium',
    features: { review: true, record: true, grades: true, weakness: true, similar: true, teacher: true },
    questions: { limit: null, usedPeriod: 0, remaining: null, unlimited: true, periodLabel: '오늘', plan: 'premium' },
    ai: { limit: 1000, usedPeriod: 0, remaining: 1000, periodLabel: '이번 달', plan: 'premium' },
  };

  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  /* ── 토스트 ─────────────────────────────── */
  let toastTimer;
  function showToast(message, durationMs) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), durationMs || 2000);
  }

  function openLegalDialog() {
    const dialog = $('#legalDialog');
    if (!dialog) {
      showToast('이용약관을 불러오지 못했습니다.');
      return;
    }
    dialog.hidden = false;
    document.body.classList.add('is-legal-open');
    const closeBtn = $('#legalDialogClose');
    if (closeBtn) closeBtn.focus();
  }

  function closeLegalDialog() {
    const dialog = $('#legalDialog');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove('is-legal-open');
    const opener = document.querySelector('[data-action="이용약관"]');
    if (opener) opener.focus();
  }

  /* ── 모바일 드로어 ──────────────────────── */
  const isNarrow = () => window.matchMedia('(max-width: 860px)').matches;

  function setSidebar(open) {
    const sidebar = $('#sidebar');
    const scrim = $('#scrim');
    const toggleBtn = $('#sidebarToggle');
    if (!sidebar) return;

    sidebar.classList.toggle('is-open', open);
    if (scrim) scrim.hidden = !open;
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', String(open));
      toggleBtn.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
    }
  }

  function resolveActive(preferred) {
    return preferred || document.body.dataset.activeNav || 'home';
  }

  function setActive(activeId) {
    if (!activeId) return;
    if (document.body) document.body.dataset.activeNav = activeId;
    document.querySelectorAll('[data-nav]').forEach((el) => {
      const on = el.dataset.nav === activeId;
      if (el.classList.contains('is-active') === on) return;
      el.classList.toggle('is-active', on);
    });
  }

  function itemMarkup(item, current) {
    const active = item.id === current ? ' is-active' : '';
    const locked = item.feature && !canFeature(item.feature) ? ' is-locked' : '';
    const featureAttr = item.feature ? ` data-feature="${escapeHtml(item.feature)}"` : '';
    const icon = `<svg class="nav__icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[item.icon] || ''}</svg>`;
    const label = `<span>${escapeHtml(item.label)}</span>`;
    if (item.href) {
      return `<li>
        <a class="nav__link${active}${locked}" href="${escapeHtml(item.href)}" data-nav="${item.id}"${featureAttr}>
          ${icon}${label}
        </a>
      </li>`;
    }
    return `<li>
      <button class="nav__link${active}${locked}" type="button" data-nav="${item.id}"${featureAttr}>
        ${icon}${label}
      </button>
    </li>`;
  }

  /* 파서 단계에서 document.write 로 넣어 첫 페인트부터 선택 상태가 맞다 */
  function navMarkup(activeId) {
    const current = resolveActive(activeId);
    const blocks = ['navPrimary', 'navSecondary', 'navAccount'].map((listId) => {
      const items = NAV_GROUPS[listId] || [];
      return `<ul class="nav__list" id="${listId}">${items.map((item) => itemMarkup(item, current)).join('')}</ul>`;
    });
    return `${blocks[0]}<hr class="nav__divider" />${blocks[1]}<hr class="nav__divider" />${blocks[2]}`;
  }

  /* ── 사이드바 메뉴 ──────────────────────── */
  function renderNav(activeId) {
    const current = resolveActive(activeId);
    Object.entries(NAV_GROUPS).forEach(([listId, items]) => {
      const list = document.getElementById(listId);
      if (!list) return;
      list.innerHTML = items.map((item) => itemMarkup(item, current)).join('');
    });
  }

  function findNavItem(id) {
    return Object.values(NAV_GROUPS).flat().find((item) => item.id === id);
  }

  function currentPageName() {
    return location.pathname.split(/[/\\]/).pop() || 'index.html';
  }

  const AUTH_PAGES = {
    'login.html': true,
    'signup.html': true,
    'find-account.html': true,
    'reset-password.html': true,
  };

  function isAuthPage() {
    return Boolean(AUTH_PAGES[currentPageName()]);
  }

  function isHomePage() {
    const page = currentPageName();
    return page === 'index.html' || page === '' || page === '/';
  }

  const LOGIN_MESSAGE = '로그인 후 이용하세요';

  function notifyLoginRequired() {
    const run = () => showToast(LOGIN_MESSAGE, 2800);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  }

  function ensureTopbarAuth() {
    let wrap = $('#topbarAuth');
    if (wrap) return wrap;
    const topbar = document.querySelector('.topbar');
    if (!topbar || isAuthPage()) return null;
    wrap = document.createElement('div');
    wrap.className = 'topbar__auth';
    wrap.id = 'topbarAuth';
    const icon = topbar.querySelector('.topbar__icon');
    if (icon) topbar.insertBefore(wrap, icon);
    else topbar.appendChild(wrap);
    return wrap;
  }

  function renderTopbarAuth(user) {
    const wrap = ensureTopbarAuth();
    if (!wrap) return;
    wrap.hidden = false;
    if (user) {
      wrap.innerHTML = `
        <span class="topbar__user" title="${escapeHtml(user.email || '')}">${escapeHtml(user.name || '회원')}</span>
        <button class="topbar__btn topbar__btn--ghost" type="button" data-logout="true">로그아웃</button>`;
      return;
    }
    if (isAuthPage()) return;
    wrap.innerHTML = `
      <a class="topbar__btn topbar__btn--ghost" href="login.html">로그인</a>
      <a class="topbar__btn topbar__btn--primary" href="signup.html">회원가입</a>`;
  }

  function loadSession() {
    if (sessionReady) return sessionReady;
    sessionReady = fetch('/api/session', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        currentUser = (data && data.user) || null;
        renderTopbarAuth(currentUser);
        return currentUser;
      })
      .catch(() => {
        currentUser = null;
        renderTopbarAuth(null);
        return null;
      });
    return sessionReady;
  }

  function requireLogin() {
    if (isAuthPage()) return Promise.resolve(null);
    return loadSession().then((user) => {
      if (user) return user;
      if (isHomePage()) {
        if (new URLSearchParams(location.search).get('needLogin')) {
          notifyLoginRequired();
          history.replaceState({}, '', 'index.html');
        }
        return null;
      }
      location.replace('index.html?needLogin=1');
      return null;
    });
  }

  function ensureUser() {
    return loadSession().then((user) => {
      if (user) return true;
      notifyLoginRequired();
      return false;
    });
  }

  function getUser() {
    return currentUser;
  }

  async function logoutAndLeave() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    location.replace('index.html');
  }

  function goTo(href) {
    if (navigating) return;
    navigating = true;
    /* 선택 스타일이 먼저 그려진 뒤 이동해 전환 중 깜빡임을 없앤다 */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        location.assign(href);
      });
    });
  }

  function prefetch(href) {
    try {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      link.as = 'document';
      document.head.appendChild(link);
    } catch (_) {
      /* ignore */
    }
  }

  function canFeature(name) {
    if (!name) return true;
    const gated = { review: true, record: true, grades: true, weakness: true, similar: true };
    if (!gated[name]) return true;
    return !!(entitlements.features && entitlements.features[name]);
  }

  function canAnswerQuestion() {
    const quota = entitlements.questions || {};
    if (quota.unlimited || quota.limit == null) return true;
    return Number(quota.remaining) > 0;
  }

  function upgradeMessage(feature) {
    if (feature === 'weakness' || feature === 'similar') return '프리미엄 이용권에서 이용할 수 있습니다.';
    if (feature === 'review' || feature === 'record' || feature === 'grades') {
      return '베이직 이용권 이상에서 이용할 수 있습니다.';
    }
    return '이용권을 확인해 주세요.';
  }

  function questionLimitMessage() {
    const quota = entitlements.questions || {};
    const plan = entitlements.plan || 'free';
    if (plan === 'basic') return `베이직 이용권은 하루 ${quota.limit || 80}문제까지 풀 수 있습니다. 이용권을 확인해 주세요.`;
    if (plan === 'premium') return '오늘의 문제 이용 횟수를 모두 사용했습니다.';
    return `무료 이용권은 하루 ${quota.limit || 5}문제까지 풀 수 있습니다. 이용권을 확인해 주세요.`;
  }

  function applyEntitlementsNav() {
    document.querySelectorAll('[data-nav]').forEach((el) => {
      const item = findNavItem(el.dataset.nav);
      const locked = !!(item && item.feature && !canFeature(item.feature));
      el.classList.toggle('is-locked', locked);
      if (locked) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
    document.querySelectorAll('[data-feature]').forEach((el) => {
      const locked = !canFeature(el.dataset.feature);
      el.classList.toggle('is-locked', locked);
    });
  }

  function mergeEntitlements(data) {
    if (!data || typeof data !== 'object') return entitlements;
    entitlements = {
      plan: data.plan || entitlements.plan,
      features: { ...entitlements.features, ...(data.features || {}) },
      questions: { ...entitlements.questions, ...(data.questions || {}) },
      ai: { ...entitlements.ai, ...(data.ai || {}) },
    };
    applyEntitlementsNav();
    return entitlements;
  }

  function setQuestionUsage(usage) {
    if (!usage || typeof usage !== 'object') return entitlements;
    entitlements.questions = { ...entitlements.questions, ...usage };
    return entitlements;
  }

  function loadEntitlements() {
    if (entitlementsReady) return entitlementsReady;
    entitlementsReady = fetch('/api/entitlements', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => mergeEntitlements(data))
      .catch(() => entitlements);
    return entitlementsReady;
  }

  function getEntitlements() {
    return entitlements;
  }

  function requireFeature(name) {
    return ensureUser().then((ok) => {
      if (!ok) return false;
      return loadEntitlements().then(() => {
        if (canFeature(name)) return true;
        showToast(upgradeMessage(name));
        location.href = 'billing.html';
        return false;
      });
    });
  }

  function goFeature(item) {
    if (!item || !item.href) return;
    if (!item.feature) {
      goTo(item.href);
      return;
    }
    loadEntitlements().then(() => {
      if (!canFeature(item.feature)) {
        showToast(upgradeMessage(item.feature));
        goTo('billing.html');
        return;
      }
      goTo(item.href);
    });
  }

  /* 사이드바 직후 호출 */
  function boot(activeNav) {
    if (!$('#navPrimary')) {
      /* document.write 전에 호출된 경우 대비 — 보통 navMarkup가 먼저 실행됨 */
      return;
    }
    const current = resolveActive(activeNav);
    if (!$('#navPrimary').children.length) renderNav(current);
    else setActive(current);
    bindChrome();
    requireLogin().then((user) => {
      if (isAuthPage()) return;
      if (!user && !isHomePage()) return;
      loadEntitlements();
    });
  }

  function bindChrome() {
    if (bound) return;
    bound = true;

    const toggleBtn = $('#sidebarToggle');
    const scrim = $('#scrim');
    if (toggleBtn) toggleBtn.addEventListener('click', () => setSidebar(!$('#sidebar').classList.contains('is-open')));
    if (scrim) scrim.addEventListener('click', () => setSidebar(false));

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.button != null && event.button !== 0) return;
        const navBtn = event.target.closest('a[data-nav], button[data-nav]');
        if (!navBtn) return;
        const item = findNavItem(navBtn.dataset.nav);
        if (!item || !item.href) return;
        if (!currentUser && item.id !== 'home') return;
        setActive(item.id);
        const target = item.href.split('?')[0];
        if (currentPageName() !== target || location.search) prefetch(item.href);
      },
      true
    );

    document.addEventListener('click', (event) => {
      const navBtn = event.target.closest('[data-nav]');
      if (navBtn) {
        const item = findNavItem(navBtn.dataset.nav);
        if (isNarrow()) setSidebar(false);
        event.preventDefault();
        if (item && item.id === 'home' && item.href) {
          if (isHomePage() && !location.search) return;
          goTo(item.href);
          return;
        }
        ensureUser().then((ok) => {
          if (!ok) return;
          if (item && item.href) {
            setActive(item.id);
            const target = item.href.split('?')[0];
            if (currentPageName() === target && !location.search && (!item.feature || canFeature(item.feature))) return;
            goFeature(item);
            return;
          }
          showToast(`${item ? item.label : '해당'} 화면은 준비 중입니다.`);
        });
        return;
      }

      const link = event.target.closest('a[href]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const file = href.split(/[?#]/)[0].split('/').pop();
        const locked = {
          'quiz.html': true,
          'review.html': true,
          'record.html': true,
          'grades.html': true,
          'weakness.html': true,
          'teacher.html': true,
          'billing.html': true,
          'account.html': true,
        };
        if (locked[file]) {
          event.preventDefault();
          ensureUser().then((ok) => {
            if (ok) location.href = href;
          });
          return;
        }
      }

      const logoutBtn = event.target.closest('[data-logout]');
      if (logoutBtn) {
        event.preventDefault();
        logoutAndLeave();
        return;
      }

      const action = event.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === '이용약관') {
        event.preventDefault();
        openLegalDialog();
        return;
      }
      if (action.dataset.action === '로그아웃') {
        event.preventDefault();
        logoutAndLeave();
        return;
      }
      if (action.dataset.action === '개인정보처리방침' || action.dataset.action === '고객센터') {
        showToast(`${action.dataset.action} 기능은 준비 중입니다.`);
        return;
      }
      event.preventDefault();
      ensureUser().then((ok) => {
        if (ok) showToast(`${action.dataset.action} 기능은 준비 중입니다.`);
      });
    });

    document.addEventListener('click', (event) => {
      const legal = $('#legalDialog');
      if (!legal || legal.hidden) return;
      if (event.target === legal || event.target.closest('#legalDialogClose')) closeLegalDialog();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const legalOpen = $('#legalDialog') && !$('#legalDialog').hidden;
      if (legalOpen) {
        closeLegalDialog();
        return;
      }
      setSidebar(false);
    });

    window.addEventListener('pageshow', (event) => {
      navigating = false;
      if (event.persisted && !isAuthPage()) requireLogin();
      if (!$('#navPrimary')?.children.length) return;
      const current = resolveActive(document.body.dataset.activeNav);
      setActive(current);
      if (event.persisted) setActive(current);
    });
  }

  function init({ activeNav } = {}) {
    const current = resolveActive(activeNav);
    if (!$('#navPrimary')?.children.length) renderNav(current);
    else setActive(current);
    bindChrome();
    requireLogin().then((user) => {
      if (isAuthPage()) return;
      if (!user && !isHomePage()) return;
      loadEntitlements();
    });
  }

  return {
    init,
    boot,
    navMarkup,
    showToast,
    escapeHtml,
    setSidebar,
    setActive,
    canFeature,
    canAnswerQuestion,
    upgradeMessage,
    questionLimitMessage,
    loadEntitlements,
    getEntitlements,
    setQuestionUsage,
    requireFeature,
    ensureUser,
    getUser,
  };
})();
