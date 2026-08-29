/* Рейтинг команд в реальном времени: ТОП-10 с раскрытием полного списка. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import { apiErrorMessage, escapeHtml, loaderBlock, rankMedal } from "../ui.js";

const TOP_SIZE = 10;
let showAll = false;

function rowHtml(row, myTeamId) {
  const topClass = row.rank <= 3 ? `board-row--top${row.rank}` : "";
  const mine = row.team_id === myTeamId ? "is-mine" : "";
  return `
    <div class="board-row ${topClass} ${mine}">
      <div class="board-row__rank">${rankMedal(row.rank)}</div>
      <div style="min-width:0">
        <div class="board-row__name">${escapeHtml(row.name)}
          ${mine ? `<span class="badge badge--accent" style="margin-left:6px">${escapeHtml(t("rating.your_team"))}</span>` : ""}
        </div>
        <div class="board-row__meta">
          <span>📋 ${escapeHtml(t("rating.tasks"))}: ${row.task_points}</span>
          <span>🧠 ${escapeHtml(t("rating.quiz"))}: ${row.quiz_points}</span>
          ${row.bonus_points ? `<span>⭐ ${escapeHtml(t("rating.bonus"))}: ${row.bonus_points}</span>` : ""}
        </div>
      </div>
      <div class="board-row__points">${row.total_points}<small>${escapeHtml(t("common.pts"))}</small></div>
    </div>`;
}

export default {
  id: "leaderboard",
  stateKeys: ["leaderboard", "quiz", "submissions"],

  async render(root) {
    if (!root.dataset.ready) root.innerHTML = loaderBlock();

    let data;
    try {
      data = await api.leaderboard();
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    root.dataset.ready = "1";
    const myTeamId = store.user?.team_id ?? null;
    const rows = showAll ? data.teams : data.teams.slice(0, TOP_SIZE);
    const hasMore = data.teams.length > TOP_SIZE;

    const notRanked = myTeamId && !data.my_team
      ? `<div class="card card--flat muted center" style="margin-bottom:var(--space-3)">
           ${escapeHtml(t("rating.not_ranked"))}
         </div>`
      : "";

    root.innerHTML = `
      <div class="page__head">
        <h1 class="page__title">🏆 <span>${escapeHtml(t("rating.title"))}</span></h1>
        <p class="page__hint">${escapeHtml(t("rating.hint"))}</p>
      </div>

      <div class="card card--flat spread" style="margin-bottom:var(--space-4)">
        <span class="row"><span class="live-dot"></span> <strong>${escapeHtml(t("common.live"))}</strong></span>
        <span class="badge badge--info">${data.total_ranked} ${escapeHtml(t("rating.teams_ranked"))}</span>
      </div>

      ${notRanked}

      ${data.teams.length
        ? `<div class="board">${rows.map((row) => rowHtml(row, myTeamId)).join("")}</div>
           ${hasMore
             ? `<button type="button" class="btn btn--ghost btn--block" data-toggle-all style="margin-top:var(--space-4)">
                  ${escapeHtml(showAll ? t("rating.hide_all") : t("rating.show_all"))}
                </button>`
             : ""}`
        : `<div class="empty"><div class="empty__icon">🏁</div>${escapeHtml(t("rating.empty"))}</div>`}`;

    root.querySelector("[data-toggle-all]")?.addEventListener("click", () => {
      showAll = !showAll;
      this.render(root);
    });
  },
};
