/* 나의 약점 분석: 틀린 문항 요약 · AI 분석 · 집중 훈련 5문제 */

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = Shell.escapeHtml;
  const DRILL_COUNT = 5;
  const KOREAN_AREAS = ['작문', '독해', '논리', '화법', '문학', '문법'];

  Shell.init({ activeNav: 'weakness' });
  Shell.requireFeature('weakness');

  function topicFamily(topic) {
    return String(topic).split('·')[0].trim();
  }

  function topicShort(topic) {
    const parts = String(topic).split('·').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] || topic;
  }

  function hasJong(text) {
    const ch = text[text.length - 1];
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return false;
    return (code - 0xac00) % 28 !== 0;
  }

  function koreanArea(type) {
    const text = String(type || '').trim();
    if (!text) return '';
    const prefix = text.match(/^(작문|독해|논리|화법|문학|문법)(?=\s*[:·\-\/]|$)/);
    if (prefix) return prefix[1];
    const found = KOREAN_AREAS.find((area) => text.includes(area));
    if (found) return found;
    return text.split(/[:·\/]/)[0].trim();
  }

  function questionType(index, fallback) {
    const bank = QUESTION_BANK.korean;
    const item = bank && Array.isArray(bank.questions) ? bank.questions[Number(index)] : null;
    return String((item && (item.type || item.topic)) || fallback || '').trim();
  }

  function uniqueNames(topics) {
    const names = [];
    topics.forEach((topic) => {
      const name = topicShort(topic);
      if (name && !names.includes(name)) names.push(name);
    });
    return names.slice(0, 2);
  }

  function joinAreas(names) {
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    return `${names[0]}${hasJong(names[0]) ? '과' : '와'} ${names[1]}`;
  }

  function analysisText(topics) {
    const names = uniqueNames(topics);
    if (!names.length) return '아직 특정 영역의 오답 패턴이 충분하지 않습니다.';
    return `${joinAreas(names)} 영역에서 오답률이 높습니다.`;
  }

  function drillLabelFor(names) {
    return `${joinAreas(names)} 문제 ${DRILL_COUNT}개 풀기`;
  }

  function koreanAnalysisText(areas) {
    return analysisText(areas.map((row) => row.name));
  }

  function drillHref(subjectId, topic) {
    const query = new URLSearchParams({
      subject: subjectId,
      drill: '1',
      topic,
      limit: String(DRILL_COUNT),
    });
    return `quiz.html?${query.toString()}`;
  }

  function koreanReport(subject) {
    const log = StudyLog.forSubject('korean');
    const byArea = {};

    Object.entries(log).forEach(([index, item]) => {
      const type = questionType(index, item && item.topic);
      const area = koreanArea(type);
      if (!area) return;
      if (!byArea[area]) {
        byArea[area] = { name: area, attempted: 0, correct: 0, wrong: 0, sampleTopic: type || area };
      }
      byArea[area].attempted += 1;
      if (item.correct) byArea[area].correct += 1;
      else {
        byArea[area].wrong += 1;
        byArea[area].sampleTopic = type || area;
      }
    });

    const ranked = Object.values(byArea)
      .map((row) => ({
        ...row,
        wrongRate: row.attempted ? row.wrong / row.attempted : 0,
      }))
      .filter((row) => row.wrong > 0)
      .sort((a, b) => b.wrongRate - a.wrongRate || b.wrong - a.wrong);

    if (!ranked.length) return null;

    const top = ranked[0];
    const weakNames = ranked.slice(0, 2).map((row) => row.name);
    return {
      subjectId: 'korean',
      headline: subject.short,
      analysis: koreanAnalysisText(ranked.slice(0, 2)),
      drillTopic: weakNames.join(','),
      drillLabel: drillLabelFor(weakNames),
    };
  }

  function reports() {
    const remote = typeof StudyLog !== 'undefined' && StudyLog.weaknessReports ? StudyLog.weaknessReports() : [];
    if (Array.isArray(remote) && remote.length) return remote;

    return StudyLog.subjectStats()
      .map((subject) => {
        if (subject.id === 'korean') return koreanReport(subject);

        const topics = StudyLog.topicStats(subject.id)
          .map((row) => ({ ...row, wrong: row.attempted - row.correct, family: topicFamily(row.topic) }))
          .filter((row) => row.wrong > 0);
        if (!topics.length) return null;

        const familyWrong = {};
        topics.forEach((row) => {
          familyWrong[row.family] = (familyWrong[row.family] || 0) + row.wrong;
        });
        const [family, familyCount] = Object.entries(familyWrong).sort((a, b) => b[1] - a[1])[0];
        const weakTopics = [...topics].sort((a, b) => a.rate - b.rate || b.wrong - a.wrong);
        const weakNames = uniqueNames(weakTopics.slice(0, 2).map((row) => row.topic));

        return {
          subjectId: subject.id,
          headline: subject.short,
          analysis: analysisText(weakTopics.slice(0, 2).map((row) => row.topic)),
          drillTopic: weakNames.join(','),
          drillLabel: drillLabelFor(weakNames),
        };
      })
      .filter(Boolean);
  }

  function cardHtml(item, { recommended = false } = {}) {
    return `
      <article class="weak__report">
        ${recommended ? '<p class="weak__badge">추천 훈련</p>' : ''}
        <section class="weak__block">
          <h3 class="weak__block-title">AI 분석</h3>
          <div class="weak__analysis">
            <p class="weak__headline">${esc(item.headline)}</p>
            <p class="weak__block-text">${esc(item.analysis)}</p>
          </div>
        </section>
        <section class="weak__block">
          <h3 class="weak__block-title">약점 집중 훈련</h3>
          <a class="btn btn--primary weak__drill" href="${esc(drillHref(item.subjectId, item.drillTopic))}">${esc(item.drillLabel)}</a>
        </section>
      </article>`;
  }

  function render() {
    const list = reports();

    if (!list.length) {
      $('#weakList').innerHTML = `
        <p class="weak__empty">아직 틀린 문제가 없어 약점을 특정할 수 없습니다.<br />아래는 9급 국어에서 자주 보완하는 유형입니다.</p>
        ${cardHtml(
          {
            subjectId: 'korean',
            headline: '국어',
            analysis: '문법 영역에서 오답률이 높습니다.',
            drillTopic: '문법',
            drillLabel: `문법 문제 ${DRILL_COUNT}개 풀기`,
          },
          { recommended: true }
        )}`;
      return;
    }

    $('#weakList').innerHTML = list.map((item) => cardHtml(item)).join('');
  }

  async function boot() {
    await StudyLog.ready();
    const remote = typeof StudyLog !== 'undefined' && StudyLog.weaknessReports ? StudyLog.weaknessReports() : [];
    if (!(Array.isArray(remote) && remote.length) && QUESTION_BANK.korean && !QUESTION_BANK.korean.questions.length) {
      try {
        const data = await AppApi.getQuestions('korean');
        if (Array.isArray(data.questions) && data.questions.length && QUESTION_BANK.korean) {
          QUESTION_BANK.korean.questions = data.questions;
        }
      } catch {
        /* 원격 문항이 없어도 학습 기록으로 분석합니다. */
      }
    }
    render();
  }

  boot();
})();
