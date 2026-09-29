/* 오류 신고 게시판: 회원 작성 · 비밀번호 확인 · 관리자 답변 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'event' });

  let reports = [];
  let admin = false;
  let selectedId = '';
  let pendingUnlockId = '';
  const unlocked = new Map();

  const pad = (n) => String(n).padStart(2, '0');

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
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
      return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    }
  }

  function statusLabel(item) {
    return item && item.has_answer ? '답변완료' : '답변대기';
  }

  function itemNo(list, id) {
    const idx = list.findIndex((row) => String(row.id) === String(id));
    return idx < 0 ? 0 : list.length - idx;
  }

  function renderList() {
    const list = $('#reportList');
    if (!reports.length) {
      list.innerHTML = '<li class="report__empty">등록된 오류 신고가 없습니다.</li>';
      return;
    }
    list.innerHTML =
      `<li class="report__headrow" aria-hidden="true"><span>번호</span><span>제목</span><span>상태</span><span>날짜</span></li>` +
      reports
        .map((item) => {
          const done = !!item.has_answer;
          const no = itemNo(reports, item.id);
          return `
        <li>
          <button class="report__item" type="button" data-id="${esc(String(item.id))}">
            <span class="report__item-flag">${esc(String(no))}</span>
            <span class="report__item-title">${esc(item.title || '')}</span>
            <span class="report__item-status ${done ? 'is-done' : 'is-wait'}">${esc(statusLabel(item))}</span>
            <span class="report__item-date">${esc(formatDate(item.created_at))}</span>
          </button>
        </li>`;
        })
        .join('');
  }

  function showList() {
    selectedId = '';
    $('#listPanel').hidden = false;
    $('#detailPanel').hidden = true;
  }

  function showDetail(item) {
    selectedId = String(item.id);
    $('#listPanel').hidden = true;
    $('#detailPanel').hidden = false;
    const done = !!item.has_answer;
    const status = $('#detailStatus');
    status.textContent = statusLabel(item);
    status.classList.toggle('is-wait', !done);
    $('#detailTitle').textContent = `${itemNo(reports, item.id)}. ${item.title || ''}`;
    $('#detailMeta').textContent = `${formatDate(item.created_at)}${
      admin && item.author_name ? ` · ${item.author_name}` : ''
    }`;
    $('#detailBody').textContent = item.content || '';
    $('#answerBox').hidden = !item.answer;
    $('#answerBody').textContent = item.answer || '';
    $('#replyForm').hidden = !admin;
    if (admin) $('#replyInput').value = item.answer || '';
  }

  function closeDialog(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }

  function openWriteDialog() {
    $('#reportTitleInput').value = '';
    $('#reportContentInput').value = '';
    $('#reportPasswordInput').value = '';
    $('#reportPasswordAgain').value = '';
    $('#writeDialog').hidden = false;
    $('#reportTitleInput').focus();
  }

  function openUnlockDialog(id) {
    pendingUnlockId = String(id);
    $('#unlockPassword').value = '';
    $('#unlockDialog').hidden = false;
    $('#unlockPassword').focus();
  }

  async function loadReports() {
    const data = await AppApi.get('/api/reports');
    reports = Array.isArray(data.reports) ? data.reports : [];
    admin = !!data.admin;
    renderList();
  }

  async function openReport(id, password) {
    const data = await AppApi.post(`/api/reports/${encodeURIComponent(id)}/open`, { password: password || '' });
    const item = data.report;
    if (!item) throw new Error('글을 찾을 수 없습니다.');
    unlocked.set(String(item.id), password || '');
    const idx = reports.findIndex((row) => String(row.id) === String(item.id));
    if (idx >= 0) reports[idx] = { ...reports[idx], has_answer: !!item.has_answer };
    showDetail(item);
  }

  async function requestOpen(id) {
    if (admin || unlocked.has(String(id))) {
      try {
        await openReport(id, unlocked.get(String(id)) || '');
      } catch (err) {
        Shell.showToast(err.message || '글을 열지 못했습니다.');
      }
      return;
    }
    openUnlockDialog(id);
  }

  $('#reportList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-id]');
    if (!btn) return;
    requestOpen(btn.dataset.id);
  });

  $('#backBtn').addEventListener('click', showList);
  $('#writeBtn').addEventListener('click', openWriteDialog);
  $('#writeCancel').addEventListener('click', () => closeDialog('#writeDialog'));
  $('#unlockCancel').addEventListener('click', () => {
    pendingUnlockId = '';
    closeDialog('#unlockDialog');
  });
  $('#writeDialog').addEventListener('click', (event) => {
    if (event.target === $('#writeDialog')) closeDialog('#writeDialog');
  });
  $('#unlockDialog').addEventListener('click', (event) => {
    if (event.target === $('#unlockDialog')) {
      pendingUnlockId = '';
      closeDialog('#unlockDialog');
    }
  });

  $('#writeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = (Shell.stripTags ? Shell.stripTags($('#reportTitleInput').value) : $('#reportTitleInput').value).trim().slice(0, 80);
    const content = (Shell.stripTags ? Shell.stripTags($('#reportContentInput').value) : $('#reportContentInput').value).trim().slice(0, 20000);
    const password = $('#reportPasswordInput').value;
    const again = $('#reportPasswordAgain').value;
    if (!title || !content) {
      Shell.showToast('제목과 내용을 입력해 주세요.');
      return;
    }
    if (password.length < 4) {
      Shell.showToast('비밀번호는 4자 이상이어야 합니다.');
      return;
    }
    if (password !== again) {
      Shell.showToast('비밀번호가 서로 다릅니다.');
      return;
    }
    try {
      const data = await AppApi.post('/api/reports', { title, content, password });
      closeDialog('#writeDialog');
      Shell.showToast('오류 신고를 등록했습니다. 비밀번호를 기억해 주세요.');
      await loadReports();
      if (data.report) {
        unlocked.set(String(data.report.id), password);
        showDetail(data.report);
      }
    } catch (err) {
      Shell.showToast(err.message || '신고를 저장하지 못했습니다. supabase-reports.sql을 실행했는지 확인해 주세요.');
    }
  });

  $('#unlockForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = pendingUnlockId;
    const password = $('#unlockPassword').value;
    if (!id) return;
    try {
      await openReport(id, password);
      pendingUnlockId = '';
      closeDialog('#unlockDialog');
    } catch (err) {
      Shell.showToast(err.message || '비밀번호가 올바르지 않습니다.');
    }
  });

  $('#replyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedId) return;
    const answer = (Shell.stripTags ? Shell.stripTags($('#replyInput').value) : $('#replyInput').value).trim().slice(0, 20000);
    if (!answer) {
      Shell.showToast('답변을 입력해 주세요.');
      return;
    }
    try {
      const data = await AppApi.post(`/api/reports/${encodeURIComponent(selectedId)}/reply`, { answer });
      Shell.showToast('답변을 등록했습니다.');
      await loadReports();
      if (data.report) showDetail(data.report);
    } catch (err) {
      Shell.showToast(err.message || '답변을 저장하지 못했습니다.');
    }
  });

  $('#deleteBtn').addEventListener('click', async () => {
    if (!selectedId) return;
    if (!window.confirm('이 신고 글을 삭제할까요?')) return;
    try {
      await AppApi.del(`/api/reports/${encodeURIComponent(selectedId)}`);
      Shell.showToast('글을 삭제했습니다.');
      unlocked.delete(selectedId);
      selectedId = '';
      await loadReports();
      showList();
    } catch (err) {
      Shell.showToast(err.message || '글을 삭제하지 못했습니다.');
    }
  });

  loadReports()
    .then(() => showList())
    .catch((err) => {
      $('#reportList').innerHTML = `<li class="report__empty">${esc(
        err.message || '오류 신고를 불러오지 못했습니다.'
      )}</li>`;
    });
})();
