/* 오답노트 · 학습기록 — Supabase wrong_notes, 실패 시 서버 저장소. */

const WrongNotes = (() => {
  'use strict';

  let list = [];
  let boot = null;

  function ready() {
    if (!boot) {
      boot = AppApi.get('/api/wrong-notes')
        .then((data) => {
          list = Array.isArray(data.notes) ? data.notes : [];
        })
        .catch(() => {
          list = [];
        });
    }
    return boot;
  }

  const isSame = (item, subject, index) => item.subject === subject && item.index === index;

  async function add({ subject, index, topic, q, questionId, selectedAnswer }) {
    await ready();
    list = list.filter((item) => !isSame(item, subject, index));
    list.unshift({
      subject,
      index,
      topic,
      q,
      questionId: questionId || null,
      date: new Date().toISOString(),
    });
    try {
      const data = await AppApi.post('/api/wrong-notes', {
        subject,
        index,
        topic,
        q,
        questionId,
        selectedAnswer,
      });
      if (Array.isArray(data.notes)) list = data.notes;
    } catch {
      /* 화면은 유지 */
    }
  }

  async function remove(subject, index, questionId) {
    await ready();
    list = list.filter((item) => !isSame(item, subject, index));
    try {
      const data = await AppApi.del('/api/wrong-notes', { subject, index, questionId });
      list = Array.isArray(data.notes) ? data.notes : list;
    } catch {
      /* ignore */
    }
  }

  async function clear() {
    list = [];
    try {
      const data = await AppApi.del('/api/wrong-notes', { all: true });
      list = Array.isArray(data.notes) ? data.notes : [];
    } catch {
      /* ignore */
    }
  }

  function all() {
    return list.slice();
  }

  return { ready, add, remove, clear, all };
})();

