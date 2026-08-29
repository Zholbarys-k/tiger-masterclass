/* Рабочее место лидера и участника: навигация, обновления, выход. */

import { api, auth } from "./api.js";
import { applyTranslations, initI18n, mountLangSwitch, t } from "./i18n.js";
import { loadMe, startPolling, store, subscribe } from "./store.js";
import { apiErrorMessage, notify, roleLabel } from "./ui.js";

import tasksView from "./views/tasks.js";
import quizView from "./views/quiz.js";
import votingView from "./views/voting.js";
import leaderboardView from "./views/leaderboard.js";
import teamView from "./views/team.js";

const VIEWS = {
  tasks: tasksView,
  quiz: quizView,
  voting: votingView,
  rating: leaderboardView,
  team: teamView,
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
  document.getElementById("header-team").textContent = team ? team.name : t("app.name");
  document.getElementById("header-user").textContent =
    `${user.login} · ${roleLabel(user.role)}`;
}

function wireNavigation() {
  document.getElementById("bottom-nav").addEventListener("click", (event) => {
    const button = event.target.closest(".nav-btn");
    if (!button) return;
    if (button.dataset.nav === "logout") {
      logout();
      return;
    }
    activate(button.dataset.nav);
  });
}

function wireRealtime() {
  // Активный экран обновляем сразу, остальные — при следующем открытии.
  Object.entries(VIEWS).forEach(([navId, view]) => {
    subscribe(view.stateKeys, () => {
      if (navId === activeNav) renderView(navId);
      else dirty.add(navId);
    });
  });

  // При переключении на экран, помеченный устаревшим, перерисуем его.
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

  await activate(localStorage.getItem(NAV_KEY) || "tasks");
})();
