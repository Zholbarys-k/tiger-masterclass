/* Выбор карточек кабинетов и лайки проектов заданий. */

import { api, fileUrl } from "../api.js";
import { t } from "../i18n.js";
import { store } from "../store.js";
import { apiErrorMessage, confirmDialog, escapeHtml, loaderBlock, notify, openModal } from "../ui.js";

/** Сообщение об ошибке выбора карточки на языке интерфейса. */
function vote_error(error) {
  const key = `vote.cards.err_${error?.code}`;
  const text = t(key);
  return text === key ? apiErrorMessage(error) : text;
}

function roomCardHtml(card, data) {
  const canPick = data.can_pick && !card.taken;
  const back = card.taken
    ? `<span class="flip-card__team">${escapeHtml(card.team_name)}</span>
       ${card.is_mine
         ? `<span class="flip-card__room">${escapeHtml(t("vote.cards.room", { room: card.room }))}</span>`
         : `<span class="flip-card__note">${escapeHtml(t("vote.cards.chosen"))}</span>`}`
    : "";
  return `
    <button type="button" class="flip-card ${card.taken ? "is-flipped" : ""} ${card.is_mine ? "is-mine" : ""}"
      data-card="${card.number}" ${canPick ? "" : "disabled"}
      aria-label="${escapeHtml(t("vote.cards.card", { n: card.number }))}">
      <span class="flip-card__inner">
        <span class="flip-card__face flip-card__front">
          <span class="flip-card__num">${card.number}</span>
          <span class="flip-card__label">${escapeHtml(canPick ? t("vote.cards.pick") : t("vote.cards.free"))}</span>
        </span>
        <span class="flip-card__face flip-card__back" data-card-back>${back}</span>
      </span>
    </button>`;
}

function cardsHintKey(data) {
  if (!data.is_leader) return store.user?.role === "admin" ? "vote.cards.admin_hint" : "vote.cards.member_hint";
  if (data.my_card) return "vote.cards.done_hint";
  if (!data.can_pick) return "vote.cards.all_taken";
  return "vote.cards.leader_hint";
}

function cardsBlockHtml(data) {
  const banner = data.my_card
    ? `<div class="card card--accent center stack room-banner">
         <div style="font-size:2rem">🎉</div>
         <strong>${escapeHtml(t("vote.cards.result", { room: data.my_room }))}</strong>
       </div>`
    : "";
  return `
    <div class="page__head">
      <h1 class="page__title">🗂️ <span>${escapeHtml(t("vote.title"))}</span></h1>
      <div class="stage-tag">${escapeHtml(t("vote.cards.stage"))}</div>
      <p class="page__hint">${escapeHtml(t(cardsHintKey(data)))}</p>
    </div>
    ${data.visible === false ? `<div class="qnotice qnotice--warn" style="margin-bottom:var(--space-4)">👁️‍🗨️ ${escapeHtml(t("vote.cards.hidden_admin"))}</div>` : ""}
    ${banner}
    <div class="card card--flat spread" style="margin-bottom:var(--space-4)">
      <span class="row"><span class="live-dot"></span> <strong>${escapeHtml(t("common.live"))}</strong></span>
      <span class="badge badge--info">${escapeHtml(t("vote.cards.progress", {
        taken: data.taken_count,
        total: data.cards.length,
      }))}</span>
    </div>
    <div class="flip-grid">${data.cards.map((card) => roomCardHtml(card, data)).join("")}</div>`;
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
      [data, projectsData] = await Promise.all([api.cards(), api.projects()]);
    } catch (error) {
      root.innerHTML = `<div class="empty">${escapeHtml(apiErrorMessage(error))}</div>`;
      return;
    }

    // Лайки только у раундов, где они включены (задания №3 и выше).
    const galleries = (projectsData.galleries || []).filter((gallery) => gallery.round?.likes_enabled);
    root.dataset.ready = "1";
    const projectsHtml = galleries.map(projectsBlockHtml).join("");
    // Администратор скрыл карточки: участники видят только остальное содержимое страницы.
    const cardsHidden = data.visible === false && store.user?.role !== "admin";
    root.innerHTML = cardsHidden
      ? (projectsHtml || `<div class="empty">🗂️ ${escapeHtml(t("vote.cards.hidden"))}</div>`)
      : `${cardsBlockHtml(data)}${projectsHtml}`;

    root.querySelectorAll("[data-card]").forEach((button) => {
      button.addEventListener("click", async () => {
        const number = Number(button.dataset.card);
        if (!await confirmDialog(t("vote.cards.confirm", { n: number }))) return;
        root.querySelectorAll("[data-card]").forEach((other) => { other.disabled = true; });
        try {
          const result = await api.pickCard(number);
          const mine = result.cards.find((card) => card.number === number);
          button.querySelector("[data-card-back]").innerHTML = `
            <span class="flip-card__team">${escapeHtml(mine.team_name)}</span>
            <span class="flip-card__room">${escapeHtml(t("vote.cards.room", { room: mine.room }))}</span>`;
          button.classList.add("is-flipped", "is-mine");
          setTimeout(() => {
            openModal({
              title: t("vote.cards.result_title"),
              bodyHtml: `<p class="room-message">${escapeHtml(t("vote.cards.result", { room: result.my_room }))}</p>`,
            });
            this.render(root);
          }, 900);
        } catch (error) {
          notify.err(vote_error(error));
          await this.render(root);
        }
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