const StudyLog = (() => {
  'use strict';

  let data = {};
  let remoteStats = null;
  let remoteGrades = null;
  let remoteWeakness = null;
  let boot = null;

  function mapRemoteStats(row) {
    if (!row || typeof row !== 'object') return null;
    if (row.attempted == null && row.studyDays == null && row.study_days == null) return null;
    return {
      attempted: Number(row.attempted) || 0,
      correct: Number(row.correct) || 0,
      rate: Number(row.rate) || 0,
      studyDays: Number(row.studyDays != null ? row.studyDays : row.study_days) || 0,
      streak: Number(row.streak) || 0,
    };
  }

  function mapRemoteGrades(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .map((row) => {
        if (!row) return null;
        const id = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(row.id || row.subjects) : row.id || row.subjects;
        if (!id) return null;
        const total = Number(row.total) || 0;
        const correct = Number(row.correct) || 0;
        const attempted = Number(row.attempted) || 0;
        const totalRate = Number(row.totalRate != null ? row.totalRate : row.rate) || 0;
        return {
          id,
          title: row.title || id,
          short: row.short || id,
          total,
          attempted,
          correct,
          rate: attempted ? Math.round((correct / attempted) * 100) : Number(row.rate) || 0,
          totalRate,
          difficulty: row.difficulty || 'empty',
        };
      })
      .filter(Boolean);
  }

  function mapRemoteWeakness(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .map((row) => {
        if (!row) return null;
        const id = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(row.subjectId || row.subjects) : row.subjectId || row.subjects;
        if (!id) return null;
        const areas = Array.isArray(row.areas)
          ? row.areas.map((area) => ({
              name: area.area || area.name || '',
              area: area.area || area.name || '',
              attempted: Number(area.attempted) || 0,
              correct: Number(area.correct) || 0,
              wrong: Number(area.wrong) || 0,
              wrongRate: Number(area.wrong_rate != null ? area.wrong_rate : area.wrongRate) || 0,
              sampleTopic: area.sample_topic || area.sampleTopic || '',
            })).filter((area) => area.area)
          : [];
        return {
          subjectId: id,
          headline: row.headline || id,
          analysis: row.analysis || '',
          drillTopic: row.drillTopic || row.drill_topic || '',
          drillLabel: row.drillLabel || row.drill_label || '',
          areas,
        };
      })
      .filter((row) => row && (row.analysis || (row.areas && row.areas.length)));
  }

  function ready() {
    if (!boot) {
      boot = (async () => {
        try {
          const onPages = typeof Cloud !== 'undefined' && Cloud.isPages && Cloud.isPages();
          if (!onPages && typeof AppApi !== 'undefined' && typeof QUESTION_BANK === 'object') {
            const ids = Object.keys(QUESTION_BANK);
            await Promise.all(
              ids.map(async (id) => {
                try {
                  const data = await AppApi.getQuestions(id);
                  if (Array.isArray(data.questions) && data.questions.length) {
                    QUESTION_BANK[id].questions = data.questions;
                  }
                } catch {
                  /* 과목별 원격 로드 실패 시 로컬 유지 */
                }
              })
            );
          }
        } catch {
          /* 국어 원격 로드 실패 시 빈 목록 유지 */
        }
        try {
          const res = await AppApi.get('/api/study-log');
          data = res.log && typeof res.log === 'object' ? res.log : {};
          data = applyAnswers(data, res.answers);
          remoteStats = mapRemoteStats(res.stats);
          remoteGrades = mapRemoteGrades(res.grades);
          remoteWeakness = mapRemoteWeakness(res.weakness);
        } catch {
          data = {};
          remoteStats = null;
          remoteGrades = null;
          remoteWeakness = null;
        }
      })();
    }
    return boot;
  }

  function load() {
    return data;
  }

  function applyAnswers(log, answers) {
    if (!Array.isArray(answers) || !answers.length) return log || {};
    const next = { ...(log || {}) };
    answers.forEach((row) => {
      const subject = typeof AppApi !== 'undefined' ? AppApi.resolveSubjectId(row.subjects) : '';
      const bank = typeof QUESTION_BANK === 'object' && subject ? QUESTION_BANK[subject] : null;
      if (!bank || !Array.isArray(bank.questions)) return;
      const index = bank.questions.findIndex((item) => Number(item.id) === Number(row.question_id));
      if (index < 0) return;
      if (!next[subject]) next[subject] = {};
      next[subject][String(index)] = {
        topic: row.type || '',
        correct: !!row.is_correct,
        date: row.answered_at || new Date().toISOString(),
      };
    });
    return next;
  }

  async function record({ subject, index, topic, correct, questionId, selectedAnswer, responseTime }) {
    await ready();
    if (!data[subject]) data[subject] = {};
    const prev = data[subject][String(index)];
    data[subject][String(index)] = {
      topic,
      correct: !!correct,
      date: new Date().toISOString(),
    };
    try {
      const res = await AppApi.post('/api/study-log', {
        subject,
        index,
        topic,
        correct,
        questionId,
        selectedAnswer,
        responseTime,
      });
      if (res.log) data = res.log;
      data = applyAnswers(data, res.answers);
      if (res.stats) remoteStats = mapRemoteStats(res.stats);
      if (res.grades) remoteGrades = mapRemoteGrades(res.grades);
      if (res.weakness) remoteWeakness = mapRemoteWeakness(res.weakness);
      return res;
    } catch (err) {
      if (err.status === 429) {
        if (prev) data[subject][String(index)] = prev;
        else delete data[subject][String(index)];
      }
      throw err;
    }
  }

  function forSubject(subject) {
    return load()[subject] || {};
  }

  function all() {
    return load();
  }

  function rateOf(correct, attempted) {
    return attempted ? Math.round((correct / attempted) * 100) : 0;
  }

  function topicStats(subjectId) {
    const bank = typeof QUESTION_BANK !== 'undefined' ? QUESTION_BANK[subjectId] : null;
    if (!bank) return [];

    const log = forSubject(subjectId);
    const order = [];
    const map = new Map();

    bank.questions.forEach((item, index) => {
      if (!map.has(item.topic)) {
        const row = { topic: item.topic, total: 0, attempted: 0, correct: 0 };
        map.set(item.topic, row);
        order.push(row);
      }
      const row = map.get(item.topic);
      row.total += 1;
      const attempt = log[String(index)];
      if (attempt) {
        row.attempted += 1;
        if (attempt.correct) row.correct += 1;
      }
    });

    return order.map((row) => ({
      ...row,
      rate: rateOf(row.correct, row.attempted),
      totalRate: rateOf(row.correct, row.total),
    }));
  }

  function subjectStats() {
    const bank = typeof QUESTION_BANK !== 'undefined' ? QUESTION_BANK : {};
    const local = Object.keys(bank).map((id) => {
      const log = forSubject(id);
      const total = bank[id].questions.length;
      let attempted = 0;
      let correct = 0;
      Object.values(log).forEach((item) => {
        attempted += 1;
        if (item.correct) correct += 1;
      });
      return {
        id,
        title: bank[id].title,
        short: bank[id].short,
        total,
        attempted,
        correct,
        rate: rateOf(correct, attempted),
        totalRate: rateOf(correct, total),
        difficulty: !total ? 'empty' : rateOf(correct, total) >= 70 ? 'high' : rateOf(correct, total) >= 60 ? 'mid' : 'low',
      };
    });
    if (!remoteGrades || !remoteGrades.length) return local;
    const byId = new Map(local.map((row) => [row.id, row]));
    return remoteGrades.map((row) => {
      const fallback = byId.get(row.id) || {};
      return {
        id: row.id,
        title: fallback.title || row.title,
        short: fallback.short || row.short,
        total: row.total,
        attempted: row.attempted,
        correct: row.correct,
        rate: row.rate,
        totalRate: row.totalRate,
        difficulty: row.difficulty || fallback.difficulty || 'empty',
      };
    });
  }

  function overview() {
    const log = load();
    const attempts = [];
    Object.values(log).forEach((byIndex) => {
      Object.values(byIndex).forEach((item) => attempts.push(item));
    });

    const attempted = attempts.length;
    const correct = attempts.filter((item) => item.correct).length;
    const rate = rateOf(correct, attempted);

    const pad = (n) => String(n).padStart(2, '0');
    const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const shiftDay = (key, days) => {
      const [year, month, day] = key.split('-').map(Number);
      return dayKey(new Date(year, month - 1, day + days));
    };

    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const recent = attempts.filter((item) => now - new Date(item.date).getTime() <= week);
    const older = attempts.filter((item) => {
      const age = now - new Date(item.date).getTime();
      return age > week && age <= week * 2;
    });
    let delta = null;
    if (recent.length && older.length) {
      delta =
        rateOf(recent.filter((item) => item.correct).length, recent.length) -
        rateOf(older.filter((item) => item.correct).length, older.length);
    }

    const days = [
      ...new Set(
        attempts
          .map((item) => {
            const date = new Date(item.date);
            return Number.isNaN(date.getTime()) ? null : dayKey(date);
          })
          .filter(Boolean)
      ),
    ].sort();

    let streak = 0;
    if (days.length) {
      const today = dayKey(new Date());
      const last = days[days.length - 1];
      if (last === today || last === shiftDay(today, -1)) {
        let expected = last;
        for (let i = days.length - 1; i >= 0; i -= 1) {
          if (days[i] !== expected) break;
          streak += 1;
          expected = shiftDay(expected, -1);
        }
      }
    }

    return remoteStats
      ? { attempted: remoteStats.attempted, correct: remoteStats.correct, rate: remoteStats.rate, delta, studyDays: remoteStats.studyDays, streak: remoteStats.streak }
      : { attempted, correct, rate, delta, studyDays: days.length, streak };
  }

  function topicKey(value) {
    return String(value || '').replace(/\s+/g, '');
  }

  function topicMatches(itemTopic, wanted) {
    const topic = topicKey(itemTopic);
    const name = topicKey(wanted);
    if (!topic || !name) return false;
    if (topic === name) return true;
    const family = topicKey(String(itemTopic).split('·')[0]);
    if (family === name || topic === topicKey(wanted.split('·')[0])) return true;
    return name.length >= 2 && (topic.includes(name) || name.includes(topic));
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

  function drillIndices(subjectId, topic, limit = 5) {
    const bank = typeof QUESTION_BANK !== 'undefined' ? QUESTION_BANK[subjectId] : null;
    if (!bank || !topic) return [];
    const names = String(topic)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!names.length) return [];

    const pool = bank.questions
      .map((item, qi) => ({ item, qi }))
      .filter(({ item }) => names.some((name) => topicMatches(item.topic || item.type, name)))
      .map(({ qi }) => qi);

    return shuffle(pool).slice(0, Math.min(limit, pool.length));
  }

  function weaknessReports() {
    return Array.isArray(remoteWeakness) ? remoteWeakness.slice() : [];
  }

  return { ready, record, forSubject, all, topicStats, subjectStats, overview, drillIndices, weaknessReports };
})();
