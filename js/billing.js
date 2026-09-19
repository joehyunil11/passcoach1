/* 이용권 구매 · 결제 내역 (서버 저장, localStorage 없음) */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'billing' });

  const CHECK = `
    <span class="plan__check" aria-hidden="true">
      <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9"/><path d="M6 10.2l2.4 2.4 5.4-5.6"/></svg>
    </span>`;
  const CROWN = `
    <span class="plan__crown" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M4 16.5 7.2 8.5 12 13l4.8-4.5 3.2 8H4Z"/><path d="M5 19h14"/></svg>
    </span>`;

  const PLANS = [
    {
      id: 'free',
      name: '무료 이용권',
      price: 0,
      priceLabel: '0원',
      features: ['5문제/일', 'AI 선생님    3회/일', '기본 기능 이용'],
      buyClass: 'plan__btn--blue',
    },
    {
      id: 'basic',
      name: '베이직 이용권',
      price: 9900,
      priceLabel: '9,900원',
      features: ['80문제/일', 'AI 선생님    100회/월', '오답노트', '나의 학습 현황', '나의 성적 '],
      buyClass: 'plan__btn--blue',
    },
    {
      id: 'premium',
      name: '프리미엄 이용권',
      price: 19900,
      priceLabel: '19,900원',
      features: ['문제 무제한', 'AI 선생님    1000회/월', '오답노트', '나의 학습 현황', '나의 성적 ','나의 약점 분석','AI 해설의 유사문제' ],
      buyClass: 'plan__btn--orange',
      recommended: true,
    },
  ];

  let currentPlanId = 'premium';
  let payments = [];

  function won(n) {
    return `${Number(n).toLocaleString('ko-KR')}원`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
  }

  const planGrid = $('#planGrid');
  const payBody = $('#payBody');
  const payBox = $('#payBox');
  let pendingId = '';

  function renderPlans() {
    const current = currentPlanId;
    planGrid.innerHTML = PLANS.map((plan) => {
      const currentNow = plan.id === current;
      const btnClass = currentNow ? 'plan__btn--current' : plan.buyClass;
      const btnLabel = currentNow ? '현재 이용 중' : plan.price === 0 ? '무료로 전환' : '구매하기';
      return `
        <article class="plan${plan.recommended ? ' plan--premium' : ''}">
          ${plan.recommended ? '<span class="plan__ribbon">추천</span>' : ''}
          ${plan.recommended ? CROWN : ''}
          <h3 class="plan__name">${esc(plan.name)}</h3>
          <p class="plan__price"><b>${esc(plan.priceLabel)}</b><span>/ 월</span></p>
          <ul class="plan__list">
            ${plan.features.map((feat) => `<li class="plan__feat">${CHECK}<span>${esc(feat)}</span></li>`).join('')}
          </ul>
          <button class="plan__btn ${btnClass}" type="button" data-plan="${plan.id}" ${currentNow ? 'disabled' : ''}>
            ${btnLabel}
          </button>
        </article>`;
    }).join('');
  }

  function renderHistory() {
    if (!payments.length) {
      payBody.innerHTML = `<tr><td class="pay-empty" colspan="4">아직 결제 내역이 없습니다.</td></tr>`;
      return;
    }
    payBody.innerHTML = payments
      .map(
        (row) => `
      <tr>
        <td>${esc(formatDate(row.date))}</td>
        <td>${esc(row.name)}</td>
        <td>${esc(won(row.amount))}</td>
        <td class="is-ok">${esc(row.status)}</td>
      </tr>`
      )
      .join('');
  }

  function setTab(which) {
    const plans = which === 'plans';
    $('#tabPlans').classList.toggle('is-active', plans);
    $('#tabHistory').classList.toggle('is-active', !plans);
    $('#tabPlans').setAttribute('aria-selected', String(plans));
    $('#tabHistory').setAttribute('aria-selected', String(!plans));
    $('#panelPlans').hidden = !plans;
    $('#panelHistory').hidden = plans;
    if (!plans) renderHistory();
  }

  function openPay(plan) {
    pendingId = plan.id;
    $('#payTitle').textContent = plan.price === 0 ? `${plan.name}으로 전환` : `${plan.name} 구매`;
    $('#payLead').textContent =
      plan.price === 0 ? '무료 이용권으로 전환할까요?' : `월 ${won(plan.price)}이 결제됩니다.`;
    $('#payConfirm').textContent = plan.price === 0 ? '전환하기' : '결제하기';
    payBox.hidden = false;
  }

  function closePay() {
    pendingId = '';
    payBox.hidden = true;
  }

  async function confirmPay() {
    const plan = PLANS.find((item) => item.id === pendingId);
    if (!plan) return;
    try {
      await AppApi.put('/api/billing/plan', { plan: plan.id });
      currentPlanId = plan.id;
      if (plan.price > 0) {
        const data = await AppApi.post('/api/billing/payments', {
          plan: plan.id,
          name: plan.name,
          amount: plan.price,
        });
        payments = data.payments || payments;
      }
      closePay();
      renderPlans();
      Shell.showToast(plan.price === 0 ? '무료 이용권으로 전환했습니다.' : `${plan.name} 구매가 완료되었습니다.`);
    } catch (err) {
      Shell.showToast(err.message || '결제 처리에 실패했습니다.');
    }
  }

  async function boot() {
    try {
      const data = await AppApi.get('/api/account');
      currentPlanId = data.plan || 'premium';
      payments = Array.isArray(data.payments) ? data.payments : [];
    } catch {
      currentPlanId = 'premium';
      payments = [];
    }
    renderPlans();
    renderHistory();
    if (location.hash === '#history') setTab('history');
  }

  boot();

  $('#tabPlans').addEventListener('click', () => setTab('plans'));
  $('#tabHistory').addEventListener('click', () => setTab('history'));

  planGrid.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-plan]');
    if (!btn || btn.disabled) return;
    const plan = PLANS.find((item) => item.id === btn.dataset.plan);
    if (plan) openPay(plan);
  });

  $('#payCancel').addEventListener('click', closePay);
  $('#payConfirm').addEventListener('click', confirmPay);
  payBox.addEventListener('click', (event) => {
    if (event.target === payBox) closePay();
  });
})();
