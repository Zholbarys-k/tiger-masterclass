/* Синхронный тест: один вопрос у всех, таймер, ожидание, рейтинг команд. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import { apiErrorMessage, escapeHtml, loaderBlock, notify, rankMedal } from "../ui.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const TICK_MS = 200;
const HEARTBEAT_MS = 9000;      // страховка, если версия состояния не долетела
const AFTER_ZERO_MIN_MS = 600;  // пауза перед проверкой смены фазы на сервере
const AFTER_ZERO_JITTER_MS = 900;

let tickTimer = null;
let refreshTimer = null;
let deadlineAt = 0;      // локальная метка конца фазы, мс
let phaseTotal = 0;      // длительность фазы, с
let zeroHandled = false;
let lastPhaseKey = "";
let zeroRetries = 0;

function clearTimers() {
  if (tickTimer) clearInterval(tickTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  tickTimer = null;
  refreshTimer = null;
}

function isVisible(root) {
  return root.isConnected && root.classList.contains("is-active");
}

/* ------------------------------------------------------------------ */
/* Блоки разметки                                                     */
/* ------------------------------------------------------------------ */
function timerHtml(quiz, labelKey) {
  const total = quiz.phase_seconds || 60;
  const left = quiz.remaining_seconds ?? total;
  const percent = total ? Math.min(100, Math.round((left / total) * 100)) : 0;
  const low = left <= 10 && !quiz.is_paused;

  return `
    <div class="qtimer ${low ? "is-low" : ""}" data-timer>
      <div class="qtimer__ring" style="--p:${percent}%" data-timer-ring>
        <span class="qtimer__value" data-timer-value>${quiz.is_paused ? "||" : left}</span>
      </div>
      <div class="qtimer__label">${escapeHtml(t(labelKey))}</div>
    </div>`;
}

function scoreStripHtml(data) {
  const progress = data.my_progress || { answered: 0, total: 0, correct: 0, points: 0 };
  const rank = data.standings?.my?.rank;
  return `
    <div class="quiz-score">
      <div class="quiz-score__item">
        <div class="quiz-score__value">${progress.answered}/${progress.total}</div>
        <div class="quiz-score__label">${escapeHtml(t("quiz.answered"))}</div>
      </div>
      <div class="quiz-score__item">
        <div class="quiz-score__value">${progress.correct}</div>
        <div class="quiz-score__label">${escapeHtml(t("quiz.correct"))}</div>
      </div>
      <div class="quiz-score__item">
        <div class="quiz-score__value">${progress.points}</div>
        <div class="quiz-score__label">${escapeHtml(t("quiz.your_points"))}</div>
      </div>
      ${data.team ? `
      <div class="quiz-score__item">
        <div class="quiz-score__value">${data.team.total_points}</div>
        <div class="quiz-score__label">${escapeHtml(t("quiz.team_score"))}</div>
      </div>` : ""}
      ${rank ? `
      <div class="quiz-score__item">
        <div class="quiz-score__value">${rankMedal(rank)}</div>
        <div class="quiz-score__label">${escapeHtml(t("quiz.your_rank"))}</div>
      </div>` : ""}
    </div>`;
}

function headHtml(data, labelKey) {
  const quiz = data.quiz;
  const live = quiz.phase === "question" || quiz.phase === "standings";
  const counter = live
    ? t("quiz.question_of", { n: quiz.current_number, total: quiz.questions_count })
    : t("quiz.total_questions", { total: quiz.questions_count });

  return `
    <div class="quiz-head">
      <div class="quiz-head__top">
        <div style="min-width:0">
          <h1 class="page__title" style="margin:0">🧠 <span>${escapeHtml(quiz.title || t("quiz.title"))}</span></h1>
          <div class="quiz-head__counter">${escapeHtml(counter)}</div>
        </div>
        ${live ? timerHtml(quiz, labelKey) : `
        <span class="badge ${quiz.is_open ? "badge--success" : "badge--danger"}">
          ${escapeHtml(quiz.is_open ? t("quiz.open") : t("quiz.closed"))}
        </span>`}
      </div>
      ${quiz.is_paused ? `<div class="qnotice qnotice--warn">⏸ ${escapeHtml(t("quiz.paused"))}</div>` : ""}
      ${scoreStripHtml(data)}
    </div>`;
}

function optionHtml(question, option, index, data) {
  const answer = question.my_answer;
  const revealed = question.correct_index !== undefined;
  const chosen = Boolean(answer) && answer.selected_index === index;

  const classes = ["option"];
  let mark = "";
  if (revealed && question.correct_index === index) {
    classes.push("is-correct");
    mark = "✓";
  }
  if (chosen) {
    if (revealed) {
      classes.push(answer.is_correct ? "is-correct" : "is-wrong");
      if (!answer.is_correct) mark = "✕";
    } else {
      classes.push("is-selected");
      mark = "●";
    }
  }

  return `
    <button type="button" class="${classes.join(" ")}" ${data.can_answer ? "" : "disabled"}
      data-option="${index}">
      <span class="option__key">${LETTERS[index] || index + 1}</span>
      <span class="option__text">${escapeHtml(option)}</span>
      <span class="option__mark">${mark}</span>
    </button>`;
}

