/* Лента заданий. Отправлять ответ может только лидер команды. */

import { api, fileUrl } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import {
  apiErrorMessage,
  emptyState,
  escapeHtml,
  formatBytes,
  formatCountdown,
  formatTime,
  loaderBlock,
  nl2br,
  notify,
} from "../ui.js";

const MAX_FILES = 5;

const pending = new Map();   // taskId -> File[]

function attachmentsHtml(attachments) {
  if (!attachments || !attachments.length) return "";
  const items = attachments.map((file) => {
    const src = fileUrl(file.url);
    const media = file.kind === "video"
      ? `<video src="${src}" controls preload="metadata" playsinline></video>`
      : `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${escapeHtml(file.original_name)}" loading="lazy"></a>`;
    return `<div class="media-item">${media}
      <div class="media-item__label">${escapeHtml(file.original_name)} · ${formatBytes(file.size_bytes)}</div>
    </div>`;
  }).join("");
  return `<div class="media-grid" style="margin-top:var(--space-3)">${items}</div>`;
}

function submissionHtml(task) {
  const submission = task.my_submission;
  if (!submission) {
    return `<p class="muted" style="margin:0">${escapeHtml(t("tasks.no_answer_yet"))}</p>`;
  }
  const graded = submission.points > 0;
  return `
    <div class="card card--flat">
      <div class="spread">
        <span class="badge badge--success">✓ ${escapeHtml(t("tasks.submitted"))}</span>
        <span class="badge ${graded ? "badge--accent" : "badge--muted"}">
          ${graded
            ? `${escapeHtml(t("tasks.graded"))}: ${submission.points} / ${task.max_points}`
            : escapeHtml(t("tasks.awaiting_grade"))}
        </span>
      </div>
      ${submission.text ? `<div style="margin-top:var(--space-3)">${nl2br(submission.text)}</div>` : ""}
      ${attachmentsHtml(submission.attachments)}
      <div class="muted" style="font-size:.75rem; margin-top:var(--space-2)">
        ${escapeHtml(t("tasks.submitted_at"))}: ${formatTime(submission.updated_at)} · ${escapeHtml(submission.author)}
      </div>
    </div>`;
}

function leaderFormHtml(task) {
  const submission = task.my_submission;
  const buttonLabel = submission ? t("tasks.update") : t("tasks.submit");
  return `
    <form class="stack" data-task-form="${task.id}" style="margin-top:var(--space-3)">
      <div class="field" style="margin:0">
        <label class="field__label">${escapeHtml(t("tasks.your_answer"))}</label>
        <textarea class="textarea" name="text" data-i18n-ph="tasks.answer_ph"
          placeholder="${escapeHtml(t("tasks.answer_ph"))}">${escapeHtml(submission?.text || "")}</textarea>
      </div>
      ${task.allow_files ? `
      <label class="file-drop">
        <input type="file" accept="image/*,video/*" multiple data-task-files="${task.id}">
        <div class="file-drop__icon">📎</div>
        <div>${escapeHtml(t("tasks.attach"))}</div>
        <div class="file-drop__hint">${escapeHtml(t("tasks.attach_hint"))}</div>
      </label>
      <div class="file-list" data-file-list="${task.id}"></div>` : ""}
      <div class="progress hidden" data-progress="${task.id}"><div class="progress__bar"></div></div>
      <button type="submit" class="btn btn--primary btn--block">📤 ${escapeHtml(buttonLabel)}</button>
    </form>`;
}

function task3BannerHtml(round) {
  if (!round) return "";
  const number = round.task_order || "";
  if (round.phase === "running") {
    return `
      <div class="card card--accent" data-task3-banner style="margin-bottom:var(--space-4)">
        <div class="qpult" data-round-timer="${round.task_id || ""}">
          <div class="qtimer qtimer--long">
            <div class="qtimer__ring" style="--p:${round.phase_seconds
              ? Math.min(100, ((round.remaining_seconds ?? 0) / round.phase_seconds) * 100)
              : 0}%" data-task3-timer-ring>
              <span class="qtimer__value" data-task3-timer-value>${round.is_paused ? "||" : formatCountdown(round.remaining_seconds ?? 0)}</span>
            </div>
          </div>
          <div>
            <strong>${escapeHtml(t("tasks.round.live", { n: number }))}</strong>
            <div class="muted" style="font-size:.82rem">${escapeHtml(
              round.is_paused ? t("quiz.paused") : t("tasks.round.live_hint"),
            )}</div>
          </div>
        </div>
      </div>`;
  }
  if (round.phase === "voting" || round.phase === "closed") {
    return `
      <div class="qnotice qnotice--ok" style="margin-bottom:var(--space-4)">
        ${escapeHtml(t(round.likes_enabled === false ? "tasks.round.ended_plain" : "tasks.round.ended", { n: number }))}
      </div>`;
  }
  return `
    <div class="qnotice" style="margin-top:var(--space-4)">
      ${escapeHtml(t("tasks.round.wait_start", { n: number }))}
    </div>`;
}

