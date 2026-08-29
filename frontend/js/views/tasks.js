/* Лента заданий. Отправлять ответ может только лидер команды. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import {
  apiErrorMessage,
  emptyState,
  escapeHtml,
  formatBytes,
  formatTime,
  loaderBlock,
  nl2br,
  notify,
} from "../ui.js";

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MAX_FILES = 5;

const pending = new Map();   // taskId -> File[]

function attachmentsHtml(attachments) {
  if (!attachments || !attachments.length) return "";
  const items = attachments.map((file) => {
    const media = file.kind === "video"
      ? `<video src="${file.url}" controls preload="metadata"></video>`
      : `<img src="${file.url}" alt="${escapeHtml(file.original_name)}" loading="lazy">`;
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

function taskCardHtml(task, canSubmit) {
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
    if (file.size > MAX_FILE_SIZE) {
      notify.err(`${file.name}: ${t("tasks.file_too_big")}`);
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

export default {
  id: "tasks",
  stateKeys: ["tasks", "submissions"],

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
    const cards = data.tasks.length
      ? data.tasks.map((task) => taskCardHtml(task, canSubmit)).join("")
      : emptyState("tasks.empty", "📋");

    root.dataset.ready = "1";
    root.innerHTML = `
      <div class="page__head">
        <h1 class="page__title">📋 <span>${escapeHtml(t("tasks.title"))}</span></h1>
        <p class="page__hint">${escapeHtml(canSubmit ? t("tasks.hint") : t("tasks.member_hint"))}</p>
      </div>
      <div class="stack">${cards}</div>`;

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
