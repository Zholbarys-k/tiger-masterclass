/* Переключение языков: КАЗАҚША / РУССКИЙ / ENGLISH */

export const LANGS = ["kk", "ru", "en"];
const LANG_KEY = "tiger.lang";
const LABELS = { kk: "ҚАЗ", ru: "РУС", en: "ENG" };

let currentLang = "ru";
let dict = {};

export function getLang() {
  return currentLang;
}

export function langLabel(code) {
  return LABELS[code] || code.toUpperCase();
}

function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && LANGS.includes(saved)) return saved;
  const browser = (navigator.language || "ru").slice(0, 2).toLowerCase();
  if (browser === "kk") return "kk";
  if (browser === "en") return "en";
  return "ru";
}

async function loadDict(code) {
  const response = await fetch(`/i18n/${code}.json`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Cannot load i18n/${code}.json`);
  return response.json();
}

export function t(key, vars) {
  let value = dict[key];
  if (value === undefined) return key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPh));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  document.documentElement.lang = currentLang;
}

export async function initI18n() {
  currentLang = detectLang();
  dict = await loadDict(currentLang);
  applyTranslations();
  return currentLang;
}

export async function setLang(code) {
  if (!LANGS.includes(code) || code === currentLang) return;
  dict = await loadDict(code);
  currentLang = code;
  localStorage.setItem(LANG_KEY, code);
  applyTranslations();
  window.dispatchEvent(new CustomEvent("tiger:langchange", { detail: { lang: code } }));
}

/* Панель переключения языка: вставляется в контейнер с data-lang-switch */
export function mountLangSwitch(container) {
  if (!container) return;
  container.classList.add("lang-switch");
  container.innerHTML = LANGS.map(
    (code) => `<button type="button" class="lang-switch__btn" data-lang="${code}">${langLabel(code)}</button>`,
  ).join("");

  const sync = () => {
    container.querySelectorAll(".lang-switch__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.lang === currentLang);
    });
  };

  container.addEventListener("click", async (event) => {
    const button = event.target.closest(".lang-switch__btn");
    if (!button) return;
    await setLang(button.dataset.lang);
    sync();
  });

  window.addEventListener("tiger:langchange", sync);
  sync();
}
