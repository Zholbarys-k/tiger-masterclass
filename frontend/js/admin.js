/* Панель администратора: команды, баллы, задания, тест, ответы, голоса, рейтинг. */

import { api, auth, fileUrl } from "./api.js";
import { applyTranslations, initI18n, mountLangSwitch, t } from "./i18n.js";
import { startPolling, store, subscribe } from "./store.js";
import {
  apiErrorMessage,
  confirmDialog,
  emptyState,
  escapeHtml,
  formatBytes,
  formatCountdown,
  formatTime,
  loaderBlock,
  nl2br,
  notify,
  openModal,
  rankMedal,
  roleLabel,
} from "./ui.js";

const content = document.getElementById("admin-content");
const TAB_KEY = "tiger.admin.tab";
let activeTab = "overview";
let teamsCache = [];

/* ------------------------------------------------------------------ */
/* Обзор                                                              */
/* ------------------------------------------------------------------ */
const overviewTab = {
  stateKeys: ["teams", "tasks", "votes", "quiz", "submissions", "leaderboard"],
  async render() {
    const data = await api.admin.overview();
    const stats = data.stats;
    const cards = [
      ["admin.stats.teams", stats.teams],
      ["admin.stats.active_teams", stats.active_teams],
      ["admin.stats.users", stats.users],
      ["admin.stats.leaders", stats.leaders],
      ["admin.stats.members", stats.members],
      ["admin.stats.admins", stats.admins],
      ["admin.stats.tasks", stats.tasks],
      ["admin.stats.submissions", stats.submissions],
      ["admin.stats.attachments", stats.attachments],
      ["admin.stats.votes", stats.votes],
      ["admin.stats.quiz_answers", stats.quiz_answers],
    ].map(([key, value]) => `
      <div class="stat"><div class="stat__value">${value}</div>
      <div class="stat__label">${escapeHtml(t(key))}</div></div>`).join("");

    content.innerHTML = `
      <div class="grid grid--stats">${cards}</div>

      <div class="card" style="margin-top:var(--space-4)">
        <div class="spread">
          <h3 class="card__title">🧠 ${escapeHtml(t("admin.quiz.status"))}</h3>
          <div class="row">
            <span class="badge ${data.quiz?.is_open ? "badge--success" : "badge--danger"}">
              ${escapeHtml(data.quiz?.is_open ? t("admin.quiz.is_open") : t("admin.quiz.is_closed"))}
            </span>
            <span class="badge badge--info">
              ${escapeHtml(t(PHASE_LABELS[data.quiz?.phase] || "admin.quiz.phase_idle"))}
              ${data.quiz?.current_number ? `· ${data.quiz.current_number}/${data.quiz.questions_count}` : ""}
            </span>
          </div>
        </div>
        <div class="card__body row">
          <button type="button" class="btn ${data.quiz?.is_open ? "btn--danger" : "btn--primary"}" data-quiz-toggle>
            ${escapeHtml(data.quiz?.is_open ? t("admin.quiz.close") : t("admin.quiz.open"))}
          </button>
          <button type="button" class="btn btn--ghost" data-go-quiz>🎛️ ${escapeHtml(t("admin.quiz.control"))}</button>
        </div>
      </div>

      <div class="card">
        <h3 class="card__title">🔑 ${escapeHtml(t("admin.passwords"))}</h3>
        <div class="card__body stack">
          <div class="spread"><span>${escapeHtml(t("admin.password_participants"))}</span>
            <code class="badge badge--accent">${escapeHtml(data.participant_password)}</code></div>
          <div class="spread"><span>${escapeHtml(t("admin.password_admins"))}</span>
            <code class="badge badge--info">${escapeHtml(data.admin_password)}</code></div>
        </div>
      </div>`;

    content.querySelector("[data-go-quiz]")?.addEventListener("click", () => activate("quiz"));

    content.querySelector("[data-quiz-toggle]")?.addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const result = await api.admin.toggleQuiz({ is_open: !data.quiz?.is_open });
        notify.ok(t(result.quiz.is_open ? "admin.quiz.opened" : "admin.quiz.closed"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    });
  },
};

/* ------------------------------------------------------------------ */
/* Команды                                                            */
/* ------------------------------------------------------------------ */
const teamsTab = {
  stateKeys: ["teams", "leaderboard"],
  filter: "",

  async render() {
    const data = await api.admin.teams();
    teamsCache = data.teams;
    const query = this.filter.trim().toLowerCase();

    const teams = query
      ? data.teams.filter((team) =>
        team.name.toLowerCase().includes(query)
        || String(team.number).padStart(2, "0").includes(query)
        || [team.leader, ...team.members].filter(Boolean)
          .some((person) => person.login.toLowerCase().includes(query)))
      : data.teams;

    content.innerHTML = `
      <div class="field">
        <input class="input" id="team-search" type="search" value="${escapeHtml(this.filter)}"
               placeholder="${escapeHtml(t("admin.teams.search_ph"))}">
      </div>
      <div id="teams-list">${teams.map(teamAccordionHtml).join("") || emptyState("admin.subs.empty", "👥")}</div>`;

    const search = content.querySelector("#team-search");
    search.addEventListener("input", (event) => {
      this.filter = event.target.value;
      const value = this.filter;
      this.render().then(() => {
        const input = content.querySelector("#team-search");
        if (input) {
          input.focus();
          input.setSelectionRange(value.length, value.length);
        }
      });
    });

    wireTeamActions();
  },
};

function personLineHtml(person, team) {
  const isLeader = person.role === "leader";
  return `
    <div class="card card--flat" style="margin-top:var(--space-2)">
      <div class="spread">
        <div class="row" style="min-width:0">
          <span style="font-size:1.2rem">${isLeader ? "👑" : "🎓"}</span>
          <div style="min-width:0">
            <div style="font-weight:600">${escapeHtml(person.login)}</div>
            <div class="muted" style="font-size:.75rem">${escapeHtml(roleLabel(person.role))}</div>
          </div>
        </div>
        <div class="row">
          <button type="button" class="btn btn--sm btn--ghost" data-edit-login="${person.id}"
            data-login="${escapeHtml(person.login)}">✏️ ${escapeHtml(t("admin.teams.edit_login"))}</button>
          ${!isLeader
            ? `<button type="button" class="btn btn--sm btn--success" data-make-leader="${person.id}"
                 data-team="${team.id}">👑 ${escapeHtml(t("admin.teams.make_leader"))}</button>`
            : ""}
          <button type="button" class="btn btn--sm btn--ghost" data-move-user="${person.id}"
            data-current-team="${team.id}">↔️ ${escapeHtml(t("admin.teams.move"))}</button>
        </div>
      </div>
    </div>`;
}

function teamAccordionHtml(team) {
  const people = [team.leader, ...(team.members || [])].filter(Boolean);
  return `
    <div class="acc" data-team-acc="${team.id}">
      <button type="button" class="acc__head">
        <span class="row" style="min-width:0">
          <span class="badge badge--muted">#${String(team.number).padStart(2, "0")}</span>
          <strong>${escapeHtml(team.name)}</strong>
          <span class="muted" style="font-size:.78rem">${people.length} 👤</span>
        </span>
        <span class="row">
          <span class="badge badge--accent">${team.total_points} ${escapeHtml(t("common.pts"))}</span>
          <span class="acc__chev">▾</span>
        </span>
      </button>
      <div class="acc__body">
        <div class="grid grid--stats" style="margin-bottom:var(--space-3)">
          <div class="stat"><div class="stat__value">${team.task_points}</div><div class="stat__label">${escapeHtml(t("rating.tasks"))}</div></div>
          <div class="stat"><div class="stat__value">${team.quiz_points}</div><div class="stat__label">${escapeHtml(t("rating.quiz"))}</div></div>
          <div class="stat"><div class="stat__value">${team.bonus_points}</div><div class="stat__label">${escapeHtml(t("rating.bonus"))}</div></div>
          <div class="stat"><div class="stat__value">${team.total_points}</div><div class="stat__label">${escapeHtml(t("rating.total"))}</div></div>
        </div>

        <div class="row" style="margin-bottom:var(--space-2)">
          <button type="button" class="btn btn--sm btn--ghost" data-rename-team="${team.id}"
            data-name="${escapeHtml(team.name)}">🏷️ ${escapeHtml(t("admin.teams.rename"))}</button>
          <button type="button" class="btn btn--sm btn--primary" data-score-team="${team.id}"
            data-total="${team.total_points}" data-name="${escapeHtml(team.name)}">
            ⭐ ${escapeHtml(t("admin.teams.add_points"))}</button>
        </div>

        ${people.map((person) => personLineHtml(person, team)).join("")}
      </div>
    </div>`;
}

