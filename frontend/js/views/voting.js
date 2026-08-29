/* Голосование за секции мастер-класса. */

import { api } from "../api.js";
import { t } from "../i18n.js";
import { apiErrorMessage, escapeHtml, loaderBlock, notify } from "../ui.js";

function sectionCardHtml(section, myVoteId, canVote) {
  const chosen = section.id === myVoteId;
  return `
    <article class="vote-card ${chosen ? "is-chosen" : ""}">
      <div class="vote-card__top">
        <div class="vote-card__icon">${section.icon || "🔬"}</div>
        <div class="grow">
          <div class="vote-card__name">${escapeHtml(section.name)}</div>
          <div class="vote-card__desc">${escapeHtml(section.description)}</div>
        </div>
        ${chosen ? `<span class="badge badge--accent">✓ ${escapeHtml(t("vote.voted"))}</span>` : ""}
      </div>

      <div class="vote-card__meter">
        <div class="progress"><div class="progress__bar" style="width:${section.percent}%"></div></div>
        <div class="vote-card__numbers">
          <span>${section.votes} ${escapeHtml(t("vote.votes"))}</span>
          <span>${section.percent}%</span>
        </div>
      </div>

      ${canVote
        ? `<button type="button" class="btn ${chosen ? "btn--ghost" : "btn--primary"} btn--block"
             data-vote="${section.id}" ${section.is_open ? "" : "disabled"}>
             ${section.is_open
               ? escapeHtml(chosen ? t("vote.change") : t("vote.button"))
               : escapeHtml(t("vote.closed"))}
           </button>`
        : ""}
    </article>`;
}

export default {
  id: "voting",
  stateKeys: ["votes"],

  async render(root) {
    if (!root.dataset.ready) root.innerHTML = loaderBlock();

    let data;
    try {
      data = await api.sections();
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    root.dataset.ready = "1";
    root.innerHTML = `
      <div class="page__head">
        <h1 class="page__title">🗳️ <span>${escapeHtml(t("vote.title"))}</span></h1>
        <p class="page__hint">${escapeHtml(data.can_vote ? t("vote.hint") : t("vote.admin_cannot"))}</p>
      </div>

      <div class="card card--flat spread" style="margin-bottom:var(--space-4)">
        <span class="row"><span class="live-dot"></span> <strong>${escapeHtml(t("common.live"))}</strong></span>
        <span class="badge badge--info">${escapeHtml(t("vote.total"))}: ${data.total_votes}</span>
      </div>

      <div class="grid grid--auto">
        ${data.sections.map((section) => sectionCardHtml(section, data.my_vote_section_id, data.can_vote)).join("")}
      </div>`;

    root.querySelectorAll("[data-vote]").forEach((button) => {
      button.addEventListener("click", async () => {
        const sectionId = Number(button.dataset.vote);
        root.querySelectorAll("[data-vote]").forEach((other) => { other.disabled = true; });
        try {
          await api.vote(sectionId);
          notify.ok(t("vote.saved"));
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
        await this.render(root);
      });
    });
  },
};
