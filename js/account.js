/* 마이페이지: 회원 정보 · 학습/알림 설정 · 계정 관리 (서버 저장) */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'account' });

  const SUBJECTS = [
    { id: 'korean', label: '국어' },
    { id: 'english', label: '영어' },
    { id: 'history', label: '한국사' },
    { id: 'adminlaw', label: '행정법' },
    { id: 'adminsci', label: '행정학' },
    { id: 'peducation', label: '교육학개론' },
    { id: 'localtax', label: '지방세법' },
    { id: 'accounting', label: '회계학' },
    { id: 'socialwelfare', label: '사회복지학개론' },
  ];
  const PLANS = {
    free: { name: '무료 이용권', amount: '0원' },
    basic: { name: '베이직 이용권', amount: '9,900원' },
    premium: { name: '프리미엄 이용권', amount: '19,900원' },
  };

  const DEFAULT = {
    name: '홍길동',
    email: 'hong123@email.com',
    joined: '2024.01.15',
    goal: '2024년 12월 시험 합격',
    subjects: [],
    dailyTarget: 30,
    notify: { study: true, review: true, event: false },
  };

  let account = { ...DEFAULT };
  let planId = 'free';
  let payments = [];
  let dialogMode = '';
  let signedIn = false;

  function currentPlan() {
    if (planId && PLANS[planId]) return { id: planId, ...PLANS[planId] };
    return { id: 'free', ...PLANS.free };
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  function payDates() {
    const last = Array.isArray(payments) && payments[0];
    if (last && last.date) {
      const paid = formatDate(last.date);
      const next = new Date(last.date);
      next.setMonth(next.getMonth() + 1);
      return { paid, next: formatDate(next.toISOString()) };
    }
    return { paid: '2024.06.01', next: '2024.07.01' };
  }

  function subjectText(ids) {
    if (!ids.length) return '주로 학습하는 과목을 선택하세요.';
    return ids
      .map((id) => SUBJECTS.find((item) => item.id === id))
      .filter(Boolean)
      .map((item) => item.label)
      .join(', ');
  }

  function render() {
    const page = $('#mypage');
    const guest = $('#accountGuest');
    if (page) page.classList.toggle('mypage--guest', !signedIn);
    if (guest) guest.hidden = signedIn;
    if (!signedIn) return;

    const plan = currentPlan();
    const dates = payDates();
    $('#viewName').textContent = account.name || '이름 없음';
    $('#viewEmail').textContent = account.email || '';
    $('#viewJoined').textContent = `가입일: ${account.joined || '-'}`;
    $('#viewPlan').textContent = plan.name;
    $('#viewPaid').textContent = `결제일: ${dates.paid}`;
    $('#viewNext').textContent = `다음 결제일: ${plan.id === 'free' ? '-' : dates.next}`;
    $('#viewAmount').textContent = `결제 금액: ${plan.amount}`;
    $('#viewGoal').textContent = account.goal || '학습 목표를 입력해 주세요.';
    $('#viewGoal2').textContent = account.goal || '학습 목표를 입력해 주세요.';
    const dateEl = $('#viewTargetDate');
    if (dateEl) {
      dateEl.textContent = account.targetDate ? `목표 시험일: ${account.targetDate}` : '';
      dateEl.hidden = !account.targetDate;
    }
    $('#viewSubjects').textContent = subjectText(account.subjects || []);
    $('#viewSubjects2').textContent = subjectText(account.subjects || []);
    $('#dailyTarget').value = account.dailyTarget;
    $('#notifyStudy').checked = account.notify.study;
    $('#notifyReview').checked = account.notify.review;
    $('#notifyEvent').checked = account.notify.event;
  }

  async function saveAccount() {
    if (!signedIn) {
      Shell.showToast('로그인 후 저장할 수 있습니다.');
      return false;
    }
    try {
      const data = await AppApi.put('/api/account', { account });
      if (data.account) {
        account = {
          ...account,
          ...data.account,
          notify: { ...account.notify, ...(data.account.notify || {}) },
          subjects: Array.isArray(data.account.subjects) ? data.account.subjects : account.subjects,
        };
      }
      return true;
    } catch (err) {
      Shell.showToast(err.message || '프로필 저장에 실패했습니다. supabase-profiles.sql을 실행했는지 확인해 주세요.');
      return false;
    }
  }

  async function boot() {
    try {
      const data = await AppApi.get('/api/account');
      signedIn = Boolean(data.user);
      if (!signedIn) {
        account = { ...DEFAULT, name: '', email: '', goal: '', subjects: [] };
        render();
        return;
      }
      account = {
        ...DEFAULT,
        ...(data.account || {}),
        notify: { ...DEFAULT.notify, ...((data.account && data.account.notify) || {}) },
        subjects: Array.isArray(data.account && data.account.subjects) ? data.account.subjects : [],
      };
      planId = data.plan || 'free';
      payments = Array.isArray(data.payments) ? data.payments : [];
      if (data.hint) Shell.showToast(data.hint);
    } catch {
      signedIn = false;
      account = { ...DEFAULT, name: '', email: '', goal: '', subjects: [] };
    }
    render();
  }

  function setTab(id) {
    $$('.mypage__tab').forEach((tab) => {
      const on = tab.dataset.tab === id;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    $$('.mypage__panel').forEach((panel) => {
      panel.hidden = panel.id !== `panel${id[0].toUpperCase()}${id.slice(1)}`;
    });
  }

  const dialog = $('#dialog');
  const dialogBody = $('#dialogBody');

  function closeDialog() {
    dialog.hidden = true;
    dialogMode = '';
  }

  function openDialog(mode) {
    dialogMode = mode;
    const title = {
      profile: '정보 수정',
      goal: '학습 목표 수정',
      subjects: '선호 과목 설정',
      password: '비밀번호 변경',
    }[mode];
    $('#dialogTitle').textContent = title;

    if (mode === 'profile') {
      dialogBody.innerHTML = `
        <label for="editName">이름</label>
        <input class="field" id="editName" name="name" value="${esc(account.name)}" required maxlength="20" />
        <label for="editEmail">이메일</label>
        <input class="field" id="editEmail" name="email" type="email" value="${esc(account.email)}" required disabled />
        <p class="row__desc">이메일은 가입할 때 사용한 주소입니다.</p>`;
    } else if (mode === 'goal') {
      dialogBody.innerHTML = `
        <label for="editGoal">학습 목표</label>
        <input class="field" id="editGoal" name="goal" value="${esc(account.goal)}" required maxlength="40" />
        <label for="editTargetDate">목표 시험일</label>
        <input class="field" id="editTargetDate" name="targetDate" type="date" value="${esc(account.targetDate || '')}" />`;
    } else if (mode === 'subjects') {
      dialogBody.innerHTML = `<div class="chips">${SUBJECTS.map(
        (item) => `
        <label class="chip">
          <input type="checkbox" name="subject" value="${item.id}" ${account.subjects.includes(item.id) ? 'checked' : ''} />
          ${esc(item.label)}
        </label>`
      ).join('')}</div>`;
    } else {
      dialogBody.innerHTML = `
        <label for="pwNow">현재 비밀번호</label>
        <input class="field" id="pwNow" type="password" autocomplete="current-password" />
        <label for="pwNew">새 비밀번호</label>
        <input class="field" id="pwNew" type="password" autocomplete="new-password" minlength="6" />
        <label for="pwAgain">새 비밀번호 확인</label>
        <input class="field" id="pwAgain" type="password" autocomplete="new-password" />`;
    }

    dialog.hidden = false;
    const first = dialogBody.querySelector('input');
    if (first) first.focus();
  }

  boot();

  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const open = event.target.closest('[data-open]');
    if (open) openDialog(open.dataset.open);
  });

  $('#dialogCancel').addEventListener('click', closeDialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });

  $('#dialogForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!signedIn) {
      Shell.showToast('로그인 후 저장할 수 있습니다.');
      return;
    }
    if (dialogMode === 'profile') {
      account.name = $('#editName').value.trim() || account.name;
    } else if (dialogMode === 'goal') {
      account.goal = $('#editGoal').value.trim() || account.goal;
      account.targetDate = ($('#editTargetDate') && $('#editTargetDate').value) || '';
    } else if (dialogMode === 'subjects') {
      account.subjects = $$('input[name="subject"]:checked').map((input) => input.value);
    } else if (dialogMode === 'password') {
      const currentPassword = $('#pwNow').value;
      const next = $('#pwNew').value;
      const again = $('#pwAgain').value;
      if (!next || next.length < 6) {
        Shell.showToast('새 비밀번호는 6자 이상이어야 합니다.');
        return;
      }
      if (next !== again) {
        Shell.showToast('새 비밀번호가 서로 다릅니다.');
        return;
      }
      try {
        await AppApi.post('/api/account/password', { currentPassword, newPassword: next });
        Shell.showToast('비밀번호를 변경했습니다.');
        closeDialog();
      } catch (err) {
        Shell.showToast(err.message || '비밀번호를 바꾸지 못했습니다.');
      }
      return;
    }
    const ok = await saveAccount();
    if (!ok) return;
    if (dialogMode === 'profile') Shell.showToast('회원 정보를 프로필에 저장했습니다.');
    else if (dialogMode === 'goal') Shell.showToast('학습 목표를 프로필에 저장했습니다.');
    else if (dialogMode === 'subjects') Shell.showToast('선호 과목을 프로필에 저장했습니다.');
    render();
    closeDialog();
  });

  $('#saveStudy').addEventListener('click', async () => {
    account.dailyTarget = Math.max(1, Number($('#dailyTarget').value) || 30);
    await saveAccount();
    Shell.showToast('학습 설정을 프로필에 저장했습니다.');
  });

  ['notifyStudy', 'notifyReview', 'notifyEvent'].forEach((id) => {
    $(`#${id}`).addEventListener('change', async () => {
      account.notify = {
        study: $('#notifyStudy').checked,
        review: $('#notifyReview').checked,
        event: $('#notifyEvent').checked,
      };
      await saveAccount();
      Shell.showToast('알림 설정을 프로필에 저장했습니다.');
    });
  });

  $('#leaveBtn').addEventListener('click', async () => {
    if (window.confirm('정말 탈퇴할까요? 학습 기록이 함께 지워집니다.')) {
      try {
        await AppApi.post('/api/account/leave');
      } catch {
        /* ignore */
      }
      Shell.showToast('회원 탈퇴가 완료되었습니다.');
      location.href = 'index.html';
    }
  });
})();