function sealedTaskHtml(task) {
  const own = task.my_submission
    ? `<div class="task-card__own">${submissionHtml(task)}</div>`
    : "";
  return `
    <article class="card task-card--sealed" data-task-card="${task.id}">
      <div class="task-seal">
        <div class="task-seal__film">
          <div class="task-seal__icon" aria-hidden="true">🔒</div>
          <h3 class="task-seal__title">${escapeHtml(t("tasks.round.sealed_title", { n: task.order }))}</h3>
          <p class="task-seal__hint">${escapeHtml(t("tasks.round.sealed_hint"))}</p>
        </div>
      </div>
      ${own}
    </article>`;
}

function taskCardHtml(task, canSubmit, sealed) {
  if (sealed || task.content_hidden) {
    return sealedTaskHtml(task);
  }
  return `
    <article class="card" data-task-card="${task.id}">
      <div class="card__head">
        <div>
          <h3 class="card__title">${escapeHtml(task.title)}</h3>
          <div class="muted" style="font-size:.78rem">${formatTime(task.created_at)}</div>
        </div>
        <span class="badge badge--accent">${task.max_points} ${escapeHtml(t("common.pts"))}</span>
      </div>
      <div class="card__body">
        ${task.image_url ? `<img class="content-image" src="${fileUrl(task.image_url)}" alt="">` : ""}
        <div>${nl2br(task.body)}</div>
        <div style="margin-top:var(--space-4)">
          ${submissionHtml(task)}
          ${canSubmit
            ? leaderFormHtml(task)
            : `<p class="muted" style="margin-top:var(--space-3); font-size:.85rem">🔒 ${escapeHtml(t("tasks.member_hint"))}</p>`}
        </div>
      </div>
    </article>`;
}

function renderFileList(taskId, container) {
  const files = pending.get(taskId) || [];
  if (!container) return;
  container.innerHTML = files.map((file, index) => `
    <div class="file-chip">
      <span>${file.type.startsWith("video") ? "🎬" : "🖼️"}</span>
      <span class="file-chip__name">${escapeHtml(file.name)}</span>
      <span class="file-chip__size">${formatBytes(file.size)}</span>
      <button type="button" class="file-chip__remove" data-remove-file="${index}"
        title="${escapeHtml(t("tasks.remove_file"))}">✕</button>
    </div>`).join("");
}

function collectFiles(taskId, fileList, container) {
  const current = pending.get(taskId) || [];
  const accepted = [...current];

  for (const file of fileList) {
    const isMedia = file.type.startsWith("image/") || file.type.startsWith("video/");
    if (!isMedia) {
      notify.err(`${file.name}: ${t("tasks.file_bad_type")}`);
      continue;
    }
    if (accepted.length >= MAX_FILES) {
      notify.err(t("tasks.too_many_files"));
      break;
    }
    accepted.push(file);
  }

  pending.set(taskId, accepted);
  renderFileList(taskId, container);
}

async function submitTask(taskId, form, refresh) {
  const text = form.querySelector('[name="text"]').value.trim();
  const files = pending.get(taskId) || [];
  if (!text && !files.length) {
    notify.err(t("tasks.answer_ph"));
    return;
  }

  const button = form.querySelector('button[type="submit"]');
  const progress = form.querySelector("[data-progress]");
  const bar = progress?.querySelector(".progress__bar");
  const originalLabel = button.innerHTML;

  button.disabled = true;
  button.innerHTML = `<span class="loader"></span> ${escapeHtml(t("tasks.sending"))}`;
  if (files.length && progress) progress.classList.remove("hidden");

  const formData = new FormData();
  formData.append("text", text);
  files.forEach((file) => formData.append("files", file));

  try {
    await api.submitTask(taskId, formData, (percent) => {
      if (bar) bar.style.width = `${percent}%`;
    });
    pending.delete(taskId);
    notify.ok(t("tasks.sent_ok"));
    await refresh();
  } catch (error) {
    notify.err(apiErrorMessage(error));
    button.disabled = false;
    button.innerHTML = originalLabel;
    progress?.classList.add("hidden");
  }
}

