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

  const GUEST_PAGES = {
    'index.html': true,
    '': true,
    'login.html': true,
    'signup.html': true,
    'find-account.html': true,
    'reset-password.html': true,
    'quiz.html': true,
  };

  function pageNeedsLogin(href) {
    const file = String(href || '').split(/[?#]/)[0].split('/').pop() || 'index.html';
    return !GUEST_PAGES[file];
  }

  const escapeHtml = (str) =>
    window.PasscoachXss && PasscoachXss.escapeHtml
      ? PasscoachXss.escapeHtml(str)
      : String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[ch]));

  const safeHref = (value) =>
    window.PasscoachXss && PasscoachXss.safeHref ? PasscoachXss.safeHref(value) : String(value || '');

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

  function ensureLegalDialog() {
    let dialog = $('#legalDialog');
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.id = 'legalDialog';
    dialog.className = 'legal';
    dialog.hidden = true;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'legalTitle');
    dialog.innerHTML = `
      <div class="legal__panel">
        <div class="legal__head">
          <h2 class="legal__title" id="legalTitle">안내</h2>
          <button class="legal__close" type="button" id="legalDialogClose" aria-label="닫기">×</button>
        </div>
        <div class="legal__body" id="legalBody"></div>
      </div>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function renderLegalMarkup(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const html = [];
    let inList = false;
    const closeList = () => {
      if (!inList) return;
      html.push('</ul>');
      inList = false;
    };
    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) {
        closeList();
        return;
      }
      if (line.startsWith('## ')) {
        closeList();
        html.push(`<h3>${escapeHtml(line.slice(3).trim())}</h3>`);
        return;
      }
      if (line.startsWith('- ')) {
        if (!inList) {
          html.push('<ul>');
          inList = true;
        }
        html.push(`<li>${escapeHtml(line.slice(2).trim())}</li>`);
        return;
      }
      closeList();
      const date = /^시행일/.test(line);
      html.push(`<p${date ? ' class="legal__date"' : ''}>${escapeHtml(line)}</p>`);
    });
    closeList();
    return html.join('');
  }

  const LEGAL_ACTIONS = {
    이용약관: 'terms',
    개인정보처리방침: 'privacy',
    고객센터: 'support',
  };
  const legalCache = {};
  let legalOpener = null;

  function closeLegalDialog() {
    const dialog = $('#legalDialog');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove('is-legal-open');
    if (legalOpener && typeof legalOpener.focus === 'function') legalOpener.focus();
    legalOpener = null;
  }

  async function openLegalDialog(slug, opener) {
    const key = String(slug || 'terms').toLowerCase();
    const dialog = ensureLegalDialog();
    const titleEl = $('#legalTitle');
    const bodyEl = $('#legalBody') || dialog.querySelector('.legal__body');
    const closeBtn = $('#legalDialogClose');
    legalOpener = opener || null;
    if (titleEl) titleEl.textContent = opener && opener.dataset.action ? opener.dataset.action : '안내';
    if (closeBtn) closeBtn.setAttribute('aria-label', `${titleEl ? titleEl.textContent : '안내'} 닫기`);
    if (bodyEl) bodyEl.innerHTML = '<p class="legal__lead">불러오는 중입니다...</p>';
    dialog.hidden = false;
    document.body.classList.add('is-legal-open');
    if (closeBtn) closeBtn.focus();
    try {
      if (!legalCache[key]) {
        const data = await apiRequest(`/api/legal/${encodeURIComponent(key)}`);
        legalCache[key] = data && data.page;
      }
      const page = legalCache[key];
      if (!page) throw new Error('항목을 찾을 수 없습니다.');
      if (titleEl) titleEl.textContent = page.title || '안내';
      if (closeBtn) closeBtn.setAttribute('aria-label', `${page.title || '안내'} 닫기`);
      const lead = page.lead ? `<p class="legal__lead">${escapeHtml(page.lead)}</p>` : '';
      if (bodyEl) bodyEl.innerHTML = lead + renderLegalMarkup(page.content);
    } catch (err) {
      if (bodyEl) {
        bodyEl.innerHTML = `<p class="legal__lead">${escapeHtml(err.message || '내용을 불러오지 못했습니다.')}</p>`;
      } else {
        showToast(err.message || '내용을 불러오지 못했습니다.');
      }
    }
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
    const locked = itemLocked(item) ? ' is-locked' : '';
    const featureAttr = item.feature ? ` data-feature="${escapeHtml(item.feature)}"` : '';
    const icon = `<svg class="nav__icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[item.icon] || ''}</svg>`;
    const label = `<span>${escapeHtml(item.label)}</span>`;
    if (item.href) {
      const href = escapeHtml(safeHref(item.href) || '#');
      return `<li>
        <a class="nav__link${active}${locked}" href="${href}" data-nav="${item.id}"${featureAttr}>
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

  const LOGIN_MESSAGE = '로그인 후 전 메뉴 이용 가능';

  function notifyLoginRequired() {
    const run = () => showToast(LOGIN_MESSAGE, 3600);
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

  function apiRequest(path, options = {}) {
    if (typeof Cloud !== 'undefined' && Cloud.isPages()) return Cloud.request(path, options);
    if (typeof AppApi !== 'undefined') {
      const method = String(options.method || 'GET').toUpperCase();
      if (method === 'GET') return AppApi.get(path);
      if (method === 'POST') return AppApi.post(path, options.body ? JSON.parse(options.body) : {});
      if (method === 'PUT') return AppApi.put(path, options.body ? JSON.parse(options.body) : {});
    }
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { status: res.status });
      return data;
    });
  }

  function loadSession() {
    if (sessionReady) return sessionReady;
    sessionReady = apiRequest('/api/session')
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
        notifyLoginRequired();
        if (new URLSearchParams(location.search).get('needLogin')) {
          history.replaceState({}, '', 'index.html');
        }
        return null;
      }
      if (!pageNeedsLogin(currentPageName())) return null;
      location.replace('index.html?needLogin=1');
      return null;
    });
  }

  function ensureUser(href) {
    return loadSession().then((user) => {
      if (user) return true;
      if (href != null && !pageNeedsLogin(href)) return true;
      notifyLoginRequired();
      return false;
    });
  }

  function getUser() {
    return currentUser;
  }

  async function logoutAndLeave() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      /* ignore */
    }
    location.replace('index.html');
  }

  function goTo(href) {
    const safe = safeHref(href);
    if (!safe || navigating) return;
    navigating = true;
    /* 선택 스타일이 먼저 그려진 뒤 이동해 전환 중 깜빡임을 없앤다 */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        location.assign(safe);
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
    if (!currentUser) return false;
    const gated = { review: true, record: true, grades: true, weakness: true, similar: true, teacher: true };
    if (!gated[name]) return true;
    return !!(entitlements.features && entitlements.features[name]);
  }

  function itemLocked(item) {
    if (!item) return false;
    if (!currentUser && item.id !== 'home' && pageNeedsLogin(item.href)) return true;
    return !!(item.feature && !canFeature(item.feature));
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
      const locked = itemLocked(item);
      el.classList.toggle('is-locked', locked);
      if (locked) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
    document.querySelectorAll('[data-feature]').forEach((el) => {
      const locked = !currentUser || !canFeature(el.dataset.feature);
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
    entitlementsReady = apiRequest('/api/entitlements')
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

  const NOTICE_SEEN_KEY = 'passcoach.noticeSeen';
  let noticeCache = [];
  let noticeReady = null;

  function noticeUserKey() {
    if (!currentUser) return '';
    return String(currentUser.id || currentUser.email || '').toLowerCase();
  }

  function readNoticeSeen() {
    try {
      return JSON.parse(localStorage.getItem(NOTICE_SEEN_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function lastNoticeSeenAt() {
    const key = noticeUserKey();
    if (!key) return '';
    const row = readNoticeSeen()[key];
    if (typeof row === 'string') return row;
    return (row && row.seenAt) || '';
  }

  function markNoticesSeen(at) {
    const key = noticeUserKey();
    if (!key) return;
    const all = readNoticeSeen();
    all[key] = { seenAt: at || new Date().toISOString() };
    try {
      localStorage.setItem(NOTICE_SEEN_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
    updateNoticeBadge(unreadNotices(noticeCache).length);
  }

  function noticeTime(item) {
    return Date.parse(item && (item.updated_at || item.created_at)) || 0;
  }

  function unreadNotices(list) {
    const seen = Date.parse(lastNoticeSeenAt()) || 0;
    return (list || []).filter((item) => noticeTime(item) > seen);
  }

  function formatNoticeDate(iso) {
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
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    }
  }

  function updateNoticeBadge(count) {
    const n = Number(count) || 0;
    document.querySelectorAll('.topbar__badge').forEach((badge) => {
      if (n <= 0) {
        badge.hidden = true;
        badge.textContent = '';
        return;
      }
      badge.hidden = false;
      badge.textContent = n > 9 ? '9+' : String(n);
    });
    document.querySelectorAll('[data-action="알림"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', String(Boolean($('#noticePop') && !$('#noticePop').hidden)));
      btn.setAttribute('aria-label', n > 0 ? `알림, 새 공지 ${n}건` : '알림');
    });
  }

  function ensureNoticePop() {
    let pop = $('#noticePop');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'noticePop';
    pop.className = 'notice-pop';
    pop.hidden = true;
    pop.innerHTML = `
      <div class="notice-pop__head">
        <strong>새 공지사항</strong>
        <button class="notice-pop__all" type="button" data-notice-all="true">모두 보기</button>
      </div>
      <ul class="notice-pop__list"></ul>`;
    document.body.appendChild(pop);
    return pop;
  }

  function positionNoticePop() {
    const pop = $('#noticePop');
    const bell = document.querySelector('[data-action="알림"]');
    if (!pop || !bell) return;
    const rect = bell.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    let left = rect.right - width;
    if (left < 12) left = 12;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - 12 - width);
    pop.style.top = `${Math.round(rect.bottom + 8)}px`;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.right = 'auto';
    pop.style.width = `${Math.round(width)}px`;
  }

  function renderNoticePopList() {
    const pop = ensureNoticePop();
    const list = pop.querySelector('.notice-pop__list');
    if (!list) return;
    const items = noticeCache.slice(0, 8);
    const unread = new Set(unreadNotices(noticeCache).map((item) => String(item.id)));
    if (!items.length) {
      list.innerHTML = '<li class="notice-pop__empty">등록된 공지사항이 없습니다.</li>';
      return;
    }
    list.innerHTML = items
      .map((item) => {
        const fresh = unread.has(String(item.id));
        return `<li>
          <button class="notice-pop__item" type="button" data-notice-id="${escapeHtml(String(item.id))}">
            <span class="notice-pop__dot${fresh ? '' : ' is-off'}" aria-hidden="true"></span>
            <span class="notice-pop__copy">
              <span class="notice-pop__title">${escapeHtml(item.title || '공지')}</span>
              <span class="notice-pop__meta">${escapeHtml(formatNoticeDate(item.created_at))}${fresh ? ' · 새 글' : ''}</span>
            </span>
          </button>
        </li>`;
      })
      .join('');
  }

  function closeNoticePop() {
    const pop = $('#noticePop');
    if (pop) pop.hidden = true;
    document.querySelectorAll('[data-action="알림"]').forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
  }

  function openNoticePop() {
    renderNoticePopList();
    const pop = ensureNoticePop();
    pop.hidden = false;
    positionNoticePop();
    document.querySelectorAll('[data-action="알림"]').forEach((btn) => btn.setAttribute('aria-expanded', 'true'));
    markNoticesSeen();
  }

  function toggleNoticePop() {
    const pop = ensureNoticePop();
    if (pop.hidden) openNoticePop();
    else closeNoticePop();
  }

  function loadNoticeAlerts() {
    if (noticeReady) return noticeReady;
    if (!currentUser || isAuthPage()) {
      updateNoticeBadge(0);
      return Promise.resolve();
    }
    noticeReady = apiRequest('/api/notices')
      .then((data) => {
        noticeCache = Array.isArray(data && data.notices) ? data.notices : [];
        if (currentPageName() === 'notice.html') markNoticesSeen();
        else updateNoticeBadge(unreadNotices(noticeCache).length);
      })
      .catch(() => {
        noticeCache = [];
        updateNoticeBadge(0);
      });
    return noticeReady;
  }

  function syncGuestHint() {
    const hint = $('#guestMenuHint');
    if (hint) hint.remove();
  }

  function afterSession(user) {
    applyEntitlementsNav();
    syncGuestHint();
    if (isAuthPage()) return;
    if (!user && !isHomePage() && pageNeedsLogin(currentPageName())) return;
    loadEntitlements();
    if (user) loadNoticeAlerts();
    document.dispatchEvent(new CustomEvent('passcoach:session', { detail: { user: user || null } }));
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
    requireLogin().then(afterSession);
  }

  function bindChrome() {
    if (bound) return;
    bound = true;
    updateNoticeBadge(0);

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
        if (!currentUser && item.id !== 'home' && pageNeedsLogin(item.href)) return;
        setActive(item.id);
        const target = item.href.split('?')[0];
        if (currentPageName() !== target || location.search) prefetch(item.href);
      },
      true
    );

    document.addEventListener('click', (event) => {
      const pop = $('#noticePop');
      const onBell = event.target.closest('[data-action="알림"]');
      const inPop = event.target.closest('#noticePop');
      if (pop && !pop.hidden && !onBell && !inPop) closeNoticePop();
      if (inPop) {
        const item = event.target.closest('[data-notice-id]');
        if (item) {
          event.preventDefault();
          closeNoticePop();
          ensureUser().then((ok) => {
            if (ok) goTo(`notice.html?id=${encodeURIComponent(item.dataset.noticeId)}`);
          });
          return;
        }
        if (event.target.closest('[data-notice-all]')) {
          event.preventDefault();
          closeNoticePop();
          ensureUser().then((ok) => {
            if (ok) goTo('notice.html');
          });
          return;
        }
      }

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
        ensureUser(item && item.href).then((ok) => {
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
          'review.html': true,
          'record.html': true,
          'grades.html': true,
          'weakness.html': true,
          'teacher.html': true,
          'billing.html': true,
          'account.html': true,
          'notice.html': true,
          'report.html': true,
        };
        if (locked[file]) {
          event.preventDefault();
          const dest = safeHref(href);
          if (!dest) return;
          ensureUser(dest).then((ok) => {
            if (ok) location.href = dest;
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
      if (action.dataset.action === '알림') {
        event.preventDefault();
        ensureUser().then((ok) => {
          if (!ok) return;
          const run = () => toggleNoticePop();
          if (noticeReady) noticeReady.then(run);
          else loadNoticeAlerts().then(run);
        });
        return;
      }
      if (LEGAL_ACTIONS[action.dataset.action]) {
        event.preventDefault();
        openLegalDialog(LEGAL_ACTIONS[action.dataset.action], action);
        return;
      }
      if (action.dataset.action === '로그아웃') {
        event.preventDefault();
        logoutAndLeave();
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
      if ($('#noticePop') && !$('#noticePop').hidden) {
        closeNoticePop();
        return;
      }
      setSidebar(false);
    });

    window.addEventListener('pageshow', (event) => {
      navigating = false;
      if (event.persisted && !isAuthPage()) requireLogin().then(afterSession);
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
    requireLogin().then(afterSession);
  }

  return {
    init,
    boot,
    navMarkup,
    showToast,
    escapeHtml,
    stripTags: (value) => (window.PasscoachXss && PasscoachXss.stripTags ? PasscoachXss.stripTags(value) : String(value || '')),
    safeHref,
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
    whenUser: loadSession,
    markNoticesSeen,
  };
})();
