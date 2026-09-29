/* XSS 방어 헬퍼 + file:// 에서 로컬 서버로 이동 */

(() => {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function stripTags(str) {
    return String(str == null ? '' : str)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/vbscript\s*:/gi, '')
      .replace(/on[a-z]+\s*=/gi, '');
  }

  function isDangerousUrl(value) {
    const lower = String(value || '').trim().toLowerCase();
    return (
      lower.startsWith('javascript:') ||
      lower.startsWith('vbscript:') ||
      lower.startsWith('data:') ||
      lower.startsWith('file:') ||
      lower.startsWith('//')
    );
  }

  function safeHref(value) {
    const s = String(value || '').trim();
    if (!s || isDangerousUrl(s)) return '';
    if (s.startsWith('#') || s.startsWith('?')) return s;
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    if (/^[a-z0-9][a-z0-9._\-]*\.html(?:[?#].*)?$/i.test(s)) return s;
    try {
      const u = new URL(s, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === location.origin) return s;
    } catch (_) {
      /* ignore */
    }
    return '';
  }

  function safeImageUrl(value) {
    const s = String(value || '').trim();
    if (!s || isDangerousUrl(s)) return '';
    if (s.startsWith('/api/question-image?')) return s;
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
      const u = new URL(s, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      const host = u.hostname.toLowerCase();
      if (host === location.hostname || host === '127.0.0.1' || host === 'localhost' || host.endsWith('.supabase.co')) {
        return s;
      }
    } catch (_) {
      /* ignore */
    }
    return '';
  }

  window.PasscoachXss = { escapeHtml, stripTags, safeHref, safeImageUrl };

  window.PasscoachConfig = { freePeriod: false, aiLimit: 100, aiLabel: '무료 이용기간' };

  if (location.protocol !== 'file:') return;

  const file = decodeURIComponent((location.pathname.split(/[/\\]/).pop() || 'index.html'));
  const next = `http://127.0.0.1:5501/${file}${location.search}${location.hash}`;
  const health = 'http://127.0.0.1:5501/api/health';
  const RETRY_MS = 1000;

  let moving = false;

  function goHttp() {
    if (moving) return;
    moving = true;
    try {
      if (window.top && window.top !== window) {
        window.top.location.replace(next);
        return;
      }
    } catch (_) {
      /* iframe에서 top 이동이 막히면 현재 창으로 이동 */
    }
    location.replace(next);
  }

  function probe() {
    if (moving) return;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), 1500);

    fetch(health, { method: 'GET', mode: 'cors', cache: 'no-store', signal: ctrl && ctrl.signal })
      .then((res) => {
        clearTimeout(timer);
        if (res.ok) goHttp();
        else setTimeout(probe, RETRY_MS);
      })
      .catch(() => {
        clearTimeout(timer);
        setTimeout(probe, RETRY_MS);
      });
  }

  probe();
})();
