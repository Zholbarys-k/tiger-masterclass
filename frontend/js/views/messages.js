/* Вопросы администраторам: переписка участника или лидера. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import { apiErrorMessage, escapeHtml, formatTime, loaderBlock, notify } from "../ui.js";

function bubbleHtml(row, myId) {
  const mine = row.author_id === myId;
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
}

async function sendFrom(root) {
  const input = root.querySelector("#msg-input");
  const text = input.value.trim();
  if (!text) {
    notify.err(t("messages.empty"));
    return;
  }
  input.disabled = true;
  try {
    await api.sendMessage(text);
    input.value = "";
    await render(root);
  } catch (error) {
    notify.err(apiErrorMessage(error));
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function render(root) {
  if (!root.dataset.ready) root.innerHTML = loaderBlock();

  let data;
  try {
    data = await api.messages();
  } catch (error) {
    root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
    return;
  }

  root.dataset.ready = "1";
  const myId = store.user?.id;
  const list = data.messages || [];

  root.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">💬 <span>${escapeHtml(t("messages.title"))}</span></h1>
      <p class="page__hint">${escapeHtml(t("messages.hint"))}</p>
    </div>
    <div class="card chat">
      <div class="chat__list" id="chat-list">
        ${list.length
          ? list.map((row) => bubbleHtml(row, myId)).join("")
          : `<div class="empty" style="padding:var(--space-5)">${escapeHtml(t("messages.empty_thread"))}</div>`}
      </div>
      <div class="chat__composer">
        <textarea class="textarea" id="msg-input" rows="2" maxlength="1000"
                  placeholder="${escapeHtml(t("messages.ph"))}"></textarea>
        <button type="button" class="btn btn--primary" id="msg-send">${escapeHtml(t("common.send"))}</button>
      </div>
    </div>`;

  const listEl = root.querySelector("#chat-list");
  listEl.scrollTop = listEl.scrollHeight;
  root.querySelector("#msg-send").addEventListener("click", () => sendFrom(root));
  root.querySelector("#msg-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendFrom(root);
    }
  });
}

export default {
  id: "messages",
  stateKeys: ["messages"],
  render,
};