let task3Tick = null;
let task3Deadline = 0;
let task3Total = 0;

function stopTask3Tick() {
  if (task3Tick) clearInterval(task3Tick);
  task3Tick = null;
}

function startTask3Tick(root, rounds) {
  stopTask3Tick();
  const live = (rounds || []).filter((round) => round.phase === "running" && !round.is_paused);
  if (!live.length) return;
  const meta = live.map((round) => ({
    id: round.task_id,
    total: round.phase_seconds || 3600,
    deadline: Date.now() + (round.remaining_seconds ?? round.phase_seconds ?? 3600) * 1000,
  }));
  let reloaded = false;
  task3Tick = setInterval(() => {
    if (!root.querySelector("[data-round-timer]")) {
      stopTask3Tick();
      return;
    }
    let expired = false;
    meta.forEach((item) => {
      const seconds = Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000));
      const percent = item.total ? Math.min(100, (seconds / item.total) * 100) : 0;
      const box = root.querySelector(`[data-round-timer="${item.id}"]`);
      if (!box) return;
      const value = box.querySelector("[data-task3-timer-value]");
      const ring = box.querySelector("[data-task3-timer-ring]");
      if (value) value.textContent = formatCountdown(seconds);
      if (ring) ring.style.setProperty("--p", `${percent}%`);
      if (seconds <= 0) expired = true;
    });
    if (expired && !reloaded) {
      reloaded = true;
      setTimeout(() => view.render(root), 900);
    }
  }, 250);
}

const view = {
  id: "tasks",
  stateKeys: ["tasks", "submissions", "task3"],

  async render(root) {
    if (!root.dataset.ready) root.innerHTML = loaderBlock();

    let data;
    try {
      data = await api.tasks();
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    const canSubmit = data.can_submit && store.user?.role === "leader";
    const rounds = Object.values(data.rounds || {});
    const topRounds = rounds.filter((round) => round.phase === "running" || round.phase === "voting" || round.phase === "closed");
    const waitRounds = rounds.filter((round) => !round.phase || round.phase === "idle");
    const cards = data.tasks.length
      ? data.tasks.map((task) => {
        const round = task.round;
        const locked = Boolean(round && !round.can_submit) || Boolean(task.content_hidden);
        return taskCardHtml(task, canSubmit && !locked, locked);
      }).join("")
      : emptyState("tasks.empty", "📋");

    root.dataset.ready = "1";
    root.innerHTML = `
      <div class="page__head">
        <h1 class="page__title">📋 <span>${escapeHtml(t("tasks.title"))}</span></h1>
        <p class="page__hint">${escapeHtml(canSubmit ? t("tasks.hint") : t("tasks.member_hint"))}</p>
      </div>
      ${topRounds.map(task3BannerHtml).join("")}
      <div class="stack">${cards}</div>
      ${waitRounds.map(task3BannerHtml).join("")}`;

    startTask3Tick(root, rounds);

    // Восстановить выбранные, но не отправленные файлы.
    data.tasks.forEach((task) => {
      renderFileList(task.id, root.querySelector(`[data-file-list="${task.id}"]`));
    });

    root.querySelectorAll("[data-task-files]").forEach((input) => {
      input.addEventListener("change", (event) => {
        const taskId = Number(input.dataset.taskFiles);
        collectFiles(taskId, event.target.files, root.querySelector(`[data-file-list="${taskId}"]`));
        input.value = "";
      });
    });

    root.querySelectorAll("[data-file-list]").forEach((container) => {
      container.addEventListener("click", (event) => {
        const button = event.target.closest("[data-remove-file]");
        if (!button) return;
        const taskId = Number(container.dataset.fileList);
        const files = pending.get(taskId) || [];
        files.splice(Number(button.dataset.removeFile), 1);
        pending.set(taskId, files);
        renderFileList(taskId, container);
      });
    });

    root.querySelectorAll("[data-task-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        submitTask(Number(form.dataset.taskForm), form, () => this.render(root));
      });
    });
  },
};

export default view;