function questionCardHtml(data) {
  const question = data.question;
  return `
    <article class="card question">
      <div class="question__head">
        <span class="question__num">${question.number}</span>
        <div class="grow">
          <div class="question__text">${escapeHtml(question.text)}</div>
          <div class="muted" style="font-size:.75rem">${question.points} ${escapeHtml(t("common.pts"))}</div>
        </div>
      </div>
      <div class="options">
        ${question.options.map((option, index) => optionHtml(question, option, index, data)).join("")}
      </div>
    </article>`;
}

function boardRowHtml(row, myTeamId) {
  const top = row.rank <= 3 ? `board-row--top${row.rank}` : "";
  const mine = row.team_id === myTeamId ? "is-mine" : "";
  return `
    <div class="board-row ${top} ${mine}">
      <div class="board-row__rank">${rankMedal(row.rank)}</div>
      <div style="min-width:0"><div class="board-row__name">${escapeHtml(row.name)}</div></div>
      <div class="board-row__points">${row.total_points}<small>${escapeHtml(t("common.pts"))}</small></div>
    </div>`;
}

function standingsHtml(data) {
  const standings = data.standings;
  if (!standings || !standings.rows.length) {
    return `<div class="card card--flat center muted">${escapeHtml(t("rating.empty"))}</div>`;
  }

  const myTeamId = store.user?.team_id ?? null;
  const rows = standings.rows.map((row) => boardRowHtml(row, myTeamId)).join("");
  const outside = standings.my && standings.my.rank > standings.rows.length
    ? boardRowHtml(standings.my, myTeamId)
    : "";

  return `
    <div class="card">
      <div class="spread">
        <h3 class="card__title">🏆 ${escapeHtml(t("quiz.standings_title"))}</h3>
        <span class="badge badge--info">${standings.total_ranked} ${escapeHtml(t("rating.teams_ranked"))}</span>
      </div>
      <div class="card__body board">${rows}${outside}</div>
    </div>`;
}

function myResultHtml(data) {
  if (!data.question) return "";
  const answer = data.question.my_answer;
  if (!answer) {
    return `<div class="qnotice qnotice--warn">⌛ ${escapeHtml(t("quiz.not_answered"))}</div>`;
  }
  return answer.is_correct
    ? `<div class="qnotice qnotice--ok">✅ ${escapeHtml(t("quiz.answer_correct", { points: answer.points }))}</div>`
    : `<div class="qnotice qnotice--bad">❌ ${escapeHtml(t("quiz.answer_wrong"))}</div>`;
}

function statsLineHtml(data) {
  const stats = data.question_stats;
  if (!stats) return "";
  const line = t("quiz.answered_teams", {
    answered: stats.answered_teams,
    total: stats.total_teams,
  });
  return `<div class="muted center" style="font-size:.82rem">${escapeHtml(line)} · ✅ ${stats.correct_teams}</div>`;
}

/* ------------------------------------------------------------------ */
/* Фазы                                                               */
/* ------------------------------------------------------------------ */
function idleHtml(quiz) {
  return `
    <div class="card card--accent center stack">
      <div style="font-size:2.4rem">⏳</div>
      <strong>${escapeHtml(t("quiz.waiting_start"))}</strong>
      <div class="muted">${escapeHtml(t("quiz.waiting_start_hint", {
        total: quiz.questions_count,
        seconds: quiz.question_seconds,
      }))}</div>
    </div>`;
}

function questionPhaseHtml(data) {
  const answered = Boolean(data.question?.answered);
  const waiting = answered
    ? `<div class="qnotice qnotice--ok">✅ ${escapeHtml(t("quiz.answer_accepted"))}
         <div class="muted" style="font-weight:400">${escapeHtml(t("quiz.waiting_others"))}</div>
       </div>`
    : "";

  let hint = "";
  if (data.can_answer) {
    hint = `<div class="muted center" style="font-size:.82rem">✍️ ${escapeHtml(t("quiz.leader_hint"))}</div>`;
  } else if (data.read_only) {
    hint = `<div class="muted center" style="font-size:.82rem">👀 ${escapeHtml(t("quiz.member_view_hint"))}</div>`;
  } else if (!answered) {
    hint = `<div class="muted center" style="font-size:.82rem">⌛ ${escapeHtml(t("quiz.time_over"))}</div>`;
  }

  return `${waiting}${data.question ? questionCardHtml(data) : ""}${hint}`;
}

function standingsPhaseHtml(data) {
  const quiz = data.quiz;
  const next = quiz.auto_advance
    ? `⏭ ${t("quiz.next_in", { seconds: quiz.remaining_seconds ?? 0 })}`
    : `⏸ ${t("quiz.waiting_admin")}`;

  return `
    ${myResultHtml(data)}
    ${data.question ? questionCardHtml(data) : ""}
    ${statsLineHtml(data)}
    ${standingsHtml(data)}
    <div class="center muted" style="font-size:.85rem" data-next-line>${escapeHtml(next)}</div>`;
}

