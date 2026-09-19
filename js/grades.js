/* 나의 성적: 과목별 전체 문항 기준 정답률 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'grades' });
  Shell.requireFeature('grades');

  const SUBJECTS = [
    { id: 'korean', label: '9급 국어' },
    { id: 'english', label: '9급 영어' },
    { id: 'history', label: '한국사' },
    { id: 'adminlaw', label: '행정법' },
    { id: 'adminsci', label: '행정학' },
    { id: 'peducation', label: '교육학개론' },
    { id: 'localtax', label: '지방세법' },
    { id: 'accounting', label: '회계학' },
    { id: 'socialwelfare', label: '사회복지학개론' },
  ];

  function barClass(rate, total, difficulty) {
    if (difficulty === 'high') return '';
    if (difficulty === 'mid') return 'is-mid';
    if (difficulty === 'low') return 'is-low';
    if (difficulty === 'empty') return 'is-empty';
    if (!total) return 'is-empty';
    if (rate >= 70) return '';
    if (rate >= 60) return 'is-mid';
    return 'is-low';
  }

  function renderTable() {
    const stats = StudyLog.subjectStats();
    const byId = new Map(stats.map((row) => [row.id, row]));
    const rows = SUBJECTS.map((subject) => {
      const row = byId.get(subject.id);
      return {
        id: subject.id,
        title: (row && row.title) || subject.label,
        total: row ? row.total : 0,
        correct: row ? row.correct : 0,
        rate: row ? row.totalRate : 0,
        difficulty: row ? row.difficulty : 'empty',
      };
    });

    if (!rows.some((row) => row.total)) {
      $('#gradesBody').innerHTML = `
        <tr><td class="record__empty" colspan="5">아직 표시할 과목 문제가 없습니다.</td></tr>`;
      return;
    }

    $('#gradesBody').innerHTML = rows
      .map((row) => {
        const href = `quiz.html?subject=${encodeURIComponent(row.id)}&set=1`;
        return `
      <tr>
        <td class="record__topic"><a class="record__subject" href="${href}">${esc(row.title)}</a></td>
        <td class="record__count">${row.total} 문제</td>
        <td class="record__count">${row.correct} 문제</td>
        <td class="record__rate">${row.total ? `${row.rate}%` : '—'}</td>
        <td>
          <span class="bar ${barClass(row.rate, row.total, row.difficulty)}" aria-hidden="true">
            <span style="width:${row.total ? row.rate : 0}%"></span>
          </span>
        </td>
      </tr>`;
      })
      .join('');
  }

  StudyLog.ready().then(renderTable);
})();
