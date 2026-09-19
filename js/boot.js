/* file:// 로 열어도 화면은 보이게 두고,
   로컬 서버가 켜지는 즉시 http://127.0.0.1:5501 으로 옮깁니다. */
(() => {
  'use strict';
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

  /* 서버가 아직 뜨지 않았으면 조용히 계속 기다렸다가 켜지는 순간 자동 이동 */
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