function finishedHtml(data) {
  return `
    <div class="card card--accent center stack">
      <div style="font-size:2.4rem">🏁</div>
      <strong>${escapeHtml(t("quiz.final_title"))}</strong>
      <div class="muted">${escapeHtml(t("quiz.final_hint", {
        correct: data.my_progress.correct,
        total: data.my_progress.total,
        points: data.my_progress.points,
      }))}</div>
    </div>
    ${standingsHtml(data)}`;
}

function bodyHtml(data) {
  const phase = data.quiz.phase;
  if (phase === "idle") return idleHtml(data.quiz);
  if (phase === "question") return questionPhaseHtml(data);
  if (phase === "standings") return standingsPhaseHtml(data);
  return finishedHtml(data);
}

function phaseLabelKey(phase) {
  if (phase === "question") return "quiz.time_left";
  if (phase === "standings") return "quiz.next_question_in";
  return "quiz.title";
}

/* ------------------------------------------------------------------ */
/* Таймер и обновления                                                */
/* ------------------------------------------------------------------ */
function phaseKey(quiz) {
  return `${quiz.phase}:${quiz.current_index}:${quiz.is_paused ? "pause" : "run"}`;
}

function startTicker(root, quiz) {
  clearTimers();

  const key = phaseKey(quiz);
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    zeroRetries = 0;
  }

  if (quiz.phase !== "question" && quiz.phase !== "standings") return;

  phaseTotal = quiz.phase_seconds || 60;
  zeroHandled = false;

  const left = quiz.remaining_seconds ?? phaseTotal;
  // После вопроса фаза сменится всегда; после рейтинга — только при автопереходе.
  const willAdvance = quiz.phase === "question" || quiz.auto_advance;

  if (quiz.is_paused || (!willAdvance && left <= 0)) {
    // Таймер стоит: ждём администратора, обновляемся редко.
    refreshTimer = setTimeout(() => render(root), HEARTBEAT_MS);
    return;
  }

  deadlineAt = Date.now() + left * 1000;

  tickTimer = setInterval(() => {
    if (!isVisible(root)) {
      clearTimers();
      return;
    }

    const seconds = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
    const percent = phaseTotal ? Math.min(100, Math.max(0, (seconds / phaseTotal) * 100)) : 0;
    const value = root.querySelector("[data-timer-value]");
    const ring = root.querySelector("[data-timer-ring]");
    const box = root.querySelector("[data-timer]");
    if (value) value.textContent = String(seconds);
    if (ring) ring.style.setProperty("--p", `${percent}%`);
    if (box) box.classList.toggle("is-low", seconds <= 10);

    if (quiz.phase === "standings" && quiz.auto_advance) {
      const line = root.querySelector("[data-next-line]");
      if (line) line.textContent = `⏭ ${t("quiz.next_in", { seconds })}`;
    }

    if (seconds > 0 || zeroHandled) return;

    zeroHandled = true;
    root.querySelectorAll(".option:not([disabled])").forEach((button) => {
      button.disabled = true;
    });

    // Разброс задержки, чтобы сотни клиентов не ударили в сервер одновременно.
    zeroRetries += 1;
    const backoff = Math.min(AFTER_ZERO_MIN_MS * (2 ** (zeroRetries - 1)), HEARTBEAT_MS);
    refreshTimer = setTimeout(() => render(root), backoff + Math.random() * AFTER_ZERO_JITTER_MS);
  }, TICK_MS);
}

async function submitAnswer(root, data, index) {
  root.querySelectorAll(".option").forEach((button) => { button.disabled = true; });
  try {
    await api.quizAnswer(data.question.id, index);
    notify.ok(t("quiz.answer_accepted"));
  } catch (error) {
    notify.err(apiErrorMessage(error));
  }
  await render(root);
}

async function render(root) {
  clearTimers();
  if (!root.dataset.ready) root.innerHTML = loaderBlock();

  let data;
  try {
    data = await api.quizState();
  } catch (error) {
    root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
    return;
  }

  root.dataset.ready = "1";

  if (!data.quiz) {
    root.innerHTML = `<div class="empty"><div class="empty__icon">🧠</div>${escapeHtml(t("quiz.closed_hint"))}</div>`;
    return;
  }

  if (!data.quiz.is_open) {
    root.innerHTML = `
      ${headHtml(data, "quiz.title")}
      <div class="empty">
        <div class="empty__icon">🔒</div>
        <strong>${escapeHtml(t("quiz.closed"))}</strong>
        <div style="margin-top:6px">${escapeHtml(t("quiz.closed_hint"))}</div>
      </div>`;
    return;
  }

  root.innerHTML = `
    ${headHtml(data, phaseLabelKey(data.quiz.phase))}
    <div class="stack">${bodyHtml(data)}</div>`;

  if (data.can_answer) {
    root.querySelectorAll(".option").forEach((button) => {
      button.addEventListener("click", () => submitAnswer(root, data, Number(button.dataset.option)));
    });
  }

  startTicker(root, data.quiz);
}

export default {
  id: "quiz",
  stateKeys: ["quiz", "leaderboard"],
  render,
};
