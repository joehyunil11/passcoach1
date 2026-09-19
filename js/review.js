/* 오답노트 전용: 과목 필터 · 오답 목록 렌더링 · 다시 풀기 이동 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'wrong' });
  Shell.requireFeature('review');

  const FILTERS = [
    { id: 'all', label: '전체' },
    { id: 'korean', label: '국어' },
    { id: 'english', label: '영어' },
    { id: 'history', label: '한국사' },
    { id: 'adminlaw', label: '행정법' },
    { id: 'adminsci', label: '행정학' },
    { id: 'peducation', label: '교육학개론' },
    { id: 'localtax', label: '지방세법' },
    { id: 'accounting', label: '회계학' },
    { id: 'socialwelfare', label: '사회복지학개론' },
    { id: 'etc', label: '기타' },
  ];

  const SUBJECT_IDS = FILTERS.map((item) => item.id).filter((id) => id !== 'all' && id !== 'etc');

  let filter = 'all';

  const pad = (n) => String(n).padStart(2, '0');

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
  }

  /* 문제 은행에 없는 과목은 「기타」로 묶는다 */
  const shortLabel = (id) => {
    const key = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(id) : id;
    if (QUESTION_BANK[key] && QUESTION_BANK[key].short) return QUESTION_BANK[key].short;
    const hit = FILTERS.find((item) => item.id === key);
    return (hit && hit.label) || '기타';
  };
  const tagKey = (id) => {
    const key = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(id) : id;
    return SUBJECT_IDS.includes(key) ? key : 'etc';
  };

  function subjectId(item) {
    const raw = item && item.subject;
    const resolved = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(raw) : raw;
    return resolved || raw || '';
  }

  function matchesFilter(item) {
    const id = subjectId(item);
    if (filter === 'all') return true;
    if (filter === 'etc') return !SUBJECT_IDS.includes(id);
    return id === filter;
  }

  function renderFilters() {
    $('#filterRow').innerHTML = FILTERS
      .map(
        (item) => `
      <button class="filter${item.id === filter ? ' is-active' : ''}" type="button"
              data-filter="${item.id}" aria-pressed="${item.id === filter}">${esc(item.label)}</button>`
      )
      .join('');
  }

  function renderList() {
    const notes = WrongNotes.all();
    const shown = notes.filter(matchesFilter);

    $('#notesSub').textContent = notes.length
      ? `모두 ${notes.length}문항이 담겨 있습니다.`
      : '틀린 문제가 자동으로 모입니다.';

    if (!shown.length) {
      $('#noteList').innerHTML = `
        <li class="notes__empty">${
          notes.length
            ? '이 과목에는 담긴 오답이 없습니다.'
            : '아직 담긴 오답이 없습니다.<br />과목별 문제를 풀면 틀린 문제가 이곳에 자동으로 모입니다.'
        }</li>`;
      return;
    }

    $('#noteList').innerHTML = shown
      .map(
        (item) => `
      <li class="note">
        <span class="note__tag note__tag--${tagKey(subjectId(item))}">${esc(shortLabel(subjectId(item)))}</span>
        <div class="note__body">
          <p class="note__topic">${esc(item.topic || '기타')}</p>
          <p class="note__q">${esc(item.q)}</p>
          <p class="note__date">틀린 날짜: ${formatDate(item.date)}</p>
        </div>
        <div class="note__actions">
          <button class="btn btn--outline btn--sm" type="button"
                  data-retry data-subject="${esc(item.subject)}" data-question="${item.index}" data-question-id="${item.questionId || ''}">다시 풀기</button>
          <button class="btn btn--outline btn--sm note__delete" type="button"
                  data-remove data-subject="${esc(item.subject)}" data-question="${item.index}" data-question-id="${item.questionId || ''}">삭제</button>
        </div>
      </li>`
      )
      .join('');
  }

  function render() {
    renderFilters();
    renderList();
  }

  WrongNotes.ready().then(render);

  /* ── 이벤트 ─────────────────────────────── */
  $('#filterRow').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-filter]');
    if (!btn) return;

    filter = btn.dataset.filter;
    render();
  });

  $('#noteList').addEventListener('click', async (event) => {
    const removeBtn = event.target.closest('[data-remove]');
    if (removeBtn) {
      await WrongNotes.remove(
        removeBtn.dataset.subject,
        Number(removeBtn.dataset.question),
        removeBtn.dataset.questionId ? Number(removeBtn.dataset.questionId) : undefined
      );
      render();
      Shell.showToast('오답을 삭제했습니다.');
      return;
    }

    const retryBtn = event.target.closest('[data-retry]');
    if (!retryBtn) return;

    location.href = `quiz.html?subject=${encodeURIComponent(retryBtn.dataset.subject)}${
      Number.isInteger(Number(retryBtn.dataset.question)) && Number(retryBtn.dataset.question) >= 0
        ? `&q=${retryBtn.dataset.question}`
        : ''
    }`;
  });

  $('#clearBtn').addEventListener('click', async () => {
    if (!WrongNotes.all().length) {
      Shell.showToast('삭제할 오답이 없습니다.');
      return;
    }
    if (!confirm('오답노트를 전부 삭제하시겠습니까?')) return;

    await WrongNotes.clear();
    render();
    Shell.showToast('오답노트를 비웠습니다.');
  });
})();
