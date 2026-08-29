/* Мелкие UI-утилиты: уведомления, модальные окна, форматирование. */

import { t } from "./i18n.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function nl2br(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

export function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toastsRoot() {
  let root = document.querySelector(".toasts");
  if (!root) {
    root = document.createElement("div");
    root.className = "toasts";
    document.body.appendChild(root);
  }
  return root;
}

export function toast(message, kind = "info", timeout = 3200) {
  const root = toastsRoot();
  const element = document.createElement("div");
  element.className = `toast toast--${kind}`;
  element.textContent = message;
  root.appendChild(element);
  setTimeout(() => {
    element.style.opacity = "0";
    element.style.transform = "translateY(8px)";
    element.style.transition = "opacity .2s, transform .2s";
    setTimeout(() => element.remove(), 220);
  }, timeout);
}

export const notify = {
  ok: (message) => toast(message, "ok"),
  err: (message) => toast(message, "err", 4200),
  info: (message) => toast(message, "info"),
};

export function apiErrorMessage(error) {
  if (!error) return t("common.error_network");
  if (error.code === "network") return t("common.error_network");
  return error.message || t("common.error_network");
}

/* Модальное окно. Возвращает объект с методом close(). */
export function openModal({ title, bodyHtml, onMount }) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal__card" role="dialog" aria-modal="true">
      <div class="modal__title">
        <h3>${escapeHtml(title)}</h3>
        <button type="button" class="modal__close" aria-label="${escapeHtml(t("common.close"))}">✕</button>
      </div>
      <div class="modal__content">${bodyHtml}</div>
    </div>`;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector(".modal__close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);

  if (onMount) onMount(overlay.querySelector(".modal__content"), close);
  return { close, root: overlay };
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    const modal = openModal({
      title: t("common.confirm"),
      bodyHtml: `
        <p>${escapeHtml(message)}</p>
        <div class="row row-end">
          <button type="button" class="btn btn--ghost" data-act="no">${escapeHtml(t("common.cancel"))}</button>
          <button type="button" class="btn btn--danger" data-act="yes">${escapeHtml(t("common.yes"))}</button>
        </div>`,
      onMount(content, close) {
        content.querySelector('[data-act="no"]').addEventListener("click", () => {
          close();
          resolve(false);
        });
        content.querySelector('[data-act="yes"]').addEventListener("click", () => {
          close();
          resolve(true);
        });
      },
    });
    modal.root.addEventListener("click", (event) => {
      if (event.target === modal.root) resolve(false);
    });
  });
}

export function emptyState(messageKey, icon = "📭") {
  return `<div class="empty"><div class="empty__icon">${icon}</div><div>${escapeHtml(t(messageKey))}</div></div>`;
}

export function loaderBlock() {
  return `<span class="loader loader--block"></span>`;
}

export function roleLabel(role) {
  return t(`role.${role}`);
}

export function rankMedal(rank) {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return String(rank);
}
