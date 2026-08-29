/* Панель администратора: команды, баллы, задания, тест, ответы, голоса, рейтинг. */

import { api, auth } from "./api.js";
import { applyTranslations, initI18n, mountLangSwitch, t } from "./i18n.js";
import { startPolling, store, subscribe } from "./store.js";
import {
  apiErrorMessage,
  confirmDialog,
  emptyState,
  escapeHtml,
  formatBytes,
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
          <span class="badge ${data.quiz?.is_open ? "badge--success" : "badge--danger"}">
            ${escapeHtml(data.quiz?.is_open ? t("admin.quiz.is_open") : t("admin.quiz.is_closed"))}
          </span>
        </div>
        <div class="card__body row">
          <button type="button" class="btn ${data.quiz?.is_open ? "btn--danger" : "btn--primary"}" data-quiz-toggle>
            ${escapeHtml(data.quiz?.is_open ? t("admin.quiz.close") : t("admin.quiz.open"))}
          </button>
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
const tasksTab = {
  stateKeys: ["tasks", "submissions"],

  async render() {
    const data = await api.admin.tasks();
    content.innerHTML = `
      <div class="row" style="margin-bottom:var(--space-4)">
        <button type="button" class="btn btn--primary" data-new-task>➕ ${escapeHtml(t("admin.tasks.new"))}</button>
      </div>
      <div class="stack">${data.tasks.length
        ? data.tasks.map(taskCardHtml).join("")
        : emptyState("admin.tasks.empty", "📋")}</div>`;

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
      <label class="row" style="margin-bottom:var(--space-4)">
        <input type="checkbox" data-field="is_published" ${task?.is_published !== false ? "checked" : ""}
               style="width:22px;height:22px">
        <span>${escapeHtml(t("admin.tasks.publish"))}</span>
      </label>
      <div class="row row-end">
        <button type="button" class="btn btn--primary" data-save>${escapeHtml(task ? t("common.save") : t("admin.tasks.create"))}</button>
      </div>`,
    onMount(box, close) {
      box.querySelector("[data-save]").addEventListener("click", async () => {
        const payload = {};
        box.querySelectorAll("[data-field]").forEach((element) => {
          const key = element.dataset.field;
          if (element.type === "checkbox") payload[key] = element.checked;
          else if (element.type === "number") payload[key] = Number(element.value || 0);
          else payload[key] = element.value;
        });

        try {
          if (task) await api.admin.updateTask(task.id, payload);
          else await api.admin.createTask(payload);
          notify.ok(t(task ? "admin.tasks.updated" : "admin.tasks.created"));
          close();
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Тест                                                               */
/* ------------------------------------------------------------------ */
const quizTab = {
  stateKeys: ["quiz"],

  async render() {
    const [state, results] = await Promise.all([
      api.admin.quizQuestions(),
      api.admin.quizResults(),
    ]);
    const quiz = state.quiz || results.quiz;

    const rows = (results.rows || []).map((row) => {
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
        <article class="card">
          <div class="card__head">
            <div><strong>${row.order}. ${escapeHtml(row.text)}</strong></div>
            <div class="row">
              <span class="badge badge--info">${escapeHtml(t("admin.quiz.answers_count"))}: ${row.answers_count}</span>
              <span class="badge badge--success">${escapeHtml(t("admin.quiz.correct_count"))}: ${row.correct_count}</span>
            </div>
          </div>
          <div class="card__body">${bars}</div>
        </article>`;
    }).join("");

    content.innerHTML = `
      <div class="card card--accent">
        <div class="spread">
          <div>
            <h3 class="card__title">${escapeHtml(quiz?.title || t("quiz.title"))}</h3>
            <div class="muted" style="font-size:.82rem">
              ${quiz?.questions_count || 0} ${escapeHtml(t("quiz.question"))} · ${quiz?.total_points || 0} ${escapeHtml(t("common.pts"))}
            </div>
          </div>
          <span class="badge ${quiz?.is_open ? "badge--success" : "badge--danger"}">
            ${escapeHtml(quiz?.is_open ? t("admin.quiz.is_open") : t("admin.quiz.is_closed"))}</span>
        </div>
        <div class="card__body row">
          <button type="button" class="btn ${quiz?.is_open ? "btn--danger" : "btn--primary"}" data-toggle>
            ${escapeHtml(quiz?.is_open ? t("admin.quiz.close") : t("admin.quiz.open"))}</button>
          <button type="button" class="btn btn--ghost" data-reset>🔄 ${escapeHtml(t("admin.quiz.reset"))}</button>
          <label class="row" style="margin-left:auto">
            <input type="checkbox" data-show-results ${quiz?.show_results ? "checked" : ""}
                   style="width:22px;height:22px">
            <span style="font-size:.85rem">${escapeHtml(t("admin.quiz.show_results"))}</span>
          </label>
        </div>
      </div>

      <h3 style="margin-top:var(--space-5)">${escapeHtml(t("admin.quiz.questions"))}</h3>
      <div class="stack">${rows || emptyState("admin.subs.empty", "🧠")}</div>`;

    content.querySelector("[data-toggle]").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try {
        const result = await api.admin.toggleQuiz({ is_open: !quiz?.is_open });
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
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    content.querySelector("[data-show-results]").addEventListener("change", async (event) => {
      try {
        await api.admin.toggleQuiz({ is_open: quiz?.is_open, show_results: event.target.checked });
        notify.ok(t("common.saved"));
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });
  },
};

/* ------------------------------------------------------------------ */
/* Ответы команд                                                      */
/* ------------------------------------------------------------------ */
const submissionsTab = {
  stateKeys: ["submissions", "tasks"],
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
      <div class="row" style="margin-bottom:var(--space-4)">
        <select class="select select--sm" id="filter-task" style="max-width:260px">${taskOptions}</select>
        <select class="select select--sm" id="filter-team" style="max-width:260px">${teamOptions}</select>
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
  },
};

