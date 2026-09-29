/* 메인 홈 전용: 과목 카드 · 학습 도구 카드 렌더링과 이동 처리 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;
  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6.5l5.5 5.5L13 17.5"/></svg>';

  /* Supabase 행(code/name)을 홈 카드 형식으로 맞춘다. 로컬 SUBJECTS 메타를 우선 사용 */
  const LOCAL_BY_ID = Object.fromEntries(SUBJECTS.map((item) => [item.id, item]));

  function formatQuestionCount(n) {
    const count = Number(n);
    if (!Number.isFinite(count) || count < 0) return '총 —제';
    return `총 ${count.toLocaleString('ko-KR')}제`;
  }

  function mapSubjectRow(row, counts = {}) {
    const id = AppApi.resolveSubjectId(row) || String(row.code || row.name || '').trim() || `subject-${row.id}`;
    const local = LOCAL_BY_ID[id] || {};
    const questionCount = Number.isFinite(Number(row.questionCount))
      ? Number(row.questionCount)
      : Number.isFinite(Number(counts[id]))
        ? Number(counts[id])
        : null;
    return {
      id,
      title: local.title || row.name || row.code || id,
      cta: local.cta || `${String(local.title || row.name || '과목').replace(/^9급\s*/, '').replace(/능력검정시험$/, '')} 시험`,
      meta: questionCount != null ? formatQuestionCount(questionCount) : local.meta || '총 —제',
      emoji: local.emoji || '📘',
      quiz: local.href ? false : local.quiz !== undefined ? local.quiz : true,
      tags: local.tags || [],
      variant: local.variant,
      badge: local.badge,
      href: local.href,
      dbId: row.id,
      questionCount,
    };
  }

  let subjectCards = SUBJECTS.slice();

  function renderSubjects() {
    const grid = $('#subjectGrid');
    if (!grid) return;
    const guest = Shell.getUser && !Shell.getUser();
    grid.innerHTML = subjectCards
      .map(
        (item) => `
      <button class="card${item.variant === 'ai' ? ' card--ai' : ''}${guest && !item.quiz ? ' is-locked' : ''}" type="button" data-subject="${esc(item.id)}"${item.href && !item.quiz ? ' data-feature="teacher"' : ''}>
        ${item.badge ? `<em class="card__badge">${esc(item.badge)}</em>` : ''}
        <span class="card__title">${esc(item.title)}</span>
        <span class="card__cta">${esc(item.cta)}${ARROW}</span>
        <span class="card__foot">
          <span class="card__meta">${esc(item.meta)}</span>
          <span class="card__emoji" aria-hidden="true">${item.emoji}</span>
        </span>
      </button>`
      )
      .join('');
  }

  function renderFeatures() {
    const grid = $('#featureGrid');
    if (!grid) return;
    const guest = Shell.getUser && !Shell.getUser();
    grid.innerHTML = FEATURES
      .map(
        (item) => `
      <button class="feature${guest || (item.feature && !Shell.canFeature(item.feature)) ? ' is-locked' : ''}" type="button" style="--accent:${item.accent}" data-feature="${esc(item.feature || item.id)}">
        <span class="feature__title">${esc(item.title)}</span>
        <span class="feature__desc">${esc(item.desc)}</span>
        <span class="feature__cta">바로가기${ARROW}</span>
      </button>`
      )
      .join('');
  }

  async function loadSubjects() {
    try {
      const data = typeof AppApi !== 'undefined' ? await AppApi.get('/api/subjects') : await fetch('/api/subjects').then((r) => r.json());
      if (!Array.isArray(data.subjects) || !data.subjects.length) {
        await applyLocalQuestionCounts();
        return;
      }
      const extras = SUBJECTS.filter((item) => item.href && !data.subjects.some((row) => AppApi.resolveSubjectId(row) === item.id));
      const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
      subjectCards = data.subjects.map((row) => mapSubjectRow(row, counts)).concat(extras);
      subjectCards = subjectCards.map((item) => {
        if (!item.quiz || item.questionCount != null) return item;
        if (counts[item.id] == null) return item;
        return { ...item, questionCount: counts[item.id], meta: formatQuestionCount(counts[item.id]) };
      });
      renderSubjects();
    } catch (_) {
      await applyLocalQuestionCounts();
    }
  }

  async function applyLocalQuestionCounts() {
    const quizCards = subjectCards.filter((item) => item.quiz);
    await Promise.all(
      quizCards.map(async (item) => {
        try {
          const data = await AppApi.getQuestions(item.id);
          const n = Array.isArray(data.questions) ? data.questions.length : 0;
          item.questionCount = n;
          item.meta = formatQuestionCount(n);
        } catch (_) {
          /* 유지 */
        }
      })
    );
    renderSubjects();
  }

  async function openSubjectQuiz(subject) {
    const subjectId = AppApi.resolveSubjectId(subject.id) || subject.id;
    location.href = `quiz.html?subject=${encodeURIComponent(subjectId)}&set=1`;
  }

  Shell.init({ activeNav: 'home' });
  renderSubjects();
  renderFeatures();
  loadSubjects();
  if (Shell.whenUser) {
    Shell.whenUser().then(() => {
      renderSubjects();
      renderFeatures();
    });
  }
  if (Shell.loadEntitlements) {
    Shell.loadEntitlements().then(() => renderFeatures());
  }

  /* 카드 클릭 → 해당 화면으로 이동, 없으면 준비 중 안내 */
  document.addEventListener('click', (event) => {
    const card = event.target.closest('[data-subject]');
    if (card) {
      const subject = subjectCards.find((item) => item.id === card.dataset.subject);
      if (!subject) return;
      Shell.ensureUser(subject.quiz ? 'quiz.html' : subject.href).then((ok) => {
        if (!ok) return;
        if (subject.href) location.href = subject.href;
        else if (subject.quiz) openSubjectQuiz(subject);
        else Shell.showToast(`${subject.title} 기능은 준비 중입니다.`);
      });
      return;
    }

    const tool = event.target.closest('[data-feature]');
    if (tool) {
      const feature = FEATURES.find((item) => item.id === tool.dataset.feature || item.feature === tool.dataset.feature);
      if (!feature) return;
      Shell.ensureUser().then((ok) => {
        if (!ok) return;
        const gate = feature.feature;
        if (gate) {
          Shell.loadEntitlements().then(() => {
            if (!Shell.canFeature(gate)) {
              Shell.showToast(Shell.upgradeMessage(gate));
              location.href = 'billing.html';
              return;
            }
            if (feature.href) location.href = feature.href;
            else Shell.showToast(`${feature.title} 기능은 준비 중입니다.`);
          });
          return;
        }
        if (feature.href) location.href = feature.href;
        else Shell.showToast(`${feature.title} 기능은 준비 중입니다.`);
      });
    }
  });
})();
