/* Экран авторизации. */

import { api, auth, ApiError } from "./api.js";
import { initI18n, mountLangSwitch, t } from "./i18n.js";

const form = document.getElementById("login-form");
const loginInput = document.getElementById("login-input");
const passwordInput = document.getElementById("password-input");
const errorBox = document.getElementById("login-error");
const submitButton = document.getElementById("login-submit");
const submitLabel = submitButton.querySelector("span");

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function hideError() {
  errorBox.classList.add("hidden");
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitLabel.textContent = busy ? t("login.loading") : t("login.submit");
}

document.getElementById("toggle-password").addEventListener("change", (event) => {
  passwordInput.type = event.target.checked ? "text" : "password";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();

  const login = loginInput.value.trim();
  const password = passwordInput.value;
  if (!login || !password) {
    showError(t("login.error_empty"));
    return;
  }

  setBusy(true);
  try {
    const data = await api.login(login, password);
    auth.save(data.token, data.user);
    window.location.replace(data.redirect || "/app");
  } catch (error) {
    if (error instanceof ApiError && error.code === "network") {
      showError(t("common.error_network"));
    } else if (error instanceof ApiError && error.status === 401) {
      showError(t("login.error_bad"));
    } else {
      showError(error.message || t("login.error_bad"));
    }
    passwordInput.select();
  } finally {
    setBusy(false);
  }
});

(async function boot() {
  await initI18n();
  mountLangSwitch(document.querySelector("[data-lang-switch]"));
  window.addEventListener("tiger:langchange", () => setBusy(false));

  // Уже авторизован — сразу в рабочее пространство.
  if (auth.token && auth.user) {
    window.location.replace(auth.user.role === "admin" ? "/admin" : "/app");
    return;
  }
  loginInput.focus();
})();
