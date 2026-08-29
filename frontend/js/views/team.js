/* Моя команда: состав и баллы. */

import { t } from "../i18n.js";
import { loadMe, store } from "../store.js";
import { apiErrorMessage, escapeHtml, loaderBlock, roleLabel } from "../ui.js";

function personRow(person, isMe) {
  const isLeader = person.role === "leader";
  return `
    <div class="card card--flat spread" style="margin-top:var(--space-2)">
      <div class="row" style="gap:var(--space-3); min-width:0">
        <span style="font-size:1.5rem">${isLeader ? "👑" : "🎓"}</span>
        <div style="min-width:0">
          <div style="font-weight:600">${escapeHtml(person.login)}
            ${isMe ? `<span class="badge badge--accent" style="margin-left:6px">${escapeHtml(t("team.you"))}</span>` : ""}
          </div>
          <div class="muted" style="font-size:.78rem">${escapeHtml(roleLabel(person.role))}</div>
        </div>
      </div>
      <span class="badge ${isLeader ? "badge--accent" : "badge--muted"}">${escapeHtml(roleLabel(person.role))}</span>
    </div>`;
}

export default {
  id: "team",
  stateKeys: ["teams", "leaderboard", "submissions", "quiz"],

  async render(root) {
    if (!root.dataset.ready) root.innerHTML = loaderBlock();

    try {
      await loadMe();
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    root.dataset.ready = "1";
    const team = store.team;
    const me = store.user;

    if (!team) {
      root.innerHTML = `<div class="empty"><div class="empty__icon">👤</div>${escapeHtml(t("team.no_team"))}</div>`;
      return;
    }

    const people = [team.leader, ...(team.members || [])].filter(Boolean);

    root.innerHTML = `
      <div class="page__head">
        <h1 class="page__title">👥 <span>${escapeHtml(t("team.title"))}</span></h1>
        <p class="page__hint">${escapeHtml(t("team.hint"))}</p>
      </div>

      <div class="card card--accent">
        <div class="spread">
          <div>
            <div class="muted" style="font-size:.78rem">${escapeHtml(t("team.name"))}</div>
            <h2 style="margin:0">${escapeHtml(team.name)}</h2>
          </div>
          <span class="badge badge--accent">#${String(team.number).padStart(2, "0")}</span>
        </div>
      </div>

      <div class="grid grid--stats" style="margin-top:var(--space-3)">
        <div class="stat"><div class="stat__value">${team.task_points}</div><div class="stat__label">${escapeHtml(t("team.points_tasks"))}</div></div>
        <div class="stat"><div class="stat__value">${team.quiz_points}</div><div class="stat__label">${escapeHtml(t("team.points_quiz"))}</div></div>
        <div class="stat"><div class="stat__value">${team.bonus_points}</div><div class="stat__label">${escapeHtml(t("team.points_bonus"))}</div></div>
        <div class="stat"><div class="stat__value">${team.total_points}</div><div class="stat__label">${escapeHtml(t("team.points_total"))}</div></div>
      </div>

      <h3 style="margin-top:var(--space-5)">${escapeHtml(t("team.members"))}</h3>
      ${people.map((person) => personRow(person, person.id === me.id)).join("")}`;
  },
};