function submissionCardHtml(submission) {
  const media = submission.attachments.map((file) => {
    const element = file.kind === "video"
      ? `<video src="${file.url}" controls preload="metadata"></video>`
      : `<a href="${file.url}" target="_blank" rel="noopener"><img src="${file.url}" alt="" loading="lazy"></a>`;
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
  stateKeys: ["votes"],

  async render() {
    const data = await api.admin.allVotes();

    const sectionRows = data.sections.map((section) => `
      <article class="card">
        <div class="spread">
          <div class="row" style="min-width:0">
            <span style="font-size:1.5rem">${section.icon || "🔬"}</span>
            <div>
              <strong>${escapeHtml(section.name)}</strong>
              <div class="muted" style="font-size:.78rem">${section.votes} ${escapeHtml(t("vote.votes"))} · ${section.percent}%</div>
            </div>
          </div>
          <button type="button" class="btn btn--sm ${section.is_open ? "btn--ghost" : "btn--success"}"
            data-toggle-section="${section.id}" data-open="${section.is_open ? "1" : "0"}">
            ${escapeHtml(section.is_open ? t("admin.votes.close_section") : t("admin.votes.open_section"))}</button>
        </div>
        <div class="progress" style="margin-top:var(--space-2)">
          <div class="progress__bar" style="width:${section.percent}%"></div>
        </div>
      </article>`).join("");

    const voteRows = data.votes.map((vote) => `
      <tr>
        <td>${escapeHtml(vote.user_login)}</td>
        <td>${escapeHtml(roleLabel(vote.user_role))}</td>
        <td>${escapeHtml(vote.team_name)}</td>
        <td>${escapeHtml(vote.section_name)}</td>
        <td class="nums">${formatTime(vote.updated_at)}</td>
      </tr>`).join("");

    content.innerHTML = `
      <div class="spread" style="margin-bottom:var(--space-4)">
        <h3 style="margin:0">${escapeHtml(t("admin.votes.title"))} · ${data.total_votes}</h3>
        <button type="button" class="btn btn--sm btn--danger" data-reset-votes>
          🔄 ${escapeHtml(t("admin.votes.reset"))}</button>
      </div>

      <div class="stack">${sectionRows}</div>

      <h3 style="margin-top:var(--space-5)">${escapeHtml(t("admin.votes.list"))}</h3>
      ${data.votes.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${escapeHtml(t("admin.votes.user"))}</th>
            <th>${escapeHtml(t("team.role"))}</th>
            <th>${escapeHtml(t("admin.votes.team"))}</th>
            <th>${escapeHtml(t("admin.votes.section"))}</th>
            <th>${escapeHtml(t("tasks.submitted_at"))}</th>
          </tr></thead>
          <tbody>${voteRows}</tbody>
        </table>
      </div>` : emptyState("admin.votes.empty", "🗳️")}`;

    content.querySelector("[data-reset-votes]").addEventListener("click", async () => {
      if (!await confirmDialog(t("admin.votes.confirm_reset"))) return;
      try {
        await api.admin.resetVotes();
        notify.ok(t("admin.votes.reset_done"));
        render();
      } catch (error) {
        notify.err(apiErrorMessage(error));
      }
    });

    content.querySelectorAll("[data-toggle-section]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await api.admin.updateSection(Number(button.dataset.toggleSection), {
            is_open: button.dataset.open === "0",
          });
          notify.ok(t("common.saved"));
          render();
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
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
      <div class="spread" style="margin-bottom:var(--space-4)">
        <div>
          <h3 style="margin:0">${escapeHtml(t("admin.rating.title"))}</h3>
          <div class="muted" style="font-size:.82rem">${escapeHtml(t("admin.rating.hint"))}</div>
        </div>
        <span class="row"><span class="live-dot"></span> ${escapeHtml(t("common.live"))}</span>
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
  },
};

/* ------------------------------------------------------------------ */
/* Оболочка                                                           */
/* ------------------------------------------------------------------ */
const TABS = {
  overview: overviewTab,
  teams: teamsTab,
  tasks: tasksTab,
  quiz: quizTab,
  submissions: submissionsTab,
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
    ["teams", "tasks", "votes", "quiz", "leaderboard", "submissions"],
    (key) => {
      if (TABS[activeTab]?.stateKeys.includes(key)) render();
    },
  );
  startPolling();

  window.addEventListener("tiger:langchange", render);

  await activate(localStorage.getItem(TAB_KEY) || "overview");
})();
