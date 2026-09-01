/* Голосование за секции и лайки проектов задания №3. */

import { api, fileUrl } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
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

function projectMedia(project) {
  if (project.photo) {
    return `<img src="${fileUrl(project.photo.url)}" alt="${escapeHtml(project.title)}" loading="lazy">`;
  }
  if (project.video) {
    return `<video src="${fileUrl(project.video.url)}" controls preload="metadata" playsinline></video>`;
  }
  return `<div class="project-card__placeholder">📷</div>`;
}

function projectCardHtml(project, myLikeId, canLike, myTeamId) {
  const liked = project.id === myLikeId;
  const own = myTeamId && project.team_id === myTeamId;
  const desc = (project.description || "").trim();
  return `
    <article class="project-card ${liked ? "is-liked" : ""}">
      <div class="project-card__media">${projectMedia(project)}</div>
      <div class="project-card__body">
        <div class="spread" style="align-items:flex-start; gap:var(--space-2)">
          <div style="min-width:0">
            <div class="project-card__title">${escapeHtml(project.title)}</div>
            <div class="muted" style="font-size:.75rem">#${String(project.team_number).padStart(2, "0")}</div>
          </div>
          <span class="badge badge--info">❤️ ${project.likes}</span>
        </div>
        <p class="project-card__desc">${desc ? escapeHtml(desc) : escapeHtml(t("vote.round.no_desc"))}</p>
        ${own
          ? `<div class="muted" style="font-size:.8rem">${escapeHtml(t("vote.round.own"))}</div>`
          : canLike
            ? `<button type="button" class="btn ${liked ? "btn--ghost" : "btn--primary"} btn--block" data-like="${project.id}">
                 ${escapeHtml(liked ? t("vote.round.liked") : t("vote.round.like"))}
               </button>`
            : ""}
      </div>
    </article>`;
}

function projectsBlockHtml(gallery) {
  const round = gallery.round || {};
  const number = gallery.task_order || round.task_order || "";
  if (!round.projects_visible) {
    if (round.phase === "running") {
      return `
        <div class="card card--flat" style="margin-top:var(--space-5)">
          <strong>🗳️ ${escapeHtml(t("vote.round.title", { n: number }))}</strong>
          <p class="muted" style="margin:var(--space-2) 0 0">${escapeHtml(t("vote.round.wait", { n: number }))}</p>
        </div>`;
    }
    return "";
  }

  const projects = gallery.projects || [];
  return `
    <div class="page__head" style="margin-top:var(--space-6)">
      <h2 class="page__title">🗳️ <span>${escapeHtml(t("vote.round.title", { n: number }))}</span></h2>
      <p class="page__hint">${escapeHtml(
        round.phase === "closed" ? t("vote.round.closed_hint") : t("vote.round.hint"),
      )}</p>
    </div>
    <div class="card card--flat spread" style="margin-bottom:var(--space-4)">
      <span class="row"><span class="live-dot"></span> <strong>${escapeHtml(t("common.live"))}</strong></span>
      <span class="badge badge--info">❤️ ${gallery.total_likes || 0}</span>
    </div>
    <div class="grid grid--auto">
      ${projects.length
        ? projects.map((project) => projectCardHtml(
          project,
          gallery.my_like_id,
          gallery.can_like,
          store.user?.team_id,
        )).join("")
        : `<div class="empty">${escapeHtml(t("vote.round.empty"))}</div>`}
    </div>`;
}

export default {
  id: "voting",
  stateKeys: ["votes", "task3"],

  async render(root) {
    if (!root.dataset.ready) root.innerHTML = loaderBlock();

    let data;
    let projectsData;
    try {
      [data, projectsData] = await Promise.all([api.sections(), api.projects()]);
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    const galleries = projectsData.galleries || [];
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
      </div>

      ${galleries.map(projectsBlockHtml).join("")}`;

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

    root.querySelectorAll("[data-like]").forEach((button) => {
      button.addEventListener("click", async () => {
        root.querySelectorAll("[data-like]").forEach((other) => { other.disabled = true; });
        try {
          await api.likeProject(Number(button.dataset.like));
          notify.ok(t("vote.round.saved"));
        } catch (error) {
          notify.err(apiErrorMessage(error));
        }
        await this.render(root);
      });
    });
  },
};
