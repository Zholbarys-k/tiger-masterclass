/* Рабочее место лидера и участника: навигация, профиль, сообщения, выход. */

import { api, auth } from "./api.js";
import { applyTranslations, initI18n, mountLangSwitch, t } from "./i18n.js";
import { loadMe, startPolling, store, subscribe } from "./store.js";
import { apiErrorMessage, notify, roleLabel } from "./ui.js";

import tasksView from "./views/tasks.js";
import quizView from "./views/quiz.js";
import votingView from "./views/voting.js";
import leaderboardView from "./views/leaderboard.js";
import teamView from "./views/team.js";
import messagesView from "./views/messages.js";
import { ensureProfilePrompt, openProfileModal } from "./views/profile.js";

const VIEWS = {
  tasks: tasksView,
  quiz: quizView,
  voting: votingView,
  rating: leaderboardView,
  team: teamView,
  messages: messagesView,
};

const NAV_KEY = "tiger.nav";
const dirty = new Set();
let activeNav = "tasks";

function pageElement(navId) {
  return document.getElementById(`page-${navId}`);
}

async function renderView(navId) {
  const view = VIEWS[navId];
  const element = pageElement(navId);
  if (!view || !element) return;
  try {
    await view.render(element);
    applyTranslations(element);
  } catch (error) {
    notify.err(apiErrorMessage(error));
  }
  dirty.delete(navId);
}

async function activate(navId) {
  if (!VIEWS[navId]) navId = "tasks";
  activeNav = navId;
  localStorage.setItem(NAV_KEY, navId);

  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("is-active", page.id === `page-${navId}`);
  });
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.nav === navId);
  });
  document.getElementById("messages-btn")?.classList.toggle("is-active", navId === "messages");
  window.scrollTo({ top: 0, behavior: "instant" });

  await renderView(navId);
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* даже при ошибке выходим локально */
  }
  auth.clear();
  window.location.replace("/");
}

function updateHeader() {
  const user = store.user;
  const team = store.team;
  const name = (user.display_name || "").trim();
  document.getElementById("header-team").textContent = team ? team.name : t("app.name");
  document.getElementById("header-user").textContent = name
    ? `${name} · ${roleLabel(user.role)}`
    : `${user.login} · ${roleLabel(user.role)}`;
  document.getElementById("profile-btn")?.classList.toggle("needs-profile", !user.profile_filled);
  updateMessageBadge();
}

function updateMessageBadge() {
  const badge = document.getElementById("msg-badge");
  const button = document.getElementById("messages-btn");
  if (!badge) return;
  const count = store.unreadMessages || 0;
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? "99+" : (count ? String(count) : "");
  if (button) {
    button.setAttribute("aria-label", t("messages.title"));
    button.title = t("messages.title");
  }
}

function wireNavigation() {
  document.getElementById("bottom-nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-btn");
    if (!button) return;
    activate(button.dataset.nav);
  });

  document.getElementById("messages-btn").addEventListener("click", () => activate("messages"));
  document.getElementById("profile-btn").addEventListener("click", () => {
    openProfileModal({ onSaved: updateHeader });
  });
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function wireRealtime() {
  Object.entries(VIEWS).forEach(([navId, view]) => {
    subscribe(view.stateKeys, () => {
      if (navId === activeNav) renderView(navId);
      else dirty.add(navId);
      if (navId === "messages") updateMessageBadge();
    });
  });

  document.getElementById("bottom-nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-btn");
    if (button && dirty.has(button.dataset.nav)) renderView(button.dataset.nav);
  });
}

(async function boot() {
  if (!auth.requireLogin()) return;

  await initI18n();
  mountLangSwitch(document.querySelector("[data-lang-switch]"));

  try {
    await loadMe();
  } catch (error) {
    auth.clear();
    window.location.replace("/");
    return;
  }

  if (store.user.role === "admin") {
    window.location.replace("/admin");
    return;
  }

  updateHeader();
  wireNavigation();
  wireRealtime();
  startPolling();

  window.addEventListener("tiger:langchange", async () => {
    updateHeader();
    Object.keys(VIEWS).forEach((navId) => dirty.add(navId));
    await renderView(activeNav);
  });

  const saved = localStorage.getItem(NAV_KEY);
  await activate(saved === "logout" ? "tasks" : (saved || "tasks"));
  ensureProfilePrompt({ onSaved: updateHeader });
})();
