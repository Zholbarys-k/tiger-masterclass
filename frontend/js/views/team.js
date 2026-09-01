/* Моя команда: состав, баллы и командный чат. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { loadMe, store } from "../store.js";
import {
  apiErrorMessage,
  confirmDialog,
  escapeHtml,
  formatTime,
  loaderBlock,
  notify,
  roleLabel,
} from "../ui.js";

function personRow(person, isMe) {
  const isLeader = person.role === "leader";
  return `
    <div class="card card--flat spread" style="margin-top:var(--space-2)">
      <div class="row" style="gap:var(--space-3); min-width:0">
        <span style="font-size:1.5rem">${isLeader ? "👑" : "🎓"}</span>
        <div style="min-width:0">
          <div style="font-weight:600">${escapeHtml(person.display_name || person.login)}
            ${isMe ? `<span class="badge badge--accent" style="margin-left:6px">${escapeHtml(t("team.you"))}</span>` : ""}
          </div>
          <div class="muted" style="font-size:.78rem">${escapeHtml(person.login)} · ${escapeHtml(roleLabel(person.role))}</div>
          ${person.school || person.grade ? `<div class="muted" style="font-size:.75rem">${escapeHtml([person.school, person.grade].filter(Boolean).join(" · "))}</div>` : ""}
        </div>
      </div>
      <span class="badge ${isLeader ? "badge--accent" : "badge--muted"}">${escapeHtml(roleLabel(person.role))}</span>
    </div>`;
}

function chatBubble(row, myId) {
  const mine = row.author_id === myId;
  const name = row.author_name || row.author_login;
  return `
    <div class="chat-row ${mine ? "is-mine" : ""}">
      <div class="chat-bubble">
        <div class="chat-bubble__meta">${escapeHtml(name)} · ${escapeHtml(formatTime(row.created_at))}</div>
        <div class="chat-bubble__text">${escapeHtml(row.body)}</div>
      </div>
    </div>`;
}

async function sendFrom(root) {
  const input = root.querySelector("#team-msg-input");
  const text = input.value.trim();
  if (!text) {
    notify.err(t("messages.empty"));
    return;
  }
  input.disabled = true;
  try {
    await api.sendTeamMessage(text);
    input.value = "";
    await render(root);
  } catch (error) {
    notify.err(apiErrorMessage(error));
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function clearFrom(root) {
  if (!await confirmDialog(t("team.chat_confirm_clear"))) return;
  try {
    await api.clearTeamChat();
    notify.ok(t("team.chat_cleared"));
    await render(root);
  } catch (error) {
    notify.err(apiErrorMessage(error));
  }
}

async function render(root) {
  const draft = root.querySelector("#team-msg-input")?.value ?? "";
  const prevList = root.querySelector("#team-chat-list");
  const prevScroll = prevList ? prevList.scrollTop : null;
  const wasAtBottom = prevList
    ? prevList.scrollHeight - prevList.scrollTop - prevList.clientHeight < 40
    : true;

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

  let chat = { messages: [], can_clear: me.role === "leader" };
  let chatError = "";
  try {
    chat = await api.teamMessages();
  } catch (error) {
    chatError = apiErrorMessage(error);
  }

  const people = [team.leader, ...(team.members || [])].filter(Boolean);
  const list = chat.messages || [];
  const canClear = Boolean(chat.can_clear);

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
      ${people.map((person) => personRow(person, person.id === me.id)).join("")}

      <div class="spread" style="margin-top:var(--space-5); align-items:flex-end; gap:var(--space-3)">
        <div>
          <h3 style="margin:0">💬 ${escapeHtml(t("team.chat_title"))}</h3>
          <p class="muted" style="margin:var(--space-1) 0 0; font-size:.82rem">${escapeHtml(t("team.chat_hint"))}</p>
        </div>
        ${canClear ? `
          <button type="button" class="btn btn--sm btn--danger" id="team-chat-clear">
            ${escapeHtml(t("team.chat_clear"))}
          </button>` : ""}
      </div>
      <div class="card chat" style="margin-top:var(--space-3)">
        <div class="chat__list" id="team-chat-list">
          ${chatError
            ? `<div class="empty">${escapeHtml(chatError)}</div>`
            : list.length
              ? list.map((row) => chatBubble(row, me.id)).join("")
              : `<div class="empty" style="padding:var(--space-5)">${escapeHtml(t("team.chat_empty"))}</div>`}
        </div>
        <div class="chat__composer">
          <textarea class="textarea" id="team-msg-input" rows="2" maxlength="1000"
                    placeholder="${escapeHtml(t("team.chat_ph"))}"></textarea>
          <button type="button" class="btn btn--primary" id="team-msg-send">${escapeHtml(t("common.send"))}</button>
        </div>
      </div>`;

  const listEl = root.querySelector("#team-chat-list");
  if (prevScroll !== null && !wasAtBottom) {
    listEl.scrollTop = prevScroll;
  } else {
    listEl.scrollTop = listEl.scrollHeight;
  }

  const input = root.querySelector("#team-msg-input");
  input.value = draft;
  root.querySelector("#team-msg-send").addEventListener("click", () => sendFrom(root));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendFrom(root);
    }
  });
  root.querySelector("#team-chat-clear")?.addEventListener("click", () => clearFrom(root));
}

export default {
  id: "team",
  stateKeys: ["teams", "leaderboard", "submissions", "quiz", "teamchat"],
  render,
};
