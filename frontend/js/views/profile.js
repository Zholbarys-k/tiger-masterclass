/* Анкета участника / лидера: имя, школа, класс, о себе. */

import { api, auth } from "../api.js";
import { t } from "../i18n.js";
import { loadMe, store } from "../store.js";
import { apiErrorMessage, escapeHtml, notify, openModal } from "../ui.js";

export function openProfileModal({ onSaved } = {}) {
  const user = store.user || {};
  openModal({
    title: t("profile.title"),
    bodyHtml: `
      <p class="muted" style="margin-top:0">${escapeHtml(t("profile.hint"))}</p>
      <div class="field">
        <label class="field__label" for="pf-name">${escapeHtml(t("profile.name"))}</label>
        <input class="input" id="pf-name" maxlength="120" value="${escapeHtml(user.display_name || "")}"
               placeholder="${escapeHtml(t("profile.name_ph"))}">
      </div>
      <div class="field">
        <label class="field__label" for="pf-school">${escapeHtml(t("profile.school"))}</label>
        <input class="input" id="pf-school" maxlength="120" value="${escapeHtml(user.school || "")}"
               placeholder="${escapeHtml(t("profile.school_ph"))}">
      </div>
      <div class="field">
        <label class="field__label" for="pf-grade">${escapeHtml(t("profile.grade"))}</label>
        <input class="input" id="pf-grade" maxlength="40" value="${escapeHtml(user.grade || "")}"
               placeholder="${escapeHtml(t("profile.grade_ph"))}">
      </div>
      <div class="field">
        <label class="field__label" for="pf-about">${escapeHtml(t("profile.about"))}</label>
        <textarea class="textarea" id="pf-about" maxlength="400"
                  placeholder="${escapeHtml(t("profile.about_ph"))}">${escapeHtml(user.about || "")}</textarea>
      </div>
      <div class="row row-end">
        <button type="button" class="btn btn--primary" data-save>${escapeHtml(t("common.save"))}</button>
      </div>`,
    onMount(box, close) {
      box.querySelector("#pf-name").focus();
      box.querySelector("[data-save]").addEventListener("click", async () => {
        const payload = {
          display_name: box.querySelector("#pf-name").value.trim(),
          school: box.querySelector("#pf-school").value.trim(),
          grade: box.querySelector("#pf-grade").value.trim(),
          about: box.querySelector("#pf-about").value.trim(),
        };
        try {
          const data = await api.updateProfile(payload);
          store.user = data.user;
          auth.save(auth.token, data.user);
          notify.ok(t("profile.saved"));
          close();
          if (onSaved) onSaved(data.user);
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
      });
    },
  });
}

export async function ensureProfilePrompt({ onSaved } = {}) {
  if (store.user?.profile_filled) return;
  try {
    await loadMe();
  } catch {
    return;
  }
  if (!store.user?.profile_filled) openProfileModal({ onSaved });
}
