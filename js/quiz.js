(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const SECONDS_PER_QUESTION = 90;
  const CIRCLED = ['①', '②', '③', '④', '⑤'];

  /* 탭별로 보여 줄 해설 섹션 */
  const TAB_SECTIONS = {
    all: ['answer', 'concept', 'detail', 'wrong', 'tips'],
    core: ['answer', 'concept', 'tips'],
    wrong: ['answer', 'wrong'],
  };

  const escapeHtml = Shell.escapeHtml;
  const showToast = Shell.showToast;

  const pad = (n) => String(n).padStart(2, '0');
  const formatTime = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
  const formatShort = (sec) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;

  const params = new URLSearchParams(location.search);
  const subjectId = AppApi.resolveSubjectId(params.get('subject') || 'korean') || 'korean';
  const drillTopic = params.get('topic') || '';
  const isDrillRequest = params.get('drill') === '1' && Boolean(drillTopic);

  Shell.init({ activeNav: isDrillRequest ? 'weakness' : 'home' });
  if (subjectId === 'history') document.body.classList.add('quiz-history');
  if (subjectId === 'korean') document.body.classList.add('quiz-korean');
  if (subjectId === 'english') document.body.classList.add('quiz-english');
  if (subjectId === 'adminlaw') document.body.classList.add('quiz-adminlaw');
  if (subjectId === 'adminsci') document.body.classList.add('quiz-adminsci');
  if (subjectId === 'peducation') document.body.classList.add('quiz-peducation');
  const subject = QUESTION_BANK[subjectId];

  if (!subject) {
    $('#questionText').textContent = '준비되지 않은 과목입니다. 메인 홈에서 다시 선택해 주세요.';
    $('#submitBtn').disabled = true;
    return;
  }

  if (!isDrillRequest) {
    const timerEl = $('#barTimerText');
    if (timerEl) timerEl.textContent = subjectId === 'history' ? '80:00' : '20:00';
  }

  let questions = subject.questions.slice();
  const bundledQuestions = questions.slice();
  let total = questions.length;
  let drillLimit = 5;
  let drillSet = null;
  let sessionSet = null;
  let sessionIndex = 0;
  let sessionCount = 1;
  let sessionRanges = [];

  /* ── 상태 ───────────────────────────────── */
  let picks = [];
  const aiOpened = new Set();
  const aiBack = [];
  let similarSet = null;
  let aiTab = 'all';
  let index = 0;
  let graded = false;
  let remaining = 0;
  let timerId;
  let questionShownAt = 0;

  const KIND_LABELS = ['기출문제', '기출변형', 'AI문제'];

  function questionKind(i) {
    if (inSimilarMode() || subjectId === 'ai') return 'AI문제';
    const fromDb = questions[i] && questions[i].kind;
    if (fromDb) return fromDb;
    return KIND_LABELS[((Number.isInteger(i) ? i : 0) % KIND_LABELS.length + KIND_LABELS.length) % KIND_LABELS.length];
  }

  function applyDrillChrome() {
    if (drillSet && drillSet.length) {
      const back = document.querySelector('.qbar__back');
      if (back) {
        back.href = 'weakness.html';
        back.setAttribute('aria-label', '약점 분석으로 돌아가기');
      }
    }
  }

  function itemKind(item) {
    const kind = String((item && item.kind) || '').trim();
    return kind || '기출문제';
  }

  function kindKey(kind) {
    return String(kind || '').replace(/\s+/g, '');
  }

  function kindSessionRule(kind) {
    if (subjectId === 'history') return { size: 50, minutes: 80 };
    const key = kindKey(kind);
    if (key === '기출변형' || key === 'AI모의고사' || key === 'AI문제') return { size: 25, minutes: 25 };
    return { size: 20, minutes: 20 };
  }

  function rebuildSessionRanges() {
    sessionRanges = [];
    const n = questions.length;
    let i = 0;
    while (i < n) {
      const kind = itemKind(questions[i]);
      const rule = kindSessionRule(kind);
      const limit = Math.min(i + rule.size, n);
      let j = i + 1;
      while (j < limit && itemKind(questions[j]) === kind) j += 1;
      const count = j - i;
      const minutes = Math.max(1, Math.round((count * rule.minutes) / rule.size));
      sessionRanges.push({ start: i, end: j, kind, minutes });
      i = j;
    }
    if (!sessionRanges.length) {
      sessionRanges.push({ start: 0, end: Math.max(n, 0), kind: '기출문제', minutes: 20 });
    }
  }

  function sessionSize() {
    const range = sessionRanges[sessionIndex];
    if (range) return Math.max(1, range.end - range.start);
    return kindSessionRule(itemKind(questions[0])).size;
  }

  function sessionSeconds() {
    const range = sessionRanges[sessionIndex];
    if (range && range.minutes) return range.minutes * 60;
    return kindSessionRule(itemKind(questions[0])).minutes * 60;
  }

  function isExamRun() {
    return Boolean(sessionSet && sessionSet.length) && !(drillSet && drillSet.length);
  }

  function sessionCountFromTotal() {
    if (!sessionRanges.length) rebuildSessionRanges();
    return Math.max(1, sessionRanges.length);
  }

  function clampSet(n) {
    const count = sessionCountFromTotal();
    if (!Number.isInteger(n) || n < 1) return 1;
    return Math.min(n, count);
  }

  function periodRange(setNo) {
    if (!sessionRanges.length) rebuildSessionRanges();
    const range = sessionRanges[clampSet(setNo) - 1];
    if (!range) return { start: 1, end: 1 };
    return { start: range.start + 1, end: range.end };
  }

  function sessionIndexForQuestion(qi) {
    if (!sessionRanges.length) rebuildSessionRanges();
    const idx = sessionRanges.findIndex((range) => qi >= range.start && qi < range.end);
    return idx >= 0 ? idx : 0;
  }

  function periodTitle(setNo) {
    return `${clampSet(setNo)}교시`;
  }

  function examUrl(setNo) {
    return `quiz.html?subject=${encodeURIComponent(subjectId)}&set=${clampSet(setNo)}`;
  }

  function syncSetInUrl() {
    if (!isExamRun()) return;
    const url = new URL(location.href);
    url.searchParams.set('subject', subjectId);
    url.searchParams.set('set', String(sessionIndex + 1));
    history.replaceState(null, '', `${url.pathname}${url.search}`);
  }

  function buildSession(setNo) {
    rebuildSessionRanges();
    sessionCount = sessionCountFromTotal();
    sessionIndex = clampSet(setNo) - 1;
    const range = sessionRanges[sessionIndex] || { start: 0, end: Math.min(20, questions.length) };
    sessionSet = [];
    for (let i = range.start; i < range.end; i += 1) sessionSet.push(i);
  }

  function requestedSet() {
    rebuildSessionRanges();
    if (params.has('q')) {
      const qParam = Number(params.get('q'));
      if (Number.isInteger(qParam) && qParam >= 0 && qParam < questions.length) {
        return sessionIndexForQuestion(qParam) + 1;
      }
    }
    const setParam = Number(params.get('set'));
    if (Number.isInteger(setParam) && setParam >= 1) return setParam;
    return 1;
  }

  function allottedSeconds(count) {
    if (isExamRun()) return sessionSeconds();
    return Math.max(count, 1) * SECONDS_PER_QUESTION;
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    if (isExamRun() || s < 3600) return formatShort(s);
    return formatTime(s);
  }

  function resetRunState() {
    total = questions.length;
    picks = new Array(total).fill(null);
    drillLimit = Math.min(Math.max(Number(params.get('limit')) || 5, 1), Math.max(total, 1));
    drillSet = isDrillRequest ? StudyLog.drillIndices(subjectId, drillTopic, drillLimit) : null;
    graded = false;

    if (isDrillRequest && drillSet && drillSet.length) {
      sessionSet = null;
      sessionIndex = 0;
      sessionCount = 1;
      index = drillSet[0];
      remaining = allottedSeconds(drillSet.length);
      applyDrillChrome();
      return;
    }

    buildSession(requestedSet());
    const qRaw = params.get('q');
    const qParam = qRaw === null || qRaw === '' ? NaN : Number(qRaw);
    index = Number.isInteger(qParam) && sessionSet.includes(qParam) ? qParam : sessionSet[0];
    remaining = allottedSeconds(sessionSet.length);
    syncSetInUrl();
    applyDrillChrome();
  }

  /* ── 렌더링 ─────────────────────────────── */
  function extractImgAlt(html) {
    const match = String(html || '').match(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["']/i);
    return (match && match[1].trim()) || '문제 자료';
  }

  function extractImgSrcs(html) {
    const out = [];
    const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = re.exec(String(html || '')))) {
      const src = String(match[1] || '').trim();
      if (src && !out.includes(src)) out.push(src);
    }
    return out;
  }

  function stripHtmlToText(html) {
    let text = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    let prev = '';
    while (text !== prev) {
      prev = text;
      text = text
        .replace(/<(u|ins|strong|b|em)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$2**')
        .replace(/<span\b[^>]*text-decoration\s*:\s*underline[^>]*>([\s\S]*?)<\/span>/gi, '**$1**');
    }
    return text
      .replace(/\*{2,}/g, '**')
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
      .replace(/&lsquo;|&rsquo;|&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function formatQuizHtml(text) {
    return escapeHtml(String(text || ''))
      .replace(/\*\*([^*]+)\*\*/g, '<u>$1</u>')
      .replace(/__([^_]+)__/g, '<u>$1</u>');
  }

  function toQuestionImageUrl(src) {
    const value = String(src || '').trim();
    if (!value) return '';
    const onPages = typeof Cloud !== 'undefined' && Cloud.isPages();
    if (onPages && /^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/api/question-image')) return value;
    const markers = ['/storage/v1/object/public/', '/storage/v1/object/sign/', '/storage/v1/object/authenticated/'];
    let rest = '';
    for (let i = 0; i < markers.length; i += 1) {
      const at = value.indexOf(markers[i]);
      if (at !== -1) {
        rest = value.slice(at + markers[i].length).split('?')[0];
        break;
      }
    }
    if (!rest) {
      if (/^https?:\/\//i.test(value)) return value;
      rest = value.replace(/^\/+/, '');
      if (rest.startsWith('question-images/')) rest = rest.slice('question-images/'.length);
    }
    const parts = rest.split('/').filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch (_) {
        return part;
      }
    });
    let bucket = 'question-images';
    let objectPath = parts.join('/');
    if (parts[0] === 'question-images' || parts[0] === 'question_images') {
      bucket = parts[0];
      objectPath = parts.slice(1).join('/');
    }
    if (!objectPath) return value;
    objectPath = objectPath.replace(/^(history\/60\/q42)(\.[a-z0-9]+)$/i, '$1v2$2');
    if (typeof Cloud !== 'undefined' && Cloud.isPages()) {
      return `https://oekdmpneohvcjcwrcudf.supabase.co/storage/v1/object/public/${bucket}/${objectPath
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')}`;
    }
    return `/api/question-image?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`;
  }

  function hasHangul(text) {
    return /[\uAC00-\uD7A3]/.test(text);
  }

  function isKoreanQuestionStem(text) {
    const head = String(text || '').trim();
    if (!head || head.length > 140 || !hasHangul(head)) return false;
    if (/\[(?:지문|주어진 문장|주어진 글|사례)\]|【(?:지문|주어진 문장|주어진 글|사례)】/.test(head)) return false;
    const hangul = (head.match(/[\uAC00-\uD7A3]/g) || []).length;
    const latin = (head.match(/[A-Za-z]/g) || []).length;
    if (latin >= 12 && latin > hangul) return false;
    if (/고르시오|고르면|것은\?|것은\.|가장 적절한|일치하는|일치하지|빈칸|밑줄|어법|제목|목적|주제|순서|위치|흐름|다음 글|다음 대화|다음 사례|다음 설명|주어진|설명으로|옳지 않은|옳은 것/.test(head)) return true;
    if (/[?？]$/.test(head)) return true;
    if (/다음과 같다[.。]?$/.test(head)) return true;
    return false;
  }

  function looksLikePassageList(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /^[○●•]/.test(t)
      || /^[ㄱㄴㄷㄹㅁㅂㅇ]\./.test(t)
      || /^\([가나다라마]\)/.test(t)
      || /(?:\n|\s)[○●•]/.test(t)
      || /(?:\n|\s)[ㄱㄴㄷㄹㅁㅂㅇ]\./.test(t)
      || /(?:\n|\s)\([가나다라마]\)/.test(t);
  }

  function isStemFragment(text) {
    const t = String(text || '').trim();
    if (!t || looksLikePassageList(t)) return false;
    if (t.length <= 80 && /에 대한$|에 관한$|관련하여$/.test(t)) return true;
    if (t.length <= 90 && /설명으로\s*(옳지 않은 것은|옳은 것은|옳은 것만을)/.test(t)) return true;
    if (/[?？]$|고르면$|고르시오$/.test(t) && isKoreanQuestionStem(t)) return true;
    return false;
  }

  const TRAILING_STEM =
    /((?:이에 대한 |다음 (?:사례|글|대화)에 대한 )설명으로 (?:옳은 것만을 모두 고르면|옳지 않은 것만을 모두 고르면|옳지 않은 것은|옳은 것은)\??)\s*$/;

  function formatPassageList(text) {
    let body = String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const circleMarks = body.match(/[○●•]/g) || [];
    if (circleMarks.length >= 2) {
      const lined = (body.match(/\n\s*[○●•]/g) || []).length + (/^[○●•]/.test(body) ? 1 : 0);
      if (lined < circleMarks.length) {
        body = body.replace(/\s*([○●•])/g, '\n$1').trim();
      }
    }
    const ganadaMarks = body.match(/[ㄱㄴㄷㄹㅁㅂㅇ]\./g) || [];
    if (ganadaMarks.length >= 2) {
      const lined = (body.match(/\n\s*[ㄱㄴㄷㄹㅁㅂㅇ]\./g) || []).length + (/^[ㄱㄴㄷㄹㅁㅂㅇ]\./.test(body) ? 1 : 0);
      if (lined < ganadaMarks.length) {
        body = body.replace(/\s*([ㄱㄴㄷㄹㅁㅂㅇ]\.)/g, '\n$1').trim();
      }
    }
    return body;
  }

  function stripLeadingPassageLabel(text) {
    let passage = String(text || '').trim();
    if (/^(?:\[지문\]|【지문】)\s*\n/.test(passage) && !/주어진|사례/.test(passage)) {
      passage = passage.replace(/^(?:\[지문\]|【지문】)\s*\n/, '').trim();
    }
    return passage;
  }

  function isPassageBody(text) {
    const body = String(text || '').trim();
    if (!body || body.length < 20) return false;
    if (looksLikePassageList(body)) return true;
    if (/\[(?:지문|주어진 문장|주어진 글|사례)\]|【(?:지문|주어진 문장|주어진 글|사례)】/.test(body)) return true;
    const hangul = (body.match(/[\uAC00-\uD7A3]/g) || []).length;
    const latin = (body.match(/[A-Za-z]/g) || []).length;
    if (latin >= 12 && latin > hangul) return true;
    return hangul >= 15;
  }

  function splitOnPassageMarker(text) {
    const src = String(text || '');
    const match = src.match(/(\[(?:지문|주어진 문장|주어진 글|사례)\]|【(?:지문|주어진 문장|주어진 글|사례)】)/);
    if (!match || !Number.isInteger(match.index)) {
      const plain = src.split(/\n\s*지문\s*\n/);
      if (plain.length >= 2) {
        return { stem: plain[0].trim(), passage: plain.slice(1).join('\n').trim() };
      }
      return null;
    }
    const stem = src.slice(0, match.index).trim();
    let passage = src.slice(match.index).trim();
    if (!stem || !passage || !hasHangul(stem)) return null;
    if (/^(?:\[지문\]|【지문】)\s*\n/.test(passage) && !/주어진|사례/.test(passage)) {
      passage = passage.replace(/^(?:\[지문\]|【지문】)\s*\n/, '').trim();
    }
    return { stem, passage };
  }

  function splitAfterKoreanStem(text) {
    const src = String(text || '');
    const match = src.match(/^([\s\S]{8,140}?(?:(?:고르시오|고르면)\s*[?？.。]?|것(?:은|을)\s*[?？]|[는은을]\s*[?？]|인가\s*[?？]|다음과 같다)[.。]?)\s+/);
    if (!match) return null;
    const stem = match[1].trim();
    const rest = src.slice(match[0].length).trim();
    if (!hasHangul(stem) || !isKoreanQuestionStem(stem) || !isPassageBody(rest) || isStemFragment(rest)) return null;
    return { stem, passage: stripLeadingPassageLabel(rest) };
  }

  function splitFirstLineStem(text) {
    const src = String(text || '');
    const match = src.match(/^([^\n]{8,140})\n+([\s\S]+)$/);
    if (!match) return null;
    const stem = match[1].trim();
    const rest = match[2].trim();
    if (!isKoreanQuestionStem(stem) || !isPassageBody(rest) || isStemFragment(rest)) return null;
    return { stem, passage: stripLeadingPassageLabel(rest) };
  }

  function splitQuestion(raw) {
    const images = extractImgSrcs(raw);
    const text = stripHtmlToText(raw).replace(/\r\n/g, '\n').trim();

    const marked = splitOnPassageMarker(text);
    if (marked) return { ...marked, images };

    const blocks = text.split(/\n\s*\n/);
    if (blocks.length >= 1) {
      const first = blocks[0].trim();
      const rest = blocks.slice(1).join('\n\n').trim();

      if (blocks.length >= 2 && isKoreanQuestionStem(first) && isPassageBody(rest)) {
        return { stem: first, passage: stripLeadingPassageLabel(rest), images };
      }

      const trailing = first.match(TRAILING_STEM);
      if (trailing && trailing.index >= 80) {
        const stem = trailing[1].trim();
        const lead = first.slice(0, trailing.index).trim();
        const passage = [lead, rest].filter(Boolean).join('\n\n');
        if (isPassageBody(passage) && !isStemFragment(lead) && !isStemFragment(passage)) {
          return { stem, passage: stripLeadingPassageLabel(passage), images };
        }
      }
    }

    const afterStem = splitAfterKoreanStem(text);
    if (afterStem) return { ...afterStem, images };

    const firstLine = splitFirstLineStem(text);
    if (firstLine) return { ...firstLine, images };
    return { stem: text, passage: '', images };
  }

  function renderQuestion() {
    const item = questions[index];
    const { stem, passage, images } = splitQuestion(item.q);

    const shownTotal = displayTotal();
    const pos = displayPos();

    $('#barSubject').textContent = subject.title;
    $('#barKind').textContent = questionKind(index);
    $('#barTopic').textContent = item.topic;
    questionShownAt = Date.now();
    $('#barCount').textContent = isExamRun()
      ? `${periodTitle(sessionIndex + 1)} ${pos + 1} / ${shownTotal}`
      : `문제 ${pos + 1} / ${shownTotal}`;
    $('#questionText').innerHTML = formatQuizHtml(stem);
    renderQuestionImage(item, images);
    const passageEl = $('#questionPassage');
    if (passageEl) {
      if (passage) {
        passageEl.hidden = false;
        passageEl.innerHTML = formatQuizHtml(formatPassageList(passage));
      } else {
        passageEl.hidden = true;
        passageEl.innerHTML = '';
      }
    }
    $('#progressBar').style.width = `${((pos + 1) / shownTotal) * 100}%`;
    document.title = isExamRun()
      ? `${subject.title} ${periodTitle(sessionIndex + 1)} ${pos + 1}/${shownTotal} · 공무원 AI`
      : `${subject.title} ${pos + 1}/${shownTotal} · 공무원 AI`;

    /* 한 번 답을 고르면 그 문항은 바로 채점되고 잠긴다 */
    const locked = graded || picks[index] !== null;

    const list = $('#optionList');
    list.innerHTML = item.options
      .map(
        (text, i) => `
      <label class="option" data-index="${i}">
        <input type="radio" name="answer" value="${i}" ${picks[index] === i ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        <span class="option__mark" aria-hidden="true"></span>
        <span class="option__text">${formatQuizHtml(stripHtmlToText(text))}</span>
      </label>`
      )
      .join('');

    list.classList.toggle('is-locked', locked);
    paintOptions();

    renderVerdict();
    renderAi();
    renderSimilarBox();
    renderAiBack();
    renderQuota();

    $('#prevBtn').disabled = pos === 0;
    $('#nextBtn').disabled = pos === shownTotal - 1;
    if ($('#submitBtn') && !graded) {
      $('#submitBtn').textContent = isExamRun() ? '이번 시간 제출' : '제출하기';
    }

    renderNav();
    pinQuizViewport();
  }

  let imageLoadGen = 0;

  function historyFallbackSrcs(i) {
    if (subjectId !== 'history') return [];
    const period = Math.floor(Math.max(0, i) / 50) + 1;
    if (period < 11) return [];
    const num = (Math.max(0, i) % 50) + 1;
    const padded = String(num).padStart(2, '0');
    const folder = 49 + period;
    return [
      `history/${folder}/q${padded}v2.png`,
      `history/${folder}/q${padded}.png`,
      `history/${folder}/stimulus_q${padded}.png`,
    ];
  }

  function imageSrcCandidates(item, extraSrcs) {
    const urls = [];
    const add = (value) => {
      const src = String(value || '').trim();
      if (!src || urls.includes(src)) return;
      urls.push(src);
    };
    const addResolved = (src) => {
      const proxy = toQuestionImageUrl(src);
      const paths = [];
      if (proxy.startsWith('/api/question-image')) {
        try {
          const parsed = new URL(proxy, location.origin);
          let objectPath = parsed.searchParams.get('path') || '';
          if (objectPath) {
            objectPath = objectPath.replace(/^(history\/60\/q42)(\.[a-z0-9]+)$/i, '$1v2$2');
            const folderMatch = objectPath.match(/^(history\/\d+)\/(?:q|stimulus_q)?0*(\d+)(?:v\d+)?(?:\.[a-z0-9]+)?$/i);
            if (folderMatch) {
              const padded = String(Number(folderMatch[2])).padStart(2, '0');
              paths.push(`${folderMatch[1]}/q${padded}v2.png`);
              paths.push(`${folderMatch[1]}/stimulus_q${padded}.png`);
            }
            paths.push(objectPath);
          }
        } catch (_) {
          /* ignore */
        }
      }
      const uniquePaths = paths.filter((item, i) => item && paths.indexOf(item) === i);
      uniquePaths.forEach((objectPath) => {
        add(`/api/question-image?bucket=question-images&path=${encodeURIComponent(objectPath)}`);
        add(
          `https://oekdmpneohvcjcwrcudf.supabase.co/storage/v1/object/public/question-images/${objectPath
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/')}`
        );
      });
      if (!uniquePaths.length) add(proxy);
    };
    (extraSrcs || []).forEach(addResolved);
    extractImgSrcs(item && item.q).forEach(addResolved);
    add(item && item.imageUrl);
    const raw = String((item && item.image_url) || '').trim();
    if (raw) addResolved(raw);
    historyFallbackSrcs(index).forEach(addResolved);
    return urls;
  }

  function renderQuestionImage(item, extraSrcs) {
    const wrap = $('#questionImage');
    const img = $('#questionImageEl');
    if (!wrap || !img) return;
    const gen = (imageLoadGen += 1);
    const candidates = imageSrcCandidates(item, extraSrcs);
    wrap.hidden = true;
    img.onload = null;
    img.onerror = null;
    if (!candidates.length) {
      img.removeAttribute('src');
      return;
    }
    const show = (src) => {
      if (gen !== imageLoadGen) return;
      wrap.hidden = false;
      img.alt = extractImgAlt(item && item.q);
    };
    const tryAt = (i) => {
      if (gen !== imageLoadGen) return;
      if (i >= candidates.length) {
        wrap.hidden = true;
        img.removeAttribute('src');
        return;
      }
      const src = candidates[i];
      img.onload = () => show(src);
      img.onerror = () => tryAt(i + 1);
      if (img.getAttribute('src') === src && img.complete && img.naturalWidth) {
        show(src);
        return;
      }
      img.alt = '문제 자료';
      img.src = src;
    };
    tryAt(0);
  }

  function pinQuizViewport() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const main = document.querySelector('.main');
    if (main) main.scrollTop = 0;
    const qmain = document.querySelector('.qmain');
    if (qmain) qmain.scrollTop = 0;
  }

  function resetPanelScrolls() {
    const body = document.querySelector('.qcard__body');
    if (body) body.scrollTop = 0;
    const aiBody = $('#aiBody');
    if (aiBody) aiBody.scrollTop = 0;
  }

  /* ── AI 해설 패널 ───────────────────────── */
  function splitExplainItems(body, numbered = false) {
    const text = String(body || '').trim();
    if (!text) return [];
    if (numbered) {
      const items = text.split(/(?=[①②③④⑤]\s*)/).map((part) => part.trim()).filter(Boolean);
      if (items.length > 1) return items;
    }
    return text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  }

  function parseExplain(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    const empty = { concept: [], detail: [], wrongItems: [], tips: [] };
    if (!raw) return empty;

    const labels = {
      '핵심개념': 'concept',
      '핵심 개념': 'concept',
      '자세한 해설': 'detail',
      '오답분석': 'wrongItems',
      '오답 분석': 'wrongItems',
      '시험장에서 기억할 포인트': 'tips',
      '시험장에서 기억': 'tips',
      '시험장 포인트': 'tips',
    };
    const labelAlt = Object.keys(labels).join('|');
    const heading = new RegExp(
      `(?:\\[(${labelAlt})\\]|【\\s*(${labelAlt})\\s*】|[●•·]\\s*(${labelAlt})|(?:^|\\n|\\|)\\s*(${labelAlt}))[:：]?\\s*`,
      'gm'
    );
    const matches = [...raw.matchAll(heading)];
    if (!matches.length) {
      return { ...empty, detail: splitExplainItems(raw) };
    }

    const parts = { concept: [], detail: [], wrongItems: [], tips: [] };
    matches.forEach((match, i) => {
      const key = labels[(match[1] || match[2] || match[3] || match[4] || '').trim()];
      if (!key) return;
      const start = match.index + match[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      parts[key].push(...splitExplainItems(raw.slice(start, end).replace(/^\s*\|\s*|\s*\|\s*$/g, ''), key === 'wrongItems'));
    });

    if (!parts.detail.length && !parts.concept.length && !parts.wrongItems.length) {
      parts.detail = splitExplainItems(raw);
    }
    return parts;
  }

  function bundledInfo(item) {
    const bank = (typeof AI_EXPLANATIONS === 'object' && AI_EXPLANATIONS[subjectId]) || [];
    const localIndex = bundledQuestions.findIndex((q) => q.q === item.q);
    if (localIndex >= 0 && bank[localIndex]) return bank[localIndex];
    return null;
  }

  function aiInfo(i) {
    const item = questions[i] || {};
    const bundled = bundledInfo(item) || {};
    const parsed = parseExplain(item.explain);
    const fallback = parsed.detail.length
      ? parsed.detail
      : item.explain
        ? [item.explain]
        : ['이 문항에 대한 해설을 준비 중입니다.'];

    return {
      concept: bundled.concept && bundled.concept.length ? bundled.concept : parsed.concept,
      detail: Array.isArray(bundled.detail) && bundled.detail.length ? bundled.detail : fallback,
      wrong: bundled.wrong && Object.keys(bundled.wrong).length ? bundled.wrong : {},
      wrongItems: parsed.wrongItems,
      tips: bundled.tips && bundled.tips.length ? bundled.tips : parsed.tips,
    };
  }

  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function questionTypeKey(item) {
    return String((item && (item.type || item.topic)) || '').replace(/\s+/g, '');
  }

  /* 같은 type 전체를 대상으로 클릭할 때마다 무작위로 뽑는다 */
  function similarIndices(origin, count, extraExclude = []) {
    const skip = new Set([origin, ...extraExclude]);
    const originType = questionTypeKey(questions[origin]);
    const pool = questions
      .map((q, qi) => qi)
      .filter((qi) => !skip.has(qi) && questionTypeKey(questions[qi]) === originType && originType);
    const picked = shuffle(pool).slice(0, count);
    if (picked.length || !extraExclude.length) return picked;
    return similarIndices(origin, count);
  }

  function similarExclude(i) {
    const extra = [];
    if (inSimilarMode()) extra.push(...similarSet.filter((qi) => qi !== i));
    if (aiBack.length) extra.push(aiBack[0].index);
    return extra;
  }

  function firstSimilarIndex(i) {
    const [qi] = similarIndices(i, 1, similarExclude(i));
    return Number.isInteger(qi) ? qi : null;
  }

  function renderSimilarBox() {
    const box = $('#similarBox');
    if (box) box.hidden = true;
    document.querySelector('.qmain')?.classList.remove('is-similar-open');
  }

  function renderQuota() {
    const el = $('#barQuota');
    if (!el || !Shell.getEntitlements) return;
    const quota = (Shell.getEntitlements().questions) || {};
    if (quota.unlimited || quota.limit == null) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = `오늘 ${Number(quota.usedPeriod) || 0}/${quota.limit}문제`;
  }

  function syncSimilarAccess() {
    const allowed = Shell.canFeature ? Shell.canFeature('similar') : false;
    const btn = $('#aiSimilarBtn');
    if (btn) btn.hidden = !allowed;
  }

  function guardSimilar() {
    if (Shell.canFeature && Shell.canFeature('similar')) return true;
    showToast(Shell.upgradeMessage ? Shell.upgradeMessage('similar') : '프리미엄 이용권에서 이용할 수 있습니다.');
    return false;
  }

  function inSimilarMode() {
    return Boolean(similarSet && similarSet.length && aiBack.length);
  }

  function inDrillMode() {
    return Boolean(drillSet && drillSet.length) && !inSimilarMode();
  }

  function activeSet() {
    if (inSimilarMode()) return similarSet;
    if (drillSet && drillSet.length) return drillSet;
    if (sessionSet && sessionSet.length) return sessionSet;
    return null;
  }

  function displayPos() {
    const set = activeSet();
    if (!set) return index;
    const pos = set.indexOf(index);
    return pos >= 0 ? pos : 0;
  }

  function displayTotal() {
    const set = activeSet();
    return set ? set.length : total;
  }

  function goNearby(dir) {
    const set = activeSet();
    if (set) {
      const nextPos = displayPos() + dir;
      if (nextPos < 0 || nextPos >= set.length) return;
      goTo(set[nextPos]);
      return;
    }
    goTo(index + dir);
  }

  function visibleIndices() {
    return activeSet() || questions.map((_, i) => i);
  }

  function stripWrongChoiceLabel(text) {
    return String(text || '').replace(/틀린 선택이 아니다[.。]?\s*/g, '').trim();
  }

  function sectionHtml(kind, title, items) {
    const list = (items || []).map((text) => {
      let value = String(text || '').trim();
      if (kind === 'wrong' && (subjectId === 'adminlaw' || subjectId === 'adminsci')) {
        value = stripWrongChoiceLabel(value);
      }
      return value;
    }).filter(Boolean);
    if (!list.length) return '';
    return `
      <section class="ai__sec ai__sec--${kind}">
        <h4 class="ai__sec-title">${title}</h4>
        <ul class="ai__list">${list.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>
      </section>`;
  }

  function renderAi() {
    const panel = $('#aiPanel');
    const open = aiOpened.has(index);

    panel.hidden = !open;
    document.querySelector('.qmain')?.classList.toggle('is-ai-open', open);
    $('#explainBtn').setAttribute('aria-pressed', String(open));
    if (!open) return;

    try {
      const item = questions[index];
      const info = aiInfo(index);
      const parts = TAB_SECTIONS[aiTab] || TAB_SECTIONS.all;
      const options = Array.isArray(item.options) ? item.options : [];
      const answerText = options[item.answer] || '';

      const wrongList = options
        .map((text, i) => ({ text, i }))
        .filter(({ i }) => i !== item.answer)
        .map(({ text, i }) => `${CIRCLED[i] || i + 1} ${text}: ${info.wrong[i] || '문제가 요구하는 조건과 맞지 않는 선택지입니다.'}`);

      let html = '';
      if (parts.includes('answer')) {
        html += `
        <p class="ai__answer">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.4l2.7 2.6L16 9.6" /></svg>
          정답: ${CIRCLED[item.answer] || ''} ${escapeHtml(answerText)}
        </p>`;
      }
      if (parts.includes('concept')) html += sectionHtml('concept', '핵심 개념', info.concept);
      if (parts.includes('detail')) html += sectionHtml('detail', '자세한 해설', info.detail);
      if (parts.includes('wrong')) {
        html += sectionHtml(
          'wrong',
          '오답 분석',
          info.wrongItems && info.wrongItems.length ? info.wrongItems : wrongList
        );
      }
      if (parts.includes('tips')) html += sectionHtml('tips', '시험장에서 기억할 포인트', info.tips);

      $('#aiMain').innerHTML = html || '<p class="ai__answer">해설을 준비 중입니다.</p>';
      if ($('#aiSide')) $('#aiSide').hidden = true;
      $('#aiBody').classList.add('is-wide');

      document.querySelectorAll('.ai__tab').forEach((tab) => {
        const active = tab.dataset.tab === aiTab;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      syncSimilarAccess();
    } catch (err) {
      console.error(err);
      $('#aiMain').innerHTML = '<p class="ai__answer">해설을 불러오지 못했습니다. 다시 한번 눌러 주세요.</p>';
    }
  }

  function paintOptions() {
    const item = questions[index];
    const revealed = graded || picks[index] !== null;

    document.querySelectorAll('.option').forEach((el) => {
      const i = Number(el.dataset.index);
      el.classList.remove('is-selected', 'is-correct', 'is-wrong');

      if (!revealed) {
        if (picks[index] === i) el.classList.add('is-selected');
        return;
      }
      if (i === item.answer) el.classList.add('is-correct');
      else if (picks[index] === i) el.classList.add('is-wrong');
    });
  }

  /* 선택 직후 정답/오답은 AI 해설과 다음 문제 사이에 표시 */
  function renderVerdict() {
    const el = $('#verdict');
    if (el) {
      el.hidden = true;
      el.innerHTML = '';
    }

    const result = $('#actionResult');
    if (!result) return;

    const pick = picks[index];
    const item = questions[index];
    if (pick === null || !item) {
      result.hidden = true;
      result.innerHTML = '';
      return;
    }

    const correct = pick === item.answer;
    result.className = `qactions__result ${correct ? 'is-correct' : 'is-wrong'}`;
    result.innerHTML = correct
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.4l2.7 2.6L16 9.6" /></svg>정답입니다`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>오답입니다`;
    result.hidden = false;
  }

  /* 답 선택: 즉시 채점하고 오답은 오답노트에 담는다 */
  async function choose(optionIndex) {
    if (graded || picks[index] !== null) return;
    if (Shell.canAnswerQuestion && !Shell.canAnswerQuestion()) {
      showToast(Shell.questionLimitMessage());
      return;
    }

    const item = questions[index];
    picks[index] = optionIndex;
    const correct = optionIndex === item.answer;

    const list = $('#optionList');
    list.classList.add('is-locked');
    list.querySelectorAll('input[name="answer"]').forEach((input) => {
      input.disabled = true;
    });
    paintOptions();
    renderVerdict();
    renderNav();
    pinQuizViewport();

    try {
      const res = await StudyLog.record({
        subject: subjectId,
        index,
        topic: item.topic,
        correct,
        questionId: item.id,
        selectedAnswer: optionIndex + 1,
        responseTime: questionShownAt ? Math.max(0, Date.now() - questionShownAt) : 0,
      });
      if (res && res.questions && Shell.setQuestionUsage) {
        Shell.setQuestionUsage(res.questions);
        renderQuota();
      }
    } catch (err) {
      if (err.status === 429) {
        picks[index] = null;
        if (err.data && err.data.questions && Shell.setQuestionUsage) {
          Shell.setQuestionUsage(err.data.questions);
        }
        showToast(err.message || Shell.questionLimitMessage());
        renderQuestion();
        return;
      }
    }

    if (correct) WrongNotes.remove(subjectId, index, item.id);
    else WrongNotes.add({
      subject: subjectId,
      index,
      topic: item.topic,
      q: item.q,
      questionId: item.id,
      selectedAnswer: optionIndex + 1,
    });
  }

  function renderNav() {
    const list = activeSet() || questions.map((_, i) => i);
    const done = list.filter((qi) => picks[qi] !== null).length;
    const exam = isExamRun() && !inSimilarMode();

    $('#navGrid').classList.toggle('is-similar', inSimilarMode());
    $('#navGrid').innerHTML = list
      .map((qi, di) => {
        const state = qi === index ? 'is-current' : picks[qi] !== null ? 'is-done' : '';
        const label = exam ? qi + 1 : di + 1;
        return `<button class="qdot ${state}" type="button" data-jump="${qi}"
                  aria-label="${label}번 문제${picks[qi] !== null ? ' (완료)' : ''}"
                  ${qi === index ? 'aria-current="true"' : ''}>${label}</button>`;
      })
      .join('');

    const sessionEl = $('#navSession');
    const periodEl = $('#navPeriod');
    const bankEl = $('#navBank');
    const selectEl = $('#navSetSelect');
    const prevSetBtn = $('#prevSetBtn');
    const nextTimeBtn = $('#navNextTime');

    const maxNo = exam ? list.reduce((max, qi) => Math.max(max, qi + 1), 0) : list.length;
    $('#navGrid').classList.toggle('is-wide-num', maxNo >= 100);
    $('#navGrid').classList.toggle('is-xl-num', maxNo >= 1000);

    if (bankEl) {
      bankEl.textContent = exam ? `전체 ${total}제` : `전체 ${list.length}제`;
    }

    if (periodEl) periodEl.hidden = !exam;

    if (exam) {
      const from = list[0] + 1;
      const to = list[list.length - 1] + 1;
      const setNo = sessionIndex + 1;
      if (sessionEl) sessionEl.textContent = `${periodTitle(setNo)} · ${from}–${to}번`;
      if (selectEl) {
        if (selectEl.childElementCount !== sessionCount) {
          selectEl.innerHTML = Array.from({ length: sessionCount }, (_, i) => {
            const n = i + 1;
            const range = periodRange(n);
            return `<button class="qnav__set" type="button" data-set="${n}" title="${n}교시 · ${range.start}–${range.end}번" aria-label="${n}교시 ${range.start}–${range.end}번">${n}</button>`;
          }).join('');
        }
        selectEl.querySelectorAll('.qnav__set').forEach((btn) => {
          const current = Number(btn.dataset.set) === setNo;
          btn.classList.toggle('is-current', current);
          btn.setAttribute('aria-current', current ? 'true' : 'false');
        });
      }
      if (prevSetBtn) prevSetBtn.disabled = sessionIndex === 0;
      if (nextTimeBtn) {
        const last = sessionIndex + 1 >= sessionCount;
        nextTimeBtn.disabled = last;
        nextTimeBtn.textContent = last ? '마지막' : '다음';
      }
    } else if (sessionEl) {
      sessionEl.textContent = '';
    }

    $('#navStat').textContent = `${done} / ${list.length} 완료`;
  }

  /* ── 타이머 ─────────────────────────────── */
  function tick() {
    remaining -= 1;
    $('#barTimerText').textContent = formatClock(Math.max(remaining, 0));
    $('#barTimer').classList.toggle('is-urgent', remaining <= (isExamRun() ? 120 : 60));

    if (remaining <= 0) {
      stopTimer();
      grade(true);
    }
  }

  function startTimer() {
    $('#barTimerText').textContent = formatClock(remaining);
    clearInterval(timerId);
    timerId = setInterval(tick, 1000);
  }

  function stopTimer() { clearInterval(timerId); }

  /* ── 이동 ───────────────────────────────── */
  function goTo(next) {
    index = Math.min(Math.max(next, 0), total - 1);
    renderQuestion();
    resetPanelScrolls();
  }

  function jumpSimilar(qi) {
    const next = Number(qi);
    if (!Number.isInteger(next) || next < 0 || next >= total || next === index) return;
    const originIndex = aiBack.length ? aiBack[0].index : index;
    const set = similarIndices(originIndex, 3, similarExclude(index));
    similarSet = [next, ...set.filter((i) => i !== next)].slice(0, 3);
    aiOpened.delete(index);
    if (!aiBack.length) {
      aiBack.push({ index, tab: aiTab === 'similar' ? 'all' : aiTab });
    }
    aiTab = 'all';
    goTo(next);
    showToast('유사문제입니다. 푼 뒤 원래 문제로 돌아갈 수 있습니다.');
  }

  function openSimilarQuestion() {
    const qi = firstSimilarIndex(index);
    if (qi == null) {
      showToast('비슷한 문제를 찾지 못했습니다.');
      return;
    }
    jumpSimilar(qi);
  }

  function restoreSessionForIndex(qi) {
    if (!sessionSet || !sessionSet.length) return;
    if (sessionSet.includes(qi)) return;
    buildSession(sessionIndexForQuestion(qi) + 1);
    syncSetInUrl();
  }

  function returnToAi() {
    if (!aiBack.length) return;
    const origin = aiBack[0];
    aiBack.length = 0;
    similarSet = null;
    aiOpened.delete(origin.index);
    aiTab = origin.tab || 'all';
    restoreSessionForIndex(origin.index);
    goTo(origin.index);
  }

  function renderAiBack() {
    const bar = $('#aiBackBar');
    const btn = $('#aiBackBtn');
    if (aiBack.length) {
      const origin = aiBack[aiBack.length - 1];
      const onOrigin = index === origin.index;
      const solved = picks[index] !== null;
      bar.hidden = false;
      btn.textContent = '원래 문제로 돌아가기';
      $('#aiBackText').textContent = onOrigin
        ? '원래 문제로 돌아왔습니다. AI 해설을 다시 열어 보세요.'
        : solved
          ? '유사문제를 풀었습니다. 원래 문제로 돌아갈 수 있습니다.'
          : '유사문제를 풀고 있습니다.';
      return;
    }
    if (drillSet && drillSet.length) {
      bar.hidden = false;
      btn.textContent = '약점 분석으로 돌아가기';
      $('#aiBackText').textContent = '약점 집중 훈련을 풀고 있습니다.';
      return;
    }
    bar.hidden = true;
  }

  /* ── 채점 ───────────────────────────────── */
  function grade(auto = false) {
    const list = visibleIndices();
    const unanswered = list.filter((i) => picks[i] === null).length;
    if (!auto && unanswered > 0 && !confirm(`아직 풀지 않은 문제가 ${unanswered}개 있습니다. 제출하시겠습니까?`)) return;

    stopTimer();
    graded = true;
    list.forEach((i) => aiOpened.add(i));

    const correct = list.reduce((sum, i) => sum + (picks[i] === questions[i].answer ? 1 : 0), 0);
    const spent = allottedSeconds(list.length) - Math.max(remaining, 0);
    const exam = isExamRun();

    $('#resultSubject').textContent = subject.title;
    $('#resultTitle').textContent = exam ? `${periodTitle(sessionIndex + 1)} 채점 결과` : '채점 결과';
    $('#scoreValue').textContent = Math.round((correct / list.length) * 100);
    $('#scoreCorrect').textContent = `${correct} / ${list.length}`;
    $('#scoreTime').textContent = formatShort(spent);

    const retryBtn = $('#retryBtn');
    if (retryBtn) retryBtn.textContent = exam ? '이번 시간 다시' : '다시 풀기';

    const nextBtn = $('#nextSetBtn');
    if (nextBtn) {
      const hasNext = exam && sessionIndex + 1 < sessionCount;
      nextBtn.hidden = !hasNext;
      if (hasNext) nextBtn.textContent = `다음 시간 · ${periodTitle(sessionIndex + 2)}`;
    }

    const wrong = list
      .map((i) => ({ item: questions[i], i, no: exam ? i + 1 : list.indexOf(i) + 1 }))
      .filter(({ item, i }) => picks[i] !== item.answer);

    $('#reviewCount').textContent = wrong.length ? `${wrong.length}문항` : '';
    $('#reviewList').innerHTML = wrong.length
      ? wrong
          .map(
            ({ item, i, no }) => `
        <li class="review__item">
          <p class="review__q">${no}. ${formatQuizHtml(stripHtmlToText(item.q))}</p>
          <p class="review__answers">
            <span class="review__mine">내 답: <b>${picks[i] === null ? '무응답' : formatQuizHtml(stripHtmlToText(item.options[picks[i]]))}</b></span>
            <span class="review__right">정답: <b>${formatQuizHtml(stripHtmlToText(item.options[item.answer]))}</b></span>
          </p>
          <p class="review__explain">${escapeHtml(item.explain)}</p>
        </li>`
          )
          .join('')
      : '<li class="review__empty">모든 문제를 맞혔습니다. 훌륭합니다!</li>';

    $('#result').hidden = false;
    $('#submitBtn').disabled = true;
    $('#retryBtn').focus();

    if (auto) showToast('시간이 종료되어 자동 제출되었습니다.');
    else if (exam && sessionIndex + 1 >= sessionCount) showToast('모든 시간을 마쳤습니다.');
  }

  function retry() {
    const list = visibleIndices();
    list.forEach((i) => { picks[i] = null; });
    aiOpened.clear();
    aiBack.length = 0;
    similarSet = null;
    aiTab = 'all';
    index = list[0];
    graded = false;
    remaining = allottedSeconds(list.length);
    $('#result').hidden = true;
    $('#submitBtn').disabled = false;
    renderQuestion();
    startTimer();
    showToast(isExamRun() ? '이번 시간을 다시 시작합니다.' : '처음부터 다시 시작합니다.');
  }

  function goToSession(setNo) {
    const next = clampSet(setNo);
    if (next === sessionIndex + 1) return;
    const hasProgress = sessionSet && sessionSet.some((i) => picks[i] !== null);
    if (!graded && hasProgress && !confirm(`${periodTitle(next)}로 이동할까요? 이번 시간 타이머는 다시 시작됩니다.`)) {
      return;
    }
    location.href = examUrl(next);
  }

  /* ── 이벤트 ─────────────────────────────── */
  $('#optionList').addEventListener('mousedown', (event) => {
    if (event.target.closest('.option')) event.preventDefault();
  });
  $('#optionList').addEventListener('change', (event) => {
    const input = event.target;
    if (input && typeof input.blur === 'function') input.blur();
    choose(Number(input.value));
  });

  $('#prevBtn').addEventListener('click', () => goNearby(-1));
  $('#nextBtn').addEventListener('click', () => {
    const set = activeSet();
    const nextPos = displayPos() + 1;
    const nextIndex = set && nextPos >= 0 && nextPos < set.length ? set[nextPos] : index + 1;
    aiOpened.delete(index);
    if (Number.isInteger(nextIndex)) aiOpened.delete(nextIndex);
    goNearby(1);
  });
  $('#submitBtn').addEventListener('click', () => grade(false));
  $('#retryBtn').addEventListener('click', retry);

  const nextSetBtn = $('#nextSetBtn');
  if (nextSetBtn) {
    nextSetBtn.addEventListener('click', () => {
      location.href = examUrl(sessionIndex + 2);
    });
  }

  const navSetSelect = $('#navSetSelect');
  if (navSetSelect) {
    navSetSelect.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-set]');
      if (btn) goToSession(Number(btn.dataset.set));
    });
  }

  const prevSetBtn = $('#prevSetBtn');
  if (prevSetBtn) {
    prevSetBtn.addEventListener('click', () => goToSession(sessionIndex));
  }

  const navNextTime = $('#navNextTime');
  if (navNextTime) {
    navNextTime.addEventListener('click', () => goToSession(sessionIndex + 2));
  }

  /* AI 해설 열기 · 닫기 */
  $('#explainBtn').addEventListener('click', () => {
    if (aiOpened.has(index)) {
      aiOpened.delete(index);
      renderAi();
      renderSimilarBox();
      return;
    }

    aiOpened.add(index);
    renderAi();
    renderSimilarBox();
    pinQuizViewport();
    const aiBody = $('#aiBody');
    if (aiBody) aiBody.scrollTop = 0;
  });

  $('#aiBackBtn').addEventListener('click', () => {
    if (aiBack.length) {
      returnToAi();
      return;
    }
    if (drillSet && drillSet.length) location.href = 'weakness.html';
  });

  $('#aiCloseBtn').addEventListener('click', () => {
    aiOpened.delete(index);
    renderAi();
    renderSimilarBox();
    pinQuizViewport();
  });

  /* 해설 탭 전환 · 유사 문제 바로 풀기 */
  $('#aiSimilarBtn').addEventListener('click', () => {
    if (!guardSimilar()) return;
    openSimilarQuestion();
  });

  $('#aiPanel').addEventListener('click', (event) => {
    if (event.target.closest('#aiSimilarBtn')) return;
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      aiTab = tab.dataset.tab || 'all';
      if (aiTab === 'similar') {
        if (!guardSimilar()) {
          aiTab = 'all';
          renderAi();
          return;
        }
        openSimilarQuestion();
        return;
      }
      renderAi();
      return;
    }

    const jump = event.target.closest('[data-goto]');
    if (jump) {
      if (!guardSimilar()) return;
      jumpSimilar(Number(jump.dataset.goto));
    }
  });

  $('#similarBox').addEventListener('click', (event) => {
    const jump = event.target.closest('[data-goto]');
    if (jump) {
      if (!guardSimilar()) return;
      jumpSimilar(Number(jump.dataset.goto));
    }
  });

  $('#navGrid').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-jump]');
    if (btn) goTo(Number(btn.dataset.jump));
  });

  $('#reviewBtn').addEventListener('click', () => {
    $('#result').hidden = true;
    goTo(visibleIndices()[0]);
    showToast('정답과 해설을 문제마다 확인할 수 있습니다.');
  });

  /* 단축키: 1~4 선택, ←/→ 이동, Esc 닫기 */
  document.addEventListener('keydown', (event) => {
    if (!$('#result').hidden) {
      if (event.key === 'Escape') $('#result').hidden = true;
      return;
    }
    if (!questions.length) return;
    if (event.key === 'ArrowLeft') { goNearby(-1); return; }
    if (event.key === 'ArrowRight') { goNearby(1); return; }

    const n = Number(event.key);
    if (n >= 1 && n <= questions[index].options.length) choose(n - 1);
  });

  async function boot() {
    $('#questionText').textContent = '문제를 불러오는 중입니다.';
    if (Shell.loadEntitlements) await Shell.loadEntitlements();
    if (isDrillRequest && Shell.canFeature && !Shell.canFeature('weakness')) {
      showToast(Shell.upgradeMessage('weakness'));
      location.href = 'billing.html';
      return;
    }
    syncSimilarAccess();
    renderQuota();
    try {
      const data = await AppApi.getQuestions(subjectId);
      if (Array.isArray(data.questions) && data.questions.length) {
        questions = data.questions;
        if (QUESTION_BANK[subjectId]) QUESTION_BANK[subjectId].questions = questions;
      }
    } catch (err) {
      if (!questions.length) {
        $('#questionText').textContent = err.message || 'Supabase에서 문제를 불러오지 못했습니다.';
        $('#submitBtn').disabled = true;
        return;
      }
      showToast('원격 문제를 불러오지 못해 기본 문제를 사용합니다.');
    }

    if (!questions.length) {
      $('#questionText').textContent = `${subject.title} 문제가 아직 없습니다. 해당 과목 문항만 표시됩니다.`;
      $('#submitBtn').disabled = true;
      return;
    }

    resetRunState();
    renderQuestion();
    startTimer();
    if (drillSet && drillSet.length) {
      const names = String(drillTopic).split(',').map((part) => part.trim()).filter(Boolean);
      const label = names.length > 1 ? `${names[0]}와 ${names[1]}` : names[0] || drillTopic;
      showToast(`${label} 집중 훈련 ${drillSet.length}문제입니다.`);
    }
  }

  boot();
})();
