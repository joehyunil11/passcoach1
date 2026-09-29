/* 공지사항 게시판: 회원 조회 · 관리자 작성 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'notice' });

  let notices = [];
  let admin = false;
  let selectedId = '';
  let editingId = '';

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

  function currentNotice() {
    return notices.find((item) => String(item.id) === String(selectedId)) || null;
  }

  function itemNo(item) {
    if (!item || item.pinned) return '';
    const unpinned = notices.filter((row) => !row.pinned);
    const idx = unpinned.findIndex((row) => String(row.id) === String(item.id));
    return idx < 0 ? '' : String(unpinned.length - idx);
  }

  function renderList() {
    const list = $('#noticeList');
    if (!notices.length) {
      list.innerHTML = '<li class="notice__empty">등록된 공지사항이 없습니다.</li>';
      return;
    }
    list.innerHTML =
      `<li class="notice__headrow" aria-hidden="true"><span>번호</span><span>제목</span><span>날짜</span></li>` +
      notices
        .map((item) => {
          const no = itemNo(item);
          const pin = item.pinned ? '<em class="notice__pin-tag">고정</em>' : '';
          return `
        <li>
          <button class="notice__item" type="button" data-id="${esc(String(item.id))}">
            <span class="notice__item-flag">${esc(no)}</span>
            <span class="notice__item-title">${pin}${esc(item.title || '')}</span>
            <span class="notice__item-date">${esc(formatDate(item.created_at))}</span>
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

  function showDetail(id) {
    const item = notices.find((row) => String(row.id) === String(id));
    if (!item) {
      showList();
      return;
    }
    selectedId = String(item.id);
    $('#listPanel').hidden = true;
    $('#detailPanel').hidden = false;
    $('#detailPin').hidden = !item.pinned;
    const no = itemNo(item);
    $('#detailTitle').textContent = no ? `${no}. ${item.title || ''}` : (item.title || '');
    $('#detailMeta').textContent = `${formatDate(item.created_at)}${item.author_name ? ` · ${item.author_name}` : ''}`;
    $('#detailBody').textContent = item.content || '';
    $('#detailAdmin').hidden = !admin;
  }

  function openDialog(item) {
    editingId = item && item.id ? String(item.id) : '';
    $('#dialogTitle').textContent = editingId ? '공지 수정' : '공지 작성';
    $('#noticeTitleInput').value = (item && item.title) || '';
    $('#noticeContentInput').value = (item && item.content) || '';
    $('#noticePinnedInput').checked = !!(item && item.pinned);
    $('#dialog').hidden = false;
    $('#noticeTitleInput').focus();
  }

  function closeDialog() {
    editingId = '';
    $('#dialog').hidden = true;
  }

  async function loadNotices() {
    const data = await AppApi.get('/api/notices');
    notices = Array.isArray(data.notices) ? data.notices : [];
    admin = !!data.admin;
    $('#writeBtn').hidden = !admin;
    $('#noticeSub').textContent = admin
      ? '관리자는 공지를 작성·수정·삭제할 수 있습니다.'
      : '서비스 안내와 공지를 확인할 수 있습니다.';
    renderList();
    const wanted = new URLSearchParams(location.search).get('id') || selectedId;
    if (wanted && notices.some((item) => String(item.id) === String(wanted))) showDetail(wanted);
    else showList();
    if (typeof Shell.markNoticesSeen === 'function') Shell.markNoticesSeen();
  }

  $('#noticeList').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-id]');
    if (!btn) return;
    showDetail(btn.dataset.id);
  });

  $('#backBtn').addEventListener('click', showList);
  $('#writeBtn').addEventListener('click', () => openDialog(null));
  $('#editBtn').addEventListener('click', () => {
    const item = currentNotice();
    if (item) openDialog(item);
  });
  $('#dialogCancel').addEventListener('click', closeDialog);
  $('#dialog').addEventListener('click', (event) => {
    if (event.target === $('#dialog')) closeDialog();
  });

  $('#dialogForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      title: $('#noticeTitleInput').value.trim(),
      content: $('#noticeContentInput').value.trim(),
      pinned: $('#noticePinnedInput').checked,
    };
    if (Shell.stripTags) {
      payload.title = Shell.stripTags(payload.title).slice(0, 80);
      payload.content = Shell.stripTags(payload.content).slice(0, 20000);
    }
    if (!payload.title || !payload.content) {
      Shell.showToast('제목과 내용을 입력해 주세요.');
      return;
    }
    try {
      if (editingId) await AppApi.put(`/api/notices/${encodeURIComponent(editingId)}`, payload);
      else await AppApi.post('/api/notices', payload);
      closeDialog();
      Shell.showToast(editingId ? '공지를 수정했습니다.' : '공지를 등록했습니다.');
      await loadNotices();
    } catch (err) {
      Shell.showToast(err.message || '공지를 저장하지 못했습니다. supabase-notices.sql을 실행했는지 확인해 주세요.');
    }
  });

  $('#deleteBtn').addEventListener('click', async () => {
    const item = currentNotice();
    if (!item) return;
    if (!window.confirm('이 공지를 삭제할까요?')) return;
    try {
      await AppApi.del(`/api/notices/${encodeURIComponent(item.id)}`);
      Shell.showToast('공지를 삭제했습니다.');
      selectedId = '';
      await loadNotices();
    } catch (err) {
      Shell.showToast(err.message || '공지를 삭제하지 못했습니다.');
    }
  });

  loadNotices().catch((err) => {
    $('#noticeList').innerHTML = `<li class="notice__empty">${esc(err.message || '공지사항을 불러오지 못했습니다.')}</li>`;
  });
})();