function wireTeamActions() {
  content.querySelectorAll(".acc__head").forEach((head) => {
    head.addEventListener("click", () => head.parentElement.classList.toggle("is-open"));
  });

  content.querySelectorAll("[data-edit-login]").forEach((button) => {
    button.addEventListener("click", () => {
      const userId = Number(button.dataset.editLogin);
      openModal({
        title: t("admin.teams.edit_login"),
        bodyHtml: `
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.teams.new_login"))}</label>
            <input class="input" id="new-login" value="${escapeHtml(button.dataset.login)}"
                   autocapitalize="none" spellcheck="false">
          </div>
          <div class="row row-end">
            <button type="button" class="btn btn--primary" data-save>${escapeHtml(t("common.save"))}</button>
          </div>`,
        onMount(box, close) {
          const input = box.querySelector("#new-login");
          input.focus();
          box.querySelector("[data-save]").addEventListener("click", async () => {
            try {
              await api.admin.updateUser(userId, { login: input.value.trim().toLowerCase() });
              notify.ok(t("admin.teams.login_changed"));
              close();
              render();
            } catch (error) {
              notify.err(apiErrorMessage(error));
            }
          });
        },
      });
    });
  });

  content.querySelectorAll("[data-make-leader]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api.admin.setLeader(Number(button.dataset.team), Number(button.dataset.makeLeader));
        notify.ok(t("admin.teams.leader_changed"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
        button.disabled = false;
      }
    });
  });

  content.querySelectorAll("[data-move-user]").forEach((button) => {
    button.addEventListener("click", () => {
      const userId = Number(button.dataset.moveUser);
      const currentTeam = Number(button.dataset.currentTeam);
      const options = teamsCache
        .map((team) => `<option value="${team.id}" ${team.id === currentTeam ? "selected" : ""}>
            #${String(team.number).padStart(2, "0")} — ${escapeHtml(team.name)} (${1 + (team.members?.length || 0)}/5)
          </option>`).join("");

      openModal({
        title: t("admin.teams.move"),
        bodyHtml: `
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.teams.move_to"))}</label>
            <select class="select" id="move-team">${options}</select>
          </div>
          <div class="row row-end">
            <button type="button" class="btn btn--primary" data-save>${escapeHtml(t("common.save"))}</button>
          </div>`,
        onMount(box, close) {
          box.querySelector("[data-save]").addEventListener("click", async () => {
            try {
              await api.admin.moveUser(userId, Number(box.querySelector("#move-team").value));
              notify.ok(t("admin.teams.moved"));
              close();
              render();
            } catch (error) {
              notify.err(apiErrorMessage(error));
            }
          });
        },
      });
    });
  });

  content.querySelectorAll("[data-rename-team]").forEach((button) => {
    button.addEventListener("click", () => {
      const teamId = Number(button.dataset.renameTeam);
      openModal({
        title: t("admin.teams.rename"),
        bodyHtml: `
          <div class="field">
            <label class="field__label">${escapeHtml(t("team.name"))}</label>
            <input class="input" id="team-name" value="${escapeHtml(button.dataset.name)}">
          </div>
          <div class="row row-end">
            <button type="button" class="btn btn--primary" data-save>${escapeHtml(t("common.save"))}</button>
          </div>`,
        onMount(box, close) {
          box.querySelector("[data-save]").addEventListener("click", async () => {
            try {
              await api.admin.updateTeam(teamId, { name: box.querySelector("#team-name").value.trim() });
              notify.ok(t("common.saved"));
              close();
              render();
            } catch (error) {
              notify.err(apiErrorMessage(error));
            }
          });
        },
      });
    });
  });

  content.querySelectorAll("[data-score-team]").forEach((button) => {
    button.addEventListener("click", () => {
      const teamId = Number(button.dataset.scoreTeam);
      openModal({
        title: `⭐ ${button.dataset.name}`,
        bodyHtml: `
          <div class="row" style="margin-bottom:var(--space-3)">
            ${[-10, -5, -1, 1, 5, 10].map((value) => `
              <button type="button" class="btn btn--sm btn--ghost" data-delta="${value}">
                ${value > 0 ? `+${value}` : value}</button>`).join("")}
          </div>
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.teams.delta"))}</label>
            <input class="input" id="delta" type="number" inputmode="numeric" value="0">
          </div>
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.teams.set_total"))} (${escapeHtml(t("common.total"))}: ${button.dataset.total})</label>
            <input class="input" id="set-total" type="number" inputmode="numeric" placeholder="—">
          </div>
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.teams.reason"))}</label>
            <input class="input" id="reason" placeholder="${escapeHtml(t("admin.teams.reason_ph"))}">
          </div>
          <div class="row row-end">
            <button type="button" class="btn btn--primary" data-save>${escapeHtml(t("admin.teams.apply"))}</button>
          </div>
          <div id="adj-history" class="muted" style="margin-top:var(--space-4); font-size:.82rem"></div>`,
        async onMount(box, close) {
          const deltaInput = box.querySelector("#delta");
          box.querySelectorAll("[data-delta]").forEach((chip) => {
            chip.addEventListener("click", () => {
              deltaInput.value = String(Number(deltaInput.value || 0) + Number(chip.dataset.delta));
            });
          });

          try {
            const history = await api.admin.adjustments(teamId);
            box.querySelector("#adj-history").innerHTML = history.adjustments.length
              ? `<strong>${escapeHtml(t("admin.teams.history"))}</strong><br>${history.adjustments.map((row) =>
                `${formatTime(row.created_at)} · ${row.delta > 0 ? "+" : ""}${row.delta} · ${escapeHtml(row.reason)} (${escapeHtml(row.admin)})`,
              ).join("<br>")}`
              : escapeHtml(t("admin.teams.no_history"));
          } catch {
            /* история необязательна */
          }

          box.querySelector("[data-save]").addEventListener("click", async () => {
            const setTotal = box.querySelector("#set-total").value;
            const payload = { reason: box.querySelector("#reason").value.trim() || undefined };
            if (setTotal !== "") payload.set_total = Number(setTotal);
            else payload.delta = Number(deltaInput.value || 0);

            try {
              await api.admin.adjustScore(teamId, payload);
              notify.ok(t("admin.teams.score_changed"));
              close();
              render();
            } catch (error) {
              notify.err(apiErrorMessage(error));
            }
          });
        },
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Задания                                                            */
/* ------------------------------------------------------------------ */
const T3_PHASE_LABELS = {
  idle: "admin.round.phase_idle",
  running: "admin.round.phase_running",
  voting: "admin.round.phase_voting",
  closed: "admin.round.phase_closed",
};

let task3Tick = null;
let task3Deadline = 0;
let task3Total = 0;

function stopTask3Tick() {
  if (task3Tick) clearInterval(task3Tick);
  task3Tick = null;
}

function startTask3Tick(roundItems) {
  stopTask3Tick();
  const live = (roundItems || []).filter((item) => item.round?.phase === "running" && !item.round.is_paused);
  if (!live.length) return;

  const meta = live.map((item) => ({
    id: item.task_id,
    total: item.round.phase_seconds || 3600,
    deadline: Date.now() + (item.round.remaining_seconds ?? item.round.phase_seconds ?? 3600) * 1000,
  }));
  let reloaded = false;

  task3Tick = setInterval(() => {
    if (activeTab !== "tasks" || !content.querySelector("[data-round-timer]")) {
      stopTask3Tick();
      return;
    }
    let expired = false;
    meta.forEach((item) => {
      const seconds = Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000));
      const percent = item.total ? Math.min(100, (seconds / item.total) * 100) : 0;
      const box = content.querySelector(`[data-round-timer="${item.id}"]`);
      if (!box) return;
      const value = box.querySelector("[data-task3-timer-value]");
      const ring = box.querySelector("[data-task3-timer-ring]");
      if (value) value.textContent = formatCountdown(seconds);
      if (ring) ring.style.setProperty("--p", `${percent}%`);
      box.classList.toggle("is-low", seconds <= 60 && seconds > 0);
      if (seconds <= 0) expired = true;
    });
    if (expired && !reloaded) {
      reloaded = true;
      setTimeout(() => { if (activeTab === "tasks") render(); }, 900);
    }
  }, 250);
}

function task3ControlsHtml(item) {
  const round = item.round || {};
  const live = round.phase === "running";
  const started = round.phase !== "idle";
  const percent = round.phase_seconds
    ? Math.min(100, ((round.remaining_seconds ?? 0) / round.phase_seconds) * 100)
    : 0;
  const minutes = Math.round((round.duration_seconds || 3600) / 60);
  const number = item.task_order || round.task_order || "";

  return `
    <div class="card card--accent" style="margin-bottom:var(--space-4)" data-round="${item.task_id}">
      <div class="spread">
        <div style="min-width:0">
          <h3 class="card__title">${escapeHtml(t("admin.round.title", { n: number }))}</h3>
          <div class="muted" style="font-size:.82rem">${escapeHtml(item.task_title || t("admin.round.hint"))}</div>
        </div>
        <div class="row">
          <span class="badge badge--info">${escapeHtml(t(
            round.likes_enabled === false && round.phase === "closed"
              ? "admin.round.phase_done"
              : (T3_PHASE_LABELS[round.phase] || "admin.round.phase_idle"),
          ))}</span>
          ${round.is_paused ? `<span class="badge badge--accent">⏸ ${escapeHtml(t("admin.quiz.paused"))}</span>` : ""}
          <span class="badge badge--muted">${item.submissions_count || 0} 📨</span>
          <button type="button" class="btn btn--icon btn--ghost qpult-close"
            data-edit-task="${item.task_id}"
            title="${escapeHtml(t("admin.tasks.edit"))}"
            aria-label="${escapeHtml(t("admin.tasks.edit"))}">✏️</button>
          <button type="button" class="btn btn--icon btn--danger qpult-close"
            data-delete-task="${item.task_id}"
            title="${escapeHtml(t("admin.tasks.delete"))}"
            aria-label="${escapeHtml(t("admin.tasks.delete"))}">✕</button>
        </div>
      </div>

      <div class="card__body">
        ${live ? `
        <div class="qpult" data-round-timer="${item.task_id}">
          <div class="qtimer qtimer--long">
            <div class="qtimer__ring" style="--p:${percent}%" data-task3-timer-ring>
              <span class="qtimer__value" data-task3-timer-value>${round.is_paused ? "||" : formatCountdown(round.remaining_seconds ?? 0)}</span>
            </div>
          </div>
          <div>
            <div style="font-weight:700">${escapeHtml(t("admin.round.live_title"))}</div>
            <div class="muted" style="font-size:.82rem">${escapeHtml(t("admin.round.live_hint"))}</div>
          </div>
        </div>` : ""}

        <div class="row" style="margin-top:var(--space-3); flex-wrap:wrap">
          <button type="button" class="btn btn--primary" data-t3="start" data-task="${item.task_id}">
            ${escapeHtml(started ? t("admin.round.restart") : t("admin.round.start"))}</button>
          ${live ? `
          <button type="button" class="btn btn--ghost" data-t3="${round.is_paused ? "resume" : "pause"}" data-task="${item.task_id}">
            ${escapeHtml(round.is_paused ? `▶️ ${t("admin.quiz.resume")}` : `⏸ ${t("admin.quiz.pause")}`)}</button>
          <button type="button" class="btn btn--ghost" data-t3-extend="300" data-task="${item.task_id}">+5 ${escapeHtml(t("admin.round.min"))}</button>
          <button type="button" class="btn btn--ghost" data-t3-extend="900" data-task="${item.task_id}">+15 ${escapeHtml(t("admin.round.min"))}</button>
          <button type="button" class="btn btn--ghost" data-t3-extend="-300" data-task="${item.task_id}">−5 ${escapeHtml(t("admin.round.min"))}</button>
          <button type="button" class="btn btn--success" data-t3="finish" data-task="${item.task_id}">${round.likes_enabled === false ? "🏁" : "🗳️"} ${escapeHtml(t(round.likes_enabled === false ? "admin.round.finish_plain" : "admin.round.finish"))}</button>` : ""}
          ${round.phase === "voting"
            ? `<button type="button" class="btn btn--ghost" data-t3="close" data-task="${item.task_id}">🏁 ${escapeHtml(t("admin.round.close"))}</button>`
            : ""}
          ${round.phase === "closed" && round.likes_enabled !== false
            ? `<button type="button" class="btn btn--success" data-t3="open" data-task="${item.task_id}">🗳️ ${escapeHtml(t("admin.round.reopen"))}</button>`
            : ""}
          ${started ? `<button type="button" class="btn btn--ghost" data-t3="reset" data-task="${item.task_id}">🔄 ${escapeHtml(t("admin.round.reset"))}</button>` : ""}
        </div>

        <div class="qpult-settings">
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.round.duration"))}</label>
            <input class="input input--sm input--score" type="number" min="1" max="240"
                   data-t3-minutes="${item.task_id}" value="${minutes}">
          </div>
          <button type="button" class="btn btn--sm btn--primary" data-t3-save="${item.task_id}">
            ${escapeHtml(t("common.save"))}</button>
        </div>
      </div>
    </div>`;
}

const tasksTab = {
  stateKeys: ["tasks", "submissions", "task3"],

  async render() {
    stopTask3Tick();
    const [data, roundsData] = await Promise.all([api.admin.tasks(), api.admin.rounds()]);
    const roundItems = roundsData.rounds || [];

    content.innerHTML = `
      ${roundItems.map(task3ControlsHtml).join("")}
      <div class="row" style="margin-bottom:var(--space-4); flex-wrap:wrap">
        <button type="button" class="btn btn--primary" data-new-task>➕ ${escapeHtml(t("admin.tasks.new"))}</button>
        <button type="button" class="btn btn--danger" data-reset-all-subs>
          🔄 ${escapeHtml(t("admin.subs.reset_all"))}</button>
      </div>
      <div class="stack">${data.tasks.length
        ? data.tasks.map(taskCardHtml).join("")
        : emptyState("admin.tasks.empty", "📋")}</div>`;

    const control = async (taskId, action, payload = {}) => {
      try {
        await api.admin.roundControl(taskId, action, payload);
        notify.ok(t("admin.round.applied"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    };

    content.querySelectorAll("[data-t3]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.t3;
        const taskId = Number(button.dataset.task);
        const item = roundItems.find((row) => row.task_id === taskId);
        const phase = item?.round?.phase;
        if (action === "start" && phase !== "idle") {
          if (!await confirmDialog(t("admin.round.confirm_restart"))) return;
        }
        if (action === "finish" && !await confirmDialog(t(
          item?.round?.likes_enabled === false ? "admin.round.confirm_finish_plain" : "admin.round.confirm_finish",
        ))) return;
        if (action === "reset" && !await confirmDialog(t("admin.round.confirm_reset"))) return;
        await control(taskId, action, action === "reset" ? { clear_likes: true } : {});
      });
    });

    content.querySelectorAll("[data-t3-extend]").forEach((button) => {
      button.addEventListener("click", () => control(Number(button.dataset.task), "extend", {
        seconds: Number(button.dataset.t3Extend),
      }));
    });

    content.querySelectorAll("[data-t3-save]").forEach((button) => {
      button.addEventListener("click", async () => {
        const taskId = Number(button.dataset.t3Save);
        const minutes = Number(content.querySelector(`[data-t3-minutes="${taskId}"]`)?.value || 60);
        try {
          await api.admin.roundSettings(taskId, { duration_seconds: Math.round(minutes * 60) });
          notify.ok(t("admin.round.settings_saved"));
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
        render();
      });
    });

    content.querySelector("[data-reset-all-subs]")?.addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.subs.confirm_reset_all"))) return;
      try {
        await api.admin.resetSubmissions();
        notify.ok(t("admin.subs.reset_done"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    startTask3Tick(roundItems);

    content.querySelector("[data-new-task]").addEventListener("click", () => openTaskModal(null));

    content.querySelectorAll("[data-edit-task]").forEach((button) => {
      button.addEventListener("click", () => {
        const task = data.tasks.find((item) => item.id === Number(button.dataset.editTask));
        openTaskModal(task);
      });
    });

    content.querySelectorAll("[data-toggle-task]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api.admin.updateTask(Number(button.dataset.toggleTask), {
            is_published: button.dataset.published === "0",
          });
          notify.ok(t("admin.tasks.updated"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
          button.disabled = false;
        }
      });
    });

    content.querySelectorAll("[data-delete-task]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!await confirmDialog(t("admin.tasks.confirm_delete"))) return;
        try {
          await api.admin.deleteTask(Number(button.dataset.deleteTask));
          notify.ok(t("admin.tasks.deleted"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    });
  },
};

function taskCardHtml(task) {
  return `
    <article class="card">
      <div class="card__head">
        <div style="min-width:0">
          <h3 class="card__title">${escapeHtml(task.title)}</h3>
          <div class="muted" style="font-size:.76rem">${formatTime(task.created_at)} · ${task.submissions_count} 📨</div>
        </div>
        <div class="row">
          <span class="badge badge--accent">${task.max_points} ${escapeHtml(t("common.pts"))}</span>
          <span class="badge ${task.is_published ? "badge--success" : "badge--muted"}">
            ${escapeHtml(task.is_published ? t("admin.tasks.published") : t("admin.tasks.draft"))}</span>
        </div>
      </div>
      <div class="card__body">
        ${task.image_url ? `<img class="content-image content-image--sm" src="${fileUrl(task.image_url)}" alt="">` : ""}
        <div class="muted">${nl2br(task.body)}</div>
        <div class="row" style="margin-top:var(--space-3)">
          <button type="button" class="btn btn--sm btn--ghost" data-edit-task="${task.id}">✏️ ${escapeHtml(t("admin.tasks.edit"))}</button>
          <button type="button" class="btn btn--sm ${task.is_published ? "btn--ghost" : "btn--success"}"
            data-toggle-task="${task.id}" data-published="${task.is_published ? "1" : "0"}">
            ${escapeHtml(task.is_published ? t("admin.tasks.unpublish") : t("admin.tasks.publish"))}</button>
          <button type="button" class="btn btn--sm btn--danger" data-delete-task="${task.id}">🗑️ ${escapeHtml(t("admin.tasks.delete"))}</button>
        </div>
      </div>
    </article>`;
}

const MAX_IMAGE_SIZE = 15 * 1024 * 1024;

function imagePickerHtml(currentUrl) {
  return `
    <div class="field">
      <label class="field__label">${escapeHtml(t("admin.media.photo"))}</label>
      <div class="image-picker">
        <img class="image-picker__preview ${currentUrl ? "" : "hidden"}" data-image-preview
             src="${currentUrl ? fileUrl(currentUrl) : ""}" alt="">
        <div class="row">
          <label class="btn btn--sm btn--ghost">
            🖼️ ${escapeHtml(t(currentUrl ? "admin.media.replace" : "admin.media.choose"))}
            <input type="file" accept="image/*" data-image-input hidden>
          </label>
          <button type="button" class="btn btn--sm btn--danger ${currentUrl ? "" : "hidden"}" data-image-remove>
            ✕ ${escapeHtml(t("admin.media.remove"))}</button>
        </div>
        <div class="muted" style="font-size:.78rem">${escapeHtml(t("admin.media.hint"))}</div>
      </div>
    </div>`;
}

/** Выбор фото в модальном окне: файл загружается после сохранения формы. */
function wireImagePicker(box) {
  const state = { file: null, remove: false };
  const input = box.querySelector("[data-image-input]");
  const preview = box.querySelector("[data-image-preview]");
  const removeButton = box.querySelector("[data-image-remove]");

  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      notify.err(t("admin.media.bad_type"));
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      notify.err(t("tasks.file_too_big"));
      return;
    }
    state.file = file;
    state.remove = false;
    if (preview.src.startsWith("blob:")) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(file);
    preview.classList.remove("hidden");
    removeButton.classList.remove("hidden");
  });

  removeButton.addEventListener("click", () => {
    state.file = null;
    state.remove = true;
    preview.removeAttribute("src");
    preview.classList.add("hidden");
    removeButton.classList.add("hidden");
  });
  return state;
}

async function applyImage(state, hadImage, uploadImage, deleteImage) {
  if (state.file) await uploadImage(state.file);
  else if (state.remove && hadImage) await deleteImage();
}

function openTaskModal(task) {
  const langs = [["kk", "ҚАЗ"], ["ru", "РУС"], ["en", "ENG"]];
  const fields = langs.map(([code, label]) => `
    <div class="field">
      <label class="field__label">${escapeHtml(t("admin.tasks.title_field"))} · ${label}</label>
      <input class="input" data-field="title_${code}" value="${escapeHtml(task?.[`title_${code}`] || "")}">
    </div>
    <div class="field">
      <label class="field__label">${escapeHtml(t("admin.tasks.body_field"))} · ${label}</label>
      <textarea class="textarea" data-field="body_${code}">${escapeHtml(task?.[`body_${code}`] || "")}</textarea>
    </div>`).join("");

  openModal({
    title: task ? t("admin.tasks.edit") : t("admin.tasks.new"),
    bodyHtml: `
      ${fields}
      <div class="field">
        <label class="field__label">${escapeHtml(t("admin.tasks.max_points"))}</label>
        <input class="input input--score" type="number" data-field="max_points" value="${task?.max_points ?? 10}">
      </div>
      ${imagePickerHtml(task?.image_url)}
      <label class="row" style="margin-bottom:var(--space-4)">
        <input type="checkbox" data-field="is_published" ${task?.is_published !== false ? "checked" : ""}
               style="width:22px;height:22px">
        <span>${escapeHtml(t("admin.tasks.publish"))}</span>
      </label>
      <div class="row row-end">
        <button type="button" class="btn btn--primary" data-save>${escapeHtml(task ? t("common.save") : t("admin.tasks.create"))}</button>
      </div>`,
    onMount(box, close) {
      const image = wireImagePicker(box);
      const saveButton = box.querySelector("[data-save]");
      saveButton.addEventListener("click", async () => {
        const payload = {};
        box.querySelectorAll("[data-field]").forEach((element) => {
          const key = element.dataset.field;
          if (element.type === "checkbox") payload[key] = element.checked;
          else if (element.type === "number") payload[key] = Number(element.value || 0);
          else payload[key] = element.value;
        });

        saveButton.disabled = true;
        try {
          const result = task
            ? await api.admin.updateTask(task.id, payload)
            : await api.admin.createTask(payload);
          const taskId = result.task.id;
          await applyImage(
            image,
            Boolean(task?.image_url),
            (file) => api.admin.uploadTaskImage(taskId, file),
            () => api.admin.deleteTaskImage(taskId),
          );
          notify.ok(t(task ? "admin.tasks.updated" : "admin.tasks.created"));
          close();
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
          saveButton.disabled = false;
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Тест                                                               */
/* ------------------------------------------------------------------ */
const PHASE_LABELS = {
  idle: "admin.quiz.phase_idle",
  question: "admin.quiz.phase_question",
  standings: "admin.quiz.phase_standings",
  finished: "admin.quiz.phase_finished",
};

let quizTick = null;
let quizDeadline = 0;
let quizTotal = 0;

function stopQuizTick() {
  if (quizTick) clearInterval(quizTick);
  quizTick = null;
}

/* Живой таймер пульта: цифры тикают локально, перерисовка — по окончании фазы. */
function startQuizTick(quiz) {
  stopQuizTick();
  if (!quiz || quiz.is_paused) return;
  if (quiz.phase !== "question" && quiz.phase !== "standings") return;

  quizTotal = quiz.phase_seconds || 60;
  quizDeadline = Date.now() + (quiz.remaining_seconds ?? quizTotal) * 1000;
  let reloaded = false;

  quizTick = setInterval(() => {
    if (activeTab !== "quiz" || !content.querySelector("[data-quiz-timer]")) {
      stopQuizTick();
      return;
    }
    const seconds = Math.max(0, Math.ceil((quizDeadline - Date.now()) / 1000));
    const percent = quizTotal ? Math.min(100, (seconds / quizTotal) * 100) : 0;
    const value = content.querySelector("[data-quiz-timer-value]");
    const ring = content.querySelector("[data-quiz-timer-ring]");
    if (value) value.textContent = String(seconds);
    if (ring) ring.style.setProperty("--p", `${percent}%`);

    if (seconds <= 0 && !reloaded) {
      reloaded = true;
      setTimeout(() => { if (activeTab === "quiz") render(); }, 900);
    }
  }, 250);
}

function quizControlsHtml(quiz) {
  const live = quiz.phase === "question" || quiz.phase === "standings";
  const started = quiz.phase !== "idle";
  const percent = quiz.phase_seconds
    ? Math.min(100, ((quiz.remaining_seconds ?? 0) / quiz.phase_seconds) * 100)
    : 0;

  return `
    <div class="card card--accent">
      <div class="spread">
        <div style="min-width:0">
          <h3 class="card__title">${escapeHtml(quiz.title || t("quiz.title"))}</h3>
          <div class="muted" style="font-size:.82rem">
            ${escapeHtml(t("quiz.total_questions", { total: quiz.questions_count }))}
            · ${quiz.total_points} ${escapeHtml(t("common.pts"))}
          </div>
        </div>
        <div class="row">
          <span class="badge ${quiz.is_open ? "badge--success" : "badge--danger"}">
            ${escapeHtml(quiz.is_open ? t("admin.quiz.is_open") : t("admin.quiz.is_closed"))}</span>
          <span class="badge badge--info">${escapeHtml(t(PHASE_LABELS[quiz.phase] || "admin.quiz.phase_idle"))}</span>
          ${quiz.is_paused ? `<span class="badge badge--accent">⏸ ${escapeHtml(t("admin.quiz.paused"))}</span>` : ""}
        </div>
      </div>

      <div class="card__body">
        ${live ? `
        <div class="qpult" data-quiz-timer>
          <div class="qtimer" >
            <div class="qtimer__ring" style="--p:${percent}%" data-quiz-timer-ring>
              <span class="qtimer__value" data-quiz-timer-value>${quiz.is_paused ? "||" : (quiz.remaining_seconds ?? 0)}</span>
            </div>
          </div>
          <div>
            <div style="font-weight:700">
              ${escapeHtml(t("quiz.question_of", { n: quiz.current_number, total: quiz.questions_count }))}
            </div>
            <div class="muted" style="font-size:.82rem">
              ${escapeHtml(t(quiz.phase === "question" ? "admin.quiz.phase_question_hint" : "admin.quiz.phase_standings_hint"))}
            </div>
          </div>
        </div>` : ""}

        <div class="row" style="margin-top:var(--space-3)">
          <button type="button" class="btn btn--primary" data-act="start">
            ${escapeHtml(started ? t("admin.quiz.restart") : t("admin.quiz.start"))}</button>
          ${quiz.phase === "question"
            ? `<button type="button" class="btn btn--success" data-act="reveal">🏆 ${escapeHtml(t("admin.quiz.reveal_now"))}</button>`
            : ""}
          <button type="button" class="btn btn--ghost" data-act="prev">⬅️ ${escapeHtml(t("admin.quiz.prev"))}</button>
          <button type="button" class="btn btn--ghost" data-act="next">➡️ ${escapeHtml(t("admin.quiz.next"))}</button>
          ${live ? `
          <button type="button" class="btn btn--ghost" data-act="${quiz.is_paused ? "resume" : "pause"}">
            ${escapeHtml(quiz.is_paused ? `▶️ ${t("admin.quiz.resume")}` : `⏸ ${t("admin.quiz.pause")}`)}</button>
          <button type="button" class="btn btn--ghost" data-extend="15">+15${escapeHtml(t("admin.quiz.sec"))}</button>
          <button type="button" class="btn btn--ghost" data-extend="30">+30${escapeHtml(t("admin.quiz.sec"))}</button>
          <button type="button" class="btn btn--ghost" data-extend="-15">−15${escapeHtml(t("admin.quiz.sec"))}</button>` : ""}
          ${started ? `<button type="button" class="btn btn--ghost" data-act="finish">🏁 ${escapeHtml(t("admin.quiz.finish"))}</button>` : ""}
        </div>

        <div class="row" style="margin-top:var(--space-3)">
          <button type="button" class="btn btn--sm ${quiz.is_open ? "btn--danger" : "btn--primary"}" data-toggle>
            ${escapeHtml(quiz.is_open ? t("admin.quiz.close") : t("admin.quiz.open"))}</button>
          <button type="button" class="btn btn--sm btn--ghost" data-reset>🔄 ${escapeHtml(t("admin.quiz.reset"))}</button>
        </div>

        <div class="qpult-settings">
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.quiz.question_seconds"))}</label>
            <input class="input input--sm input--score" type="number" min="5" max="900"
                   data-setting="question_seconds" value="${quiz.question_seconds}">
          </div>
          <div class="field">
            <label class="field__label">${escapeHtml(t("admin.quiz.standings_seconds"))}</label>
            <input class="input input--sm input--score" type="number" min="5" max="900"
                   data-setting="standings_seconds" value="${quiz.standings_seconds}">
          </div>
          <button type="button" class="btn btn--sm btn--primary" data-save-settings>
            ${escapeHtml(t("common.save"))}</button>
        </div>

        <div class="row" style="margin-top:var(--space-2); flex-wrap:wrap">
          <label class="row">
            <input type="checkbox" data-flag="auto_advance" ${quiz.auto_advance ? "checked" : ""}
                   style="width:22px;height:22px">
            <span style="font-size:.85rem">${escapeHtml(t("admin.quiz.auto_advance"))}</span>
          </label>
          <label class="row">
            <input type="checkbox" data-flag="show_results" ${quiz.show_results ? "checked" : ""}
                   style="width:22px;height:22px">
            <span style="font-size:.85rem">${escapeHtml(t("admin.quiz.show_results"))}</span>
          </label>
        </div>
      </div>
    </div>`;
}

function quizQuestionCardHtml(row, quiz, question) {
  const bars = row.options.map((option, index) => {
    const count = row.distribution[String(index)] || 0;
    const percent = row.answers_count ? Math.round((count * 100) / row.answers_count) : 0;
    const correct = index === row.correct_index;
    return `
      <div style="margin-top:6px">
        <div class="spread" style="font-size:.82rem">
          <span>${correct ? "✅ " : ""}${escapeHtml(option)}</span>
          <span class="muted">${count} · ${percent}%</span>
        </div>
        <div class="progress"><div class="progress__bar" style="width:${percent}%;
          ${correct ? "background:linear-gradient(90deg,#34d399,#a7f3d0)" : ""}"></div></div>
      </div>`;
  }).join("");

  return `
    <article class="card ${row.is_current ? "card--current" : ""}">
      <div class="card__head">
        <div style="min-width:0">
          <strong>${row.order}. ${escapeHtml(row.text)}</strong>
          ${row.is_current ? `<span class="badge badge--accent" style="margin-left:6px">${escapeHtml(t("admin.quiz.current"))}</span>` : ""}
        </div>
        <div class="row">
          <span class="badge badge--info">${escapeHtml(t("admin.quiz.answers_count"))}: ${row.answers_count}</span>
          <span class="badge badge--success">${escapeHtml(t("admin.quiz.correct_count"))}: ${row.correct_count}</span>
          <button type="button" class="btn btn--sm btn--ghost" data-goto="${row.index}"
            ${quiz?.questions_count ? "" : "disabled"}>▶️ ${escapeHtml(t("admin.quiz.goto"))}</button>
          <button type="button" class="btn btn--icon btn--ghost qpult-close" data-edit-question="${row.question_id}"
            title="${escapeHtml(t("admin.quiz.edit_question"))}"
            aria-label="${escapeHtml(t("admin.quiz.edit_question"))}">✏️</button>
          <button type="button" class="btn btn--icon btn--danger qpult-close" data-delete-question="${row.question_id}"
            title="${escapeHtml(t("admin.quiz.delete_question"))}"
            aria-label="${escapeHtml(t("admin.quiz.delete_question"))}">✕</button>
        </div>
      </div>
      <div class="card__body">
        ${question?.image_url ? `<img class="content-image content-image--sm" src="${fileUrl(question.image_url)}" alt="">` : ""}
        ${bars}
        <div class="muted" style="font-size:.78rem; margin-top:var(--space-2)">
          ${escapeHtml(t("admin.quiz.points"))}: ${row.points ?? question?.points ?? ""}</div>
      </div>
    </article>`;
}

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];
const QUIZ_LANGS = [["kk", "ҚАЗ"], ["ru", "РУС"], ["en", "ENG"]];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

function openQuestionModal(question, onDone) {
  const count = Math.max(
    MIN_OPTIONS,
    question?.options_ru?.length || question?.options_en?.length || question?.options_kk?.length || 4,
  );
  const options = Array.from({ length: count }, (_, index) => ({
    kk: question?.options_kk?.[index] || "",
    ru: question?.options_ru?.[index] || "",
    en: question?.options_en?.[index] || "",
  }));
  let correct = question?.correct_index ?? 0;

  const textFields = QUIZ_LANGS.map(([code, label]) => `
    <div class="field">
      <label class="field__label">${escapeHtml(t("admin.quiz.question_text"))} · ${label}</label>
      <textarea class="textarea" rows="2" data-qtext="${code}">${escapeHtml(question?.[`text_${code}`] || "")}</textarea>
    </div>`).join("");

  openModal({
    title: question ? t("admin.quiz.edit_question") : t("admin.quiz.new_question"),
    bodyHtml: `
      <p class="muted" style="margin-top:0; font-size:.85rem">${escapeHtml(t("admin.quiz.edit_hint"))}</p>
      ${textFields}
      <div class="field__label" style="margin-bottom:var(--space-2)">${escapeHtml(t("admin.quiz.options"))}</div>
      <div class="stack" data-options></div>
      <button type="button" class="btn btn--sm btn--ghost" data-add-option
        style="margin:var(--space-3) 0 var(--space-4)">➕ ${escapeHtml(t("admin.quiz.add_option"))}</button>
      <div class="field">
        <label class="field__label">${escapeHtml(t("admin.quiz.points"))}</label>
        <input class="input input--score" type="number" min="0" max="100" data-qpoints value="${question?.points ?? 2}">
      </div>
      ${imagePickerHtml(question?.image_url)}
      <div class="row row-end">
        <button type="button" class="btn btn--primary" data-save>
          ${escapeHtml(question ? t("common.save") : t("admin.quiz.add_question"))}</button>
      </div>`,
    onMount(box, close) {
      const list = box.querySelector("[data-options]");
      const addButton = box.querySelector("[data-add-option]");
      const saveButton = box.querySelector("[data-save]");
      const image = wireImagePicker(box);

      const collect = () => {
        list.querySelectorAll("[data-option]").forEach((row) => {
          const index = Number(row.dataset.option);
          QUIZ_LANGS.forEach(([code]) => {
            options[index][code] = row.querySelector(`[data-opt-lang="${code}"]`).value;
          });
        });
        const checked = list.querySelector('input[name="q-correct"]:checked');
        if (checked) correct = Number(checked.value);
      };

      const draw = () => {
        list.innerHTML = options.map((option, index) => `
          <div class="qedit-option ${index === correct ? "is-correct" : ""}" data-option="${index}">
            <div class="spread">
              <label class="row qedit-option__correct">
                <input type="radio" name="q-correct" value="${index}" ${index === correct ? "checked" : ""}>
                <strong>${OPTION_LETTERS[index]}</strong>
                <span class="muted">${escapeHtml(t(index === correct ? "admin.quiz.is_correct" : "admin.quiz.mark_correct"))}</span>
              </label>
              <button type="button" class="btn btn--icon btn--ghost qpult-close" data-remove-option="${index}"
                ${options.length <= MIN_OPTIONS ? "disabled" : ""}
                title="${escapeHtml(t("admin.quiz.remove_option"))}"
                aria-label="${escapeHtml(t("admin.quiz.remove_option"))}">✕</button>
            </div>
            ${QUIZ_LANGS.map(([code, label]) => `
              <label class="qedit-lang">
                <span class="qedit-lang__tag">${label}</span>
                <input class="input" data-opt-lang="${code}" value="${escapeHtml(option[code])}">
              </label>`).join("")}
          </div>`).join("");
        addButton.disabled = options.length >= MAX_OPTIONS;
      };

      list.addEventListener("change", (event) => {
        if (event.target.name !== "q-correct") return;
        collect();
        draw();
      });

      list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-remove-option]");
        if (!button || options.length <= MIN_OPTIONS) return;
        collect();
        const index = Number(button.dataset.removeOption);
        options.splice(index, 1);
        if (correct === index) correct = 0;
        else if (correct > index) correct -= 1;
        draw();
      });

      addButton.addEventListener("click", () => {
        collect();
        if (options.length < MAX_OPTIONS) options.push({ kk: "", ru: "", en: "" });
        draw();
      });

      saveButton.addEventListener("click", async () => {
        collect();
        const payload = {
          correct_index: correct,
          points: Number(box.querySelector("[data-qpoints]").value || 0),
        };
        QUIZ_LANGS.forEach(([code]) => {
          payload[`text_${code}`] = box.querySelector(`[data-qtext="${code}"]`).value.trim();
          payload[`options_${code}`] = options.map((option) => option[code].trim());
        });

        saveButton.disabled = true;
        try {
          const result = question
            ? await api.admin.updateQuestion(question.id, payload)
            : await api.admin.createQuestion(payload);
          const questionId = result.question.id;
          await applyImage(
            image,
            Boolean(question?.image_url),
            (file) => api.admin.uploadQuestionImage(questionId, file),
            () => api.admin.deleteQuestionImage(questionId),
          );
          notify.ok(t(question ? "admin.quiz.question_saved" : "admin.quiz.question_created"));
          close();
          onDone();
        } catch (error) {
          notify.err(apiErrorMessage(error));
          saveButton.disabled = false;
        }
      });

      draw();
    },
  });
}

const quizTab = {
  stateKeys: ["quiz", "leaderboard"],

  async render() {
    stopQuizTick();
    const [results, editable] = await Promise.all([
      api.admin.quizResults(),
      api.admin.quizQuestions(),
    ]);
    const quiz = results.quiz;

    if (!quiz) {
      content.innerHTML = emptyState("admin.subs.empty", "🧠");
      return;
    }

    const questionsById = new Map((editable.questions || []).map((question) => [question.id, question]));
    const rows = (results.rows || [])
      .map((row) => quizQuestionCardHtml(row, quiz, questionsById.get(row.question_id)))
      .join("");

    content.innerHTML = `
      ${quizControlsHtml(quiz)}
      <div class="spread" style="margin-top:var(--space-5)">
        <h3 style="margin:0">${escapeHtml(t("admin.quiz.questions"))}</h3>
        <button type="button" class="btn btn--sm btn--primary" data-add-question>
          ➕ ${escapeHtml(t("admin.quiz.add_question"))}</button>
      </div>
      <div class="muted" style="font-size:.82rem; margin:var(--space-2) 0 var(--space-3)">
        ${escapeHtml(t("admin.quiz.goto_hint"))}
      </div>
      <div class="stack">${rows || emptyState("admin.subs.empty", "🧠")}</div>`;

    content.querySelector("[data-add-question]").addEventListener("click", () => {
      openQuestionModal(null, render);
    });

    content.querySelectorAll("[data-edit-question]").forEach((button) => {
      button.addEventListener("click", () => {
        const question = questionsById.get(Number(button.dataset.editQuestion));
        if (question) openQuestionModal(question, render);
      });
    });

    content.querySelectorAll("[data-delete-question]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!await confirmDialog(t("admin.quiz.confirm_delete_question"))) return;
        try {
          await api.admin.deleteQuestion(Number(button.dataset.deleteQuestion));
          notify.ok(t("admin.quiz.question_deleted"));
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
        render();
      });
    });

    const control = async (action, payload = {}) => {
      try {
        await api.admin.quizControl(action, payload);
        notify.ok(t("admin.quiz.applied"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    };

    content.querySelectorAll("[data-act]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.act;
        if (action === "start") {
          const fresh = quiz.phase === "idle"
            ? true
            : await confirmDialog(t("admin.quiz.confirm_restart"));
          if (quiz.phase !== "idle" && !fresh) return;
          await control("start", { index: 0, reset_answers: quiz.phase !== "idle" });
          return;
        }
        if (action === "finish" && !await confirmDialog(t("admin.quiz.confirm_finish"))) return;
        await control(action);
      });
    });

    content.querySelectorAll("[data-extend]").forEach((button) => {
      button.addEventListener("click", () => control("extend", {
        seconds: Number(button.dataset.extend),
      }));
    });

    content.querySelectorAll("[data-goto]").forEach((button) => {
      button.addEventListener("click", () => control("goto", {
        index: Number(button.dataset.goto),
      }));
    });

    content.querySelector("[data-save-settings]").addEventListener("click", async () => {
      const payload = {};
      content.querySelectorAll("[data-setting]").forEach((input) => {
        payload[input.dataset.setting] = Number(input.value || 0);
      });
      try {
        await api.admin.quizSettings(payload);
        notify.ok(t("admin.quiz.settings_saved"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    });

    content.querySelectorAll("[data-flag]").forEach((box) => {
      box.addEventListener("change", async () => {
        try {
          await api.admin.quizSettings({ [box.dataset.flag]: box.checked });
          notify.ok(t("common.saved"));
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
        render();
      });
    });

    content.querySelector("[data-toggle]").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const result = await api.admin.toggleQuiz({ is_open: !quiz.is_open });
        notify.ok(t(result.quiz.is_open ? "admin.quiz.opened" : "admin.quiz.closed"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    });

    content.querySelector("[data-reset]").addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.quiz.confirm_reset"))) return;
      try {
        await api.admin.resetQuiz();
        notify.ok(t("admin.quiz.reset_done"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
      render();
    });

    startQuizTick(quiz);
  },
};

/* ------------------------------------------------------------------ */
/* Ответы команд                                                      */
/* ------------------------------------------------------------------ */
const submissionsTab = {
  stateKeys: ["submissions", "tasks", "leaderboard"],
  taskFilter: "",
  teamFilter: "",

  async render() {
    const params = new URLSearchParams();
    if (this.taskFilter) params.set("task_id", this.taskFilter);
    if (this.teamFilter) params.set("team_id", this.teamFilter);
    const query = params.toString() ? `?${params}` : "";

    const [subs, tasks, teams] = await Promise.all([
      api.admin.submissions(query),
      api.admin.tasks(),
      teamsCache.length ? Promise.resolve({ teams: teamsCache }) : api.admin.teams(),
    ]);
    teamsCache = teams.teams;

    const taskOptions = [`<option value="">${escapeHtml(t("admin.subs.filter_task"))}</option>`]
      .concat(tasks.tasks.map((task) =>
        `<option value="${task.id}" ${String(task.id) === this.taskFilter ? "selected" : ""}>${escapeHtml(task.title)}</option>`))
      .join("");

    const teamOptions = [`<option value="">${escapeHtml(t("admin.subs.filter_team"))}</option>`]
      .concat(teamsCache.map((team) =>
        `<option value="${team.id}" ${String(team.id) === this.teamFilter ? "selected" : ""}>#${String(team.number).padStart(2, "0")} ${escapeHtml(team.name)}</option>`))
      .join("");

    content.innerHTML = `
      <div class="spread" style="margin-bottom:var(--space-4); gap:var(--space-3)">
        <div class="row" style="flex:1 1 auto">
          <select class="select select--sm" id="filter-task" style="max-width:260px">${taskOptions}</select>
          <select class="select select--sm" id="filter-team" style="max-width:260px">${teamOptions}</select>
        </div>
        <button type="button" class="btn btn--sm btn--danger" data-reset-subs
          ${subs.submissions.length ? "" : "disabled"}>
          🔄 ${escapeHtml(t("admin.subs.reset_all"))}</button>
      </div>
      <div class="stack">${subs.submissions.length
        ? subs.submissions.map(submissionCardHtml).join("")
        : emptyState("admin.subs.empty", "📨")}</div>`;

    content.querySelector("#filter-task").addEventListener("change", (event) => {
      this.taskFilter = event.target.value;
      render();
    });
    content.querySelector("#filter-team").addEventListener("change", (event) => {
      this.teamFilter = event.target.value;
      render();
    });

    content.querySelector("[data-reset-subs]").addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.subs.confirm_reset_all"))) return;
      try {
        await api.admin.resetSubmissions();
        notify.ok(t("admin.subs.reset_done"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    content.querySelectorAll("[data-grade]").forEach((button) => {
      button.addEventListener("click", async () => {
        const submissionId = Number(button.dataset.grade);
        const input = content.querySelector(`[data-points="${submissionId}"]`);
        try {
          await api.admin.gradeSubmission(submissionId, Number(input.value || 0));
          notify.ok(t("admin.subs.graded"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    });

    content.querySelectorAll("[data-delete-sub]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!await confirmDialog(t("admin.subs.confirm_delete"))) return;
        try {
          await api.admin.deleteSubmission(Number(button.dataset.deleteSub));
          notify.ok(t("admin.subs.deleted"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    });
  },
};

function submissionCardHtml(submission) {
  const media = submission.attachments.map((file) => {
    const src = fileUrl(file.url);
    const element = file.kind === "video"
      ? `<video src="${src}" controls preload="metadata" playsinline></video>`
      : `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="" loading="lazy"></a>`;
    return `<div class="media-item">${element}
      <div class="media-item__label">${escapeHtml(file.original_name)} · ${formatBytes(file.size_bytes)}</div></div>`;
  }).join("");

  return `
    <article class="card">
      <div class="card__head">
        <div style="min-width:0">
          <strong>${escapeHtml(submission.team_name)}</strong>
          <div class="muted" style="font-size:.78rem">
            ${escapeHtml(submission.task_title)} · ${escapeHtml(t("admin.subs.author"))}: ${escapeHtml(submission.author)}
            · ${formatTime(submission.updated_at)}
          </div>
        </div>
        <div class="row">
          <input class="input input--sm input--score" type="number" min="0" value="${submission.points}"
                 data-points="${submission.id}">
          <button type="button" class="btn btn--sm btn--primary" data-grade="${submission.id}">
            ${escapeHtml(t("admin.subs.grade"))}</button>
          <button type="button" class="btn btn--sm btn--danger" data-delete-sub="${submission.id}">
            🗑️ ${escapeHtml(t("admin.subs.delete"))}</button>
        </div>
      </div>
      <div class="card__body">
        <div>${submission.text ? nl2br(submission.text) : `<span class="muted">${escapeHtml(t("admin.subs.no_text"))}</span>`}</div>
        ${media ? `<div class="media-grid" style="margin-top:var(--space-3)">${media}</div>` : ""}
      </div>
    </article>`;
}

/* ------------------------------------------------------------------ */
/* Голоса                                                             */
/* ------------------------------------------------------------------ */
const votesTab = {
  stateKeys: ["votes", "task3"],

  async render() {
    const data = await api.admin.allVotes();

    const cardRows = data.cards.map((card) => `
      <article class="card card--flat spread">
        <div class="row" style="min-width:0">
          <span class="badge badge--accent">${card.number}</span>
          <div style="min-width:0">
            <strong>${escapeHtml(t("admin.votes.room"))} №${escapeHtml(card.room)}</strong>
            <div class="muted" style="font-size:.82rem">
              ${card.taken
                ? `${escapeHtml(card.team_name)} · ${escapeHtml(card.picked_by)} · ${formatTime(card.picked_at)}`
                : escapeHtml(t("vote.cards.free"))}
            </div>
          </div>
        </div>
        ${card.taken ? `
        <button type="button" class="btn btn--sm btn--ghost" data-release-card="${card.number}">
          ↩️ ${escapeHtml(t("admin.votes.release"))}</button>` : ""}
      </article>`).join("");

    content.innerHTML = `
      <div class="spread" style="margin-bottom:var(--space-4)">
        <h3 style="margin:0">${escapeHtml(t("admin.votes.cards_title"))} · ${data.taken_count}/${data.cards.length}</h3>
        <button type="button" class="btn btn--sm btn--danger" data-reset-cards>
          🔄 ${escapeHtml(t("admin.votes.reset"))}</button>
      </div>

      <div class="card card--flat spread" style="margin-bottom:var(--space-4)">
        <div style="min-width:0">
          <span class="badge ${data.visible ? "badge--success" : "badge--muted"}">
            ${escapeHtml(t(data.visible ? "admin.votes.visible_badge" : "admin.votes.hidden_badge"))}</span>
          <div class="muted" style="font-size:.8rem; margin-top:4px">${escapeHtml(t("admin.votes.visibility_hint"))}</div>
        </div>
        <button type="button" class="btn btn--sm ${data.visible ? "btn--ghost" : "btn--success"}" data-toggle-visible>
          ${data.visible ? "🙈" : "👁️"} ${escapeHtml(t(data.visible ? "admin.votes.hide" : "admin.votes.show"))}</button>
      </div>

      <div class="stack">${cardRows}</div>

      ${(data.galleries || []).filter((gallery) => gallery.round?.likes_enabled).map((gallery) => `
      <div class="spread" style="margin-top:var(--space-5); margin-bottom:var(--space-3)">
        <h3 style="margin:0">${escapeHtml(t("admin.votes.projects_n", { n: gallery.task_order }))}</h3>
      </div>
      <div class="stack" style="margin-bottom:var(--space-4)">
        ${gallery.projects.length
          ? [...gallery.projects].sort((a, b) => b.likes - a.likes || a.team_number - b.team_number).map((project, index) => `
          <article class="card card--flat spread">
            <div class="row" style="min-width:0">
              <span class="badge badge--accent">#${index + 1}</span>
              <div style="min-width:0">
                <strong>${escapeHtml(project.title)}</strong>
                <div class="muted" style="font-size:.78rem">#${String(project.team_number).padStart(2, "0")}</div>
              </div>
            </div>
            <span class="badge badge--info">❤️ ${project.likes}</span>
          </article>`).join("")
          : `<div class="muted">${escapeHtml(t("vote.round.empty"))}</div>`}
      </div>`).join("")}
      ${(data.galleries || []).some((gallery) => gallery.round?.likes_enabled) ? `
      <div class="row" style="margin-bottom:var(--space-5)">
        <button type="button" class="btn btn--sm btn--danger" data-reset-likes>
          🔄 ${escapeHtml(t("admin.votes.reset_likes"))}</button>
      </div>` : ""}

`;

    content.querySelector("[data-reset-cards]").addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.votes.confirm_reset"))) return;
      try {
        await api.admin.resetCards();
        notify.ok(t("admin.votes.reset_done"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    content.querySelector("[data-toggle-visible]").addEventListener("click", async () => {
      try {
        await api.admin.setCardsVisible(!data.visible);
        notify.ok(t("common.saved"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    content.querySelectorAll("[data-release-card]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!await confirmDialog(t("admin.votes.confirm_release"))) return;
        try {
          await api.admin.releaseCard(Number(button.dataset.releaseCard));
          notify.ok(t("admin.votes.released"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    });

    content.querySelector("[data-reset-likes]")?.addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.votes.confirm_reset_likes"))) return;
      try {
        await api.admin.resetProjectVotes();
        notify.ok(t("admin.votes.likes_reset"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });
  },
};

/* ------------------------------------------------------------------ */
/* Рейтинг                                                            */
/* ------------------------------------------------------------------ */
const ratingTab = {
  stateKeys: ["leaderboard", "quiz", "submissions", "teams"],

  async render() {
    const data = await api.leaderboard();
    const rows = data.teams.map((row) => `
      <tr>
        <td>${rankMedal(row.rank)}</td>
        <td><strong>${escapeHtml(row.name)}</strong> <span class="muted">#${String(row.number).padStart(2, "0")}</span></td>
        <td class="nums">${row.task_points}</td>
        <td class="nums">${row.quiz_points}</td>
        <td class="nums">${row.bonus_points}</td>
        <td class="nums"><strong>${row.total_points}</strong></td>
        <td class="nums">${row.submissions_count} 📨 / ${row.quiz_answered} 🧠</td>
      </tr>`).join("");

    content.innerHTML = `
      <div class="spread" style="margin-bottom:var(--space-4); gap:var(--space-3)">
        <div>
          <h3 style="margin:0">${escapeHtml(t("admin.rating.title"))}</h3>
          <div class="muted" style="font-size:.82rem">${escapeHtml(t("admin.rating.hint"))}</div>
        </div>
        <div class="row">
          <span class="row"><span class="live-dot"></span> ${escapeHtml(t("common.live"))}</span>
          <button type="button" class="btn btn--sm btn--danger" data-reset-scores>
            🔄 ${escapeHtml(t("admin.rating.reset_scores"))}</button>
        </div>
      </div>

      ${data.teams.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${escapeHtml(t("rating.rank"))}</th>
            <th>${escapeHtml(t("rating.team"))}</th>
            <th>${escapeHtml(t("rating.tasks"))}</th>
            <th>${escapeHtml(t("rating.quiz"))}</th>
            <th>${escapeHtml(t("rating.bonus"))}</th>
            <th>${escapeHtml(t("rating.total"))}</th>
            <th>📨/🧠</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : emptyState("rating.empty", "🏁")}`;

    content.querySelector("[data-reset-scores]")?.addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.rating.confirm_reset_scores"))) return;
      try {
        await api.admin.resetScores();
        notify.ok(t("admin.rating.scores_reset"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });
  },
};

/* ------------------------------------------------------------------ */
/* Оболочка                                                           */
/* ------------------------------------------------------------------ */
let adminThreadUser = null;

function updateAdminMsgTab(count) {
  const button = document.querySelector('.tab[data-tab="messages"]');
  if (!button) return;
  const label = t("admin.tab.messages");
  button.textContent = count ? `${label} (${count})` : label;
}

const messagesTab = {
  stateKeys: ["messages"],

  async render() {
    if (adminThreadUser) {
      await renderAdminThread(adminThreadUser);
      return;
    }

    const data = await api.admin.messageThreads();
    updateAdminMsgTab(data.unread || 0);

    const rows = (data.threads || []).map((thread) => `
      <button type="button" class="card card--flat chat-thread ${thread.unread ? "has-unread" : ""}" data-open-thread="${thread.user_id}">
        <div class="spread">
          <div style="min-width:0; text-align:left">
            <strong>${escapeHtml(thread.display_name || thread.login)}</strong>
            <div class="muted" style="font-size:.78rem">
              ${escapeHtml(thread.login)} · ${escapeHtml(roleLabel(thread.role))}
              ${thread.team_name ? ` · ${escapeHtml(thread.team_name)}` : ""}
            </div>
            <div class="muted" style="margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
              ${escapeHtml(thread.last_body)}
            </div>
          </div>
          <div class="stack" style="justify-items:end">
            ${thread.unread ? `<span class="badge badge--accent">${thread.unread}</span>` : ""}
            <span class="muted" style="font-size:.72rem">${escapeHtml(formatTime(thread.last_at))}</span>
          </div>
        </div>
      </button>`).join("");

    content.innerHTML = `
      <div class="spread" style="margin-bottom:var(--space-4); gap:var(--space-3)">
        <div>
          <h3 style="margin:0">💬 ${escapeHtml(t("admin.messages.title"))}</h3>
          <div class="muted" style="font-size:.82rem">${escapeHtml(t("admin.messages.hint"))}</div>
        </div>
        <div class="row" style="flex-wrap:wrap; justify-content:flex-end">
          <span class="badge badge--info">${data.unread || 0} ${escapeHtml(t("admin.messages.unread"))}</span>
          <button type="button" class="btn btn--sm btn--danger" data-reset-chats>
            ${escapeHtml(t("admin.messages.reset_all"))}</button>
        </div>
      </div>
      <div class="stack">${rows || emptyState("admin.messages.empty", "💬")}</div>`;

    content.querySelectorAll("[data-open-thread]").forEach((button) => {
      button.addEventListener("click", () => {
        adminThreadUser = Number(button.dataset.openThread);
        render();
      });
    });

    content.querySelector("[data-reset-chats]")?.addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.messages.confirm_reset_all"))) return;
      try {
        await api.admin.resetMessages();
        adminThreadUser = null;
        notify.ok(t("admin.messages.reset_done"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });
  },
};

async function renderAdminThread(userId) {
  const data = await api.admin.messageThread(userId);
  const person = data.user;
  const myId = store.user?.id;
  const bubbles = (data.messages || []).map((row) => {
    const mine = row.author_id === myId || row.author_role === "admin";
    const name = row.author_role === "admin"
      ? t("messages.admin")
      : (row.author_name || row.author_login);
    return `
      <div class="chat-row ${mine ? "is-mine" : ""}">
        <div class="chat-bubble">
          <div class="chat-bubble__meta">${escapeHtml(name)} · ${escapeHtml(formatTime(row.created_at))}</div>
          <div class="chat-bubble__text">${escapeHtml(row.body)}</div>
        </div>
      </div>`;
  }).join("");

  content.innerHTML = `
    <div class="row" style="margin-bottom:var(--space-3)">
      <button type="button" class="btn btn--sm btn--ghost" data-back-threads>← ${escapeHtml(t("admin.messages.back"))}</button>
    </div>
    <div class="card chat">
      <div class="spread" style="margin-bottom:var(--space-3)">
        <div>
          <strong>${escapeHtml(person.display_name || person.login)}</strong>
          <div class="muted" style="font-size:.78rem">
            ${escapeHtml(person.login)} · ${escapeHtml(roleLabel(person.role))}
            ${person.team_name ? ` · ${escapeHtml(person.team_name)}` : ""}
          </div>
          ${person.school || person.grade || person.about ? `
          <div class="muted" style="font-size:.78rem; margin-top:4px">
            ${escapeHtml([person.school, person.grade].filter(Boolean).join(" · "))}
            ${person.about ? `<br>${escapeHtml(person.about)}` : ""}
          </div>` : ""}
        </div>
      </div>
      <div class="chat__list" id="admin-chat-list">
        ${bubbles || `<div class="empty">${escapeHtml(t("messages.empty_thread"))}</div>`}
      </div>
      <div class="chat__composer">
        <textarea class="textarea" id="admin-msg-input" rows="2" maxlength="1000"
                  placeholder="${escapeHtml(t("admin.messages.reply_ph"))}"></textarea>
        <button type="button" class="btn btn--primary" data-admin-send>${escapeHtml(t("common.send"))}</button>
      </div>
    </div>`;

  const list = content.querySelector("#admin-chat-list");
  list.scrollTop = list.scrollHeight;

  content.querySelector("[data-back-threads]").addEventListener("click", () => {
    adminThreadUser = null;
    render();
  });

  const send = async () => {
    const input = content.querySelector("#admin-msg-input");
    const text = input.value.trim();
    if (!text) return;
    try {
      await api.admin.replyMessage(userId, text);
      input.value = "";
      await renderAdminThread(userId);
    } catch (error) {
      notify.err(apiErrorMessage(error));
    }
  };
  content.querySelector("[data-admin-send]").addEventListener("click", send);
  content.querySelector("#admin-msg-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
}

const TABS = {
  overview: overviewTab,
  teams: teamsTab,
  tasks: tasksTab,
  quiz: quizTab,
  submissions: submissionsTab,
  messages: messagesTab,
  votes: votesTab,
  rating: ratingTab,
};

async function render() {
  const tab = TABS[activeTab];
  if (!tab) return;
  try {
    await tab.render();
    applyTranslations(content);
  } catch (error) {
    content.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
  }
}

async function activate(tabId) {
  if (!TABS[tabId]) tabId = "overview";
  stopQuizTick();
  activeTab = tabId;
  localStorage.setItem(TAB_KEY, tabId);
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabId);
  });
  content.innerHTML = loaderBlock();
  await render();
}

(async function boot() {
  if (!auth.requireLogin()) return;
  await initI18n();
  mountLangSwitch(document.querySelector("[data-lang-switch]"));

  let me;
  try {
    me = await api.me();
  } catch {
    auth.clear();
    window.location.replace("/");
    return;
  }

  if (me.user.role !== "admin") {
    window.location.replace("/app");
    return;
  }
  store.user = me.user;
  document.getElementById("header-user").textContent = `${me.user.login} · ${roleLabel(me.user.role)}`;

  document.getElementById("admin-tabs").addEventListener("click", (event) => {
    const button = event.target.closest(".tab");
    if (button) activate(button.dataset.tab);
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {
      /* игнорируем */
    }
    auth.clear();
    window.location.replace("/");
  });

  // Автообновление активной вкладки при изменениях на сервере.
  subscribe(
    ["teams", "tasks", "votes", "quiz", "leaderboard", "submissions", "messages", "task3"],
    (key) => {
      if (key === "messages") updateAdminMsgTab(store.unreadMessages || 0);
      if (TABS[activeTab]?.stateKeys.includes(key)) render();
    },
  );
  startPolling();

  window.addEventListener("tiger:langchange", render);

  await activate(localStorage.getItem(TAB_KEY) || "overview");
})();
