/* Тест: 15 вопросов у всех одновременно, отвечает только лидер. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { apiErrorMessage, escapeHtml, loaderBlock, notify } from "../ui.js";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

function headHtml(data) {
  const quiz = data.quiz;
  const progress = data.my_progress || { answered: 0, total: 0, correct: 0, points: 0 };
  const percent = progress.total ? Math.round((progress.answered / progress.total) * 100) : 0;

  return `
    <div class="quiz-head">
      <div class="spread">
        <div>
          <h1 class="page__title" style="margin:0">🧠 <span>${escapeHtml(quiz?.title || t("quiz.title"))}</span></h1>
          <p class="page__hint" style="margin-top:4px">${escapeHtml(t("quiz.hint"))}</p>
        </div>
        <span class="badge ${quiz?.is_open ? "badge--success" : "badge--danger"}">
          ${quiz?.is_open ? escapeHtml(t("quiz.open")) : escapeHtml(t("quiz.closed"))}
        </span>
      </div>

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
      </div>

      <div class="progress"><div class="progress__bar" style="width:${percent}%"></div></div>
      <div class="muted" style="font-size:.82rem">
        ${data.can_answer ? `✍️ ${escapeHtml(t("quiz.leader_hint"))}` : `👀 ${escapeHtml(t("quiz.member_view_hint"))}`}
      </div>
    </div>`;
}

function optionHtml(question, option, index, data) {
  const answer = question.my_answer;
  const answered = Boolean(answer);
  const revealed = answered && question.correct_index !== undefined;

  const classes = ["option"];
  if (answered && answer.selected_index === index) {
    classes.push(answer.is_correct ? "is-correct" : "is-wrong");
  }
  if (revealed && question.correct_index === index) classes.push("is-correct");

  let mark = "";
  if (revealed && question.correct_index === index) mark = "✓";
  else if (answered && answer.selected_index === index && !answer.is_correct) mark = "✕";

  const disabled = !data.can_answer || answered;

  return `
    <button type="button" class="${classes.join(" ")}" ${disabled ? "disabled" : ""}
      data-question="${question.id}" data-option="${index}">
      <span class="option__key">${LETTERS[index] || index + 1}</span>
      <span class="option__text">${escapeHtml(option)}</span>
      <span class="option__mark">${mark}</span>
    </button>`;
}

function questionHtml(question, data) {
  const answer = question.my_answer;
  let resultLine = "";
  if (answer) {
    resultLine = answer.is_correct
      ? `<div class="question__result question__result--ok">✅ ${escapeHtml(t("quiz.answer_correct", { points: answer.points }))}</div>`
      : `<div class="question__result question__result--bad">❌ ${escapeHtml(t("quiz.answer_wrong"))}</div>`;
  } else if (!data.can_answer) {
    resultLine = `<div class="question__result muted">⏳ ${escapeHtml(t("quiz.waiting"))}</div>`;
  }

  return `
    <article class="card question" data-question-card="${question.id}">
      <div class="question__head">
        <span class="question__num">${question.order}</span>
        <div class="grow">
          <div class="question__text">${escapeHtml(question.text)}</div>
          <div class="muted" style="font-size:.75rem">${question.points} ${escapeHtml(t("common.pts"))}</div>
        </div>
      </div>
      <div class="options">
        ${question.options.map((option, index) => optionHtml(question, option, index, data)).join("")}
      </div>
      ${resultLine}
    </article>`;
}

export default {
  id: "quiz",
  stateKeys: ["quiz", "leaderboard"],

  async render(root) {
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
        ${headHtml(data)}
        <div class="empty">
          <div class="empty__icon">🔒</div>
          <strong>${escapeHtml(t("quiz.closed"))}</strong>
          <div style="margin-top:6px">${escapeHtml(t("quiz.closed_hint"))}</div>
        </div>`;
      return;
    }

    const allAnswered = data.my_progress.total > 0
      && data.my_progress.answered === data.my_progress.total;

    root.innerHTML = `
      ${headHtml(data)}
      ${allAnswered ? `<div class="card card--accent center">🎉 ${escapeHtml(t("quiz.finished"))}</div>` : ""}
      <div class="stack">${data.questions.map((question) => questionHtml(question, data)).join("")}</div>`;

    if (!data.can_answer) return;

    root.querySelectorAll(".option:not([disabled])").forEach((button) => {
      button.addEventListener("click", async () => {
        const questionId = Number(button.dataset.question);
        const selected = Number(button.dataset.option);
        const card = root.querySelector(`[data-question-card="${questionId}"]`);
        card?.querySelectorAll(".option").forEach((option) => { option.disabled = true; });
        button.classList.add("is-selected");

        try {
          const result = await api.quizAnswer(questionId, selected);
          notify[result.is_correct ? "ok" : "err"](
            result.is_correct ? t("quiz.answer_correct", { points: result.points }) : t("quiz.answer_wrong"),
          );
          await this.render(root);
        } catch (error) {
          notify.err(apiErrorMessage(error));
          await this.render(root);
        }
      });
    });
  },
};
