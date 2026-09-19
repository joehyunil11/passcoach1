/* 나의 학습 현황: 총 풀이 · 정답률 · 학습일 · 연속 학습 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  Shell.init({ activeNav: 'score' });
  Shell.requireFeature('record');

  async function boot() {
    await StudyLog.ready();
    const stats = StudyLog.overview();
    const countText = `${stats.attempted.toLocaleString('ko-KR')}문제`;

    $('#statSolved').textContent = countText;
    $('#statRate').textContent = stats.attempted ? `${stats.rate}%` : '0%';
    $('#statDays').textContent = `${stats.studyDays}일`;
    $('#statStreak').textContent = `${stats.streak}일`;

    const deltaEl = $('#statDelta');
    const rateIcon = $('#statRateIcon');
    if (stats.delta !== null && stats.delta !== 0) {
      const up = stats.delta > 0;
      deltaEl.hidden = false;
      rateIcon.hidden = true;
      deltaEl.classList.toggle('is-up', up);
      deltaEl.classList.toggle('is-down', !up);
      $('#statDeltaText').textContent = `${up ? '+' : ''}${stats.delta}%`;
    }
  }

  boot();
})();
