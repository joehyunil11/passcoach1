/* AI 선생님: ChatGPT(OpenAI)에 질문을 보내 실제 정답을 받습니다. */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;

  Shell.init({ activeNav: 'teacher' });

  const CHIPS = ['문법 설명해줘', '이 문제 풀이가 궁금해요', '학습 방법 추천해줘'];
  const MODELS = ['gpt-4o', 'gpt-4o-mini'];
  const SYSTEM =
    '당신은 대한민국 9급 공무원 시험(국어, 영어, 한국사, 행정법, 행정학)을 가르치는 선생님입니다. 질문에 정확한 정답과 이유를 한국어로 분명히 답하세요. 선택형이면 정답을 먼저 쓰고, 왜 맞는지와 오답이 왜 틀리는지 짧게 설명하세요. 불확실하면 추측하지 마세요.';

  const AVATAR = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="32" fill="#dce8fb"/>
      <path d="M32 8v6" stroke="#16233d" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="32" cy="7" r="3.2" fill="#54e2ff" stroke="#16233d" stroke-width="2"/>
      <rect x="10" y="22" width="6" height="12" rx="3" fill="#9fbbe8" stroke="#16233d" stroke-width="2"/>
      <rect x="48" y="22" width="6" height="12" rx="3" fill="#9fbbe8" stroke="#16233d" stroke-width="2"/>
      <rect x="14" y="14" width="36" height="30" rx="12" fill="#eef4ff" stroke="#16233d" stroke-width="2.2"/>
      <rect x="20" y="20" width="24" height="18" rx="8" fill="#16233d"/>
      <ellipse cx="28" cy="29" rx="3.2" ry="3.8" fill="#54e2ff"/>
      <ellipse cx="36" cy="29" rx="3.2" ry="3.8" fill="#54e2ff"/>
      <path d="M29 35q3 2.4 6 0" stroke="#54e2ff" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>`;

  const history = [];
  let busy = false;
  let useProxy = false;
  let proxyHasKey = false;

  function toHtml(text) {
    return esc(text).replace(/\n/g, '<br />');
  }

  function botBlock(html, withChips, extraClass) {
    return `
      <article class="msg msg--bot">
        <span class="msg__avatar">${AVATAR}</span>
        <p class="msg__bubble${extraClass ? ` ${extraClass}` : ''}">${html}</p>
      </article>
      ${
        withChips
          ? `<div class="msg__chips">${CHIPS.map(
              (label) => `<button class="chip" type="button" data-chip="${esc(label)}">${esc(label)}</button>`
            ).join('')}</div>`
          : ''
      }`;
  }

  function userBlock(text) {
    return `
      <article class="msg msg--user">
        <p class="msg__bubble">${esc(text)}</p>
      </article>`;
  }

  const log = $('#chatLog');
  const sendBtn = $('.chat__send');
  const keyBtn = $('#keyBtn');
  const keyBox = $('#keyBox');
  const usageEl = $('#aiUsage');

  function renderUsage(usage) {
    if (!usageEl || !usage) return;
    const used = Number(usage.usedPeriod) || 0;
    const limit = Number(usage.limit) || 0;
    const label = usage.periodLabel || '오늘';
    usageEl.textContent = `사용횟수 ${label} ${used}/${limit}회`;
  }

  async function loadUsage() {
    try {
      if (Shell.loadEntitlements) {
        const data = await Shell.loadEntitlements();
        if (data && data.ai) {
          renderUsage(data.ai);
          return;
        }
      }
      const data = typeof AppApi !== 'undefined' ? await AppApi.get('/api/ai-usage') : await fetch('/api/ai-usage').then((r) => r.json());
      renderUsage(data.usage);
    } catch {
      if (usageEl) usageEl.textContent = '사용횟수 —';
    }
  }

  log.innerHTML = botBlock(
    '안녕하세요!<br />질문을 보내 주시면 공무원 시험 정답과 이유를 알려 드릴게요.',
    true
  );

  let memoryKey = '';

  function setBusy(on) {
    busy = on;
    sendBtn.disabled = on;
    $('#askInput').disabled = on;
  }

  function setConnected(on) {
    keyBtn.textContent = on ? 'ChatGPT 연결됨' : 'ChatGPT 연결';
    keyBtn.classList.toggle('is-on', on);
  }

  function localKey() {
    return memoryKey;
  }

  async function detectProxy() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return false;
      const data = await res.json();
      proxyHasKey = Boolean(data.ai || data.provider);
      return true;
    } catch {
      return false;
    }
  }

  async function askChatGPT(key, messages) {
    const payload = {
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    };
    let lastError = 'ChatGPT 응답에 실패했습니다.';
    for (const model of MODELS) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ ...payload, model }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = (data.error && data.error.message) || lastError;
        continue;
      }
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (text) return String(text).trim();
    }
    throw new Error(lastError);
  }

  async function askProxy(messages) {
    const body = { messages };
    if (!proxyHasKey) {
      const key = localKey();
      if (key) body.apiKey = key;
    }
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (data.usage) {
      renderUsage(data.usage);
      const ent = Shell.getEntitlements && Shell.getEntitlements();
      if (ent) ent.ai = { ...ent.ai, ...data.usage };
    }
    if (!res.ok) {
      const err = new Error(data.error || '서버 응답에 실패했습니다.');
      err.code = data.error;
      err.status = res.status;
      throw err;
    }
    return data.answer;
  }

  async function askModel(messages) {
    if (useProxy) return askProxy(messages);
    const key = localKey();
    if (!key) {
      const err = new Error('NO_KEY');
      err.code = 'NO_KEY';
      throw err;
    }
    try {
      return await askChatGPT(key, messages);
    } catch (err) {
      if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(err.message || '')) {
        throw new Error('ChatGPT는 브라우저에서 바로 부를 수 없습니다. node server.js 로 실행한 뒤 http://localhost:5500 에서 다시 질문해 주세요.');
      }
      throw err;
    }
  }

  function openKeyBox() {
    $('#keyInput').value = localKey();
    keyBox.hidden = false;
    $('#keyInput').focus();
  }

  function closeKeyBox() {
    keyBox.hidden = true;
  }

  detectProxy().then((ok) => {
    useProxy = ok;
    setConnected(proxyHasKey || Boolean(localKey()));
    loadUsage();
  });

  async function ask(text) {
    const question = String(text || '').trim();
    if (!question || busy) return;

    if (Shell.loadEntitlements) await Shell.loadEntitlements();
    const ai = Shell.getEntitlements ? Shell.getEntitlements().ai : null;
    if (ai && ai.limit != null && Number(ai.remaining) <= 0) {
      const label = ai.periodLabel || '오늘';
      log.insertAdjacentHTML(
        'beforeend',
        botBlock(`${label} AI 선생님 이용 횟수 ${ai.limit}회를 모두 사용했습니다. 이용권을 확인해 주세요.`, false, 'is-error')
      );
      log.lastElementChild.scrollIntoView({ block: 'end', behavior: 'smooth' });
      return;
    }

    history.push({ role: 'user', content: question });
    log.insertAdjacentHTML('beforeend', userBlock(question));
    log.insertAdjacentHTML('beforeend', botBlock('ChatGPT에게 묻는 중입니다...', false, 'is-pending'));
    const pending = log.querySelector('.msg--bot:last-of-type .msg__bubble');
    log.lastElementChild.scrollIntoView({ block: 'end', behavior: 'smooth' });
    $('#askInput').value = '';
    setBusy(true);

    try {
      const answer = await askModel(history.slice(-12));
      history.push({ role: 'assistant', content: answer });
      pending.classList.remove('is-pending');
      pending.innerHTML = toHtml(answer);
    } catch (err) {
      history.pop();
      pending.classList.remove('is-pending');
      pending.classList.add('is-error');
      if (err.code === 'NO_KEY' || err.message === 'NO_KEY') {
        pending.innerHTML =
          '정확한 정답을 받으려면 ChatGPT에 연결해야 합니다. Supabase Dashboard → Edge Functions → Secrets에 <code>OPENAI_API_KEY</code>를 등록하고 <code>ask-ai</code> 함수를 배포해 주세요.';
        openKeyBox();
      } else {
        pending.textContent = err.message || '답을 가져오지 못했습니다.';
      }
    } finally {
      setBusy(false);
      pending.scrollIntoView({ block: 'end', behavior: 'smooth' });
      $('#askInput').focus();
    }
  }

  $('#askForm').addEventListener('submit', (event) => {
    event.preventDefault();
    ask($('#askInput').value);
  });

  document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-chip]');
    if (chip) ask(chip.dataset.chip);
  });

  keyBtn.addEventListener('click', openKeyBox);
  $('#keyCancel').addEventListener('click', closeKeyBox);
  keyBox.addEventListener('click', (event) => {
    if (event.target === keyBox) closeKeyBox();
  });
  $('#keySave').addEventListener('click', () => {
    const key = $('#keyInput').value.trim();
    if (!key) {
      Shell.showToast('API 키를 입력해 주세요.');
      return;
    }
    if (!key.startsWith('sk-')) {
      Shell.showToast('ChatGPT API 키는 sk- 로 시작합니다. platform.openai.com에서 발급해 주세요.');
      return;
    }
    memoryKey = key;
    setConnected(true);
    closeKeyBox();
    Shell.showToast('이 탭에서만 ChatGPT 연결을 사용합니다. 가능하면 .env의 OPENAI_API_KEY를 쓰세요.');
  });
})();
