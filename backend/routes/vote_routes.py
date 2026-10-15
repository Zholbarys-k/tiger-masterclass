"""Выбор карточек кабинетов и лайки проектов заданий."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import require_auth, require_role
from ..db import db
from ..models import (
    ROLE_ADMIN,
    ROLE_LEADER,
    ROLE_MEMBER,
    ProjectVote,
    RoomCard,
    Submission,
    bump,
    get_setting,
    set_setting,
    utcnow,
)
from ..utils import as_int, current_lang, json_err, json_ok

bp = Blueprint("votes", __name__, url_prefix="/api")


CARDS_VISIBLE_KEY = "room_cards_visible"


def cards_visible() -> bool:
    return get_setting(CARDS_VISIBLE_KEY, "1") == "1"


def _cards_payload() -> dict:
    """Карточки кабинетов глазами текущего пользователя (скрытые — только админу)."""
    visible = cards_visible()
    if not visible and g.user.role != ROLE_ADMIN:
        return {
            "cards": [], "my_card": None, "my_room": "", "can_pick": False,
            "is_leader": g.user.role == ROLE_LEADER, "taken_count": 0, "visible": False,
        }
    cards = db.session.query(RoomCard).order_by(RoomCard.number).all()
    mine = next((card for card in cards if card.team_id and card.team_id == g.user.team_id), None)
    is_leader = g.user.role == ROLE_LEADER
    free_left = any(not card.is_taken for card in cards)
    return {
        "cards": [card.to_dict(g.user) for card in cards],
        "my_card": mine.number if mine else None,
        "my_room": mine.room if mine else "",
        "can_pick": bool(is_leader and g.user.team_id and mine is None and free_left),
        "is_leader": is_leader,
        "taken_count": sum(1 for card in cards if card.is_taken),
        "visible": visible,
    }


@bp.get("/cards")
@require_auth
def room_cards():
    """Карточки кабинетов: какая команда какую выбрала (кабинет видит только её команда)."""
    return json_ok(**_cards_payload())


@bp.post("/cards/pick")
@require_role(ROLE_LEADER)
def pick_card():
    """Лидер команды выбирает карточку. Одна карточка — одна команда, одна карточка — команде."""
    if not g.user.team_id:
        return json_err("no_team", "Пользователь не привязан к команде", 400)
    if not cards_visible():
        return json_err("cards_hidden", "Выбор карточек сейчас скрыт администратором", 403)

    data = request.get_json(silent=True) or {}
    number = as_int(data.get("number"), 0)
    card = db.session.query(RoomCard).filter_by(number=number).one_or_none()
    if card is None:
        return json_err("card_not_found", "Карточка не найдена", 404)

    already = db.session.query(RoomCard).filter_by(team_id=g.user.team_id).one_or_none()
    if already is not None:
        return json_err("team_already_picked", "Ваша команда уже выбрала карточку", 409)

    # Условное обновление: если две команды нажали одновременно, займёт только одна.
    updated = (db.session.query(RoomCard)
               .filter(RoomCard.id == card.id, RoomCard.team_id.is_(None))
               .update({
                   "team_id": g.user.team_id,
                   "picked_by_id": g.user.id,
                   "picked_at": utcnow(),
               }, synchronize_session=False))
    if updated == 0:
        db.session.rollback()
        return json_err("card_taken", "Эту карточку уже выбрала другая команда", 409)

    bump("votes")
    db.session.commit()
    db.session.expire_all()
    return json_ok(**_cards_payload(), message="Карточка выбрана")


@bp.post("/cards/<int:number>/release")
@require_role(ROLE_ADMIN)
def release_card(number: int):
    """Администратор освобождает карточку, чтобы команда могла выбрать заново."""
    card = db.session.query(RoomCard).filter_by(number=number).one_or_none()
    if card is None:
        return json_err("card_not_found", "Карточка не найдена", 404)
    card.team_id = None
    card.picked_by_id = None
    card.picked_at = None
    bump("votes")
    db.session.commit()
    return json_ok(**_cards_payload())


@bp.post("/cards/visibility")
@require_role(ROLE_ADMIN)
def set_cards_visibility():
    """Администратор скрывает карточки кабинетов от участников или показывает снова."""
    data = request.get_json(silent=True) or {}
    set_setting(CARDS_VISIBLE_KEY, "1" if data.get("visible", True) else "0")
    bump("votes")
    db.session.commit()
    return json_ok(**_cards_payload())


@bp.post("/cards/reset")
@require_role(ROLE_ADMIN)
def reset_cards():
    """Администратор освобождает все карточки."""
    db.session.query(RoomCard).update({
        "team_id": None, "picked_by_id": None, "picked_at": None,
    })
    bump("votes")
    db.session.commit()
    return json_ok(**_cards_payload())


@bp.get("/votes/all")
@require_role(ROLE_ADMIN)
def all_votes():
    """Админская сводка: карточки кабинетов и лайки проектов."""
    lang = current_lang()
    from ..task3_engine import ensure_progress, gallery_for, get_rounds

    ensure_progress()
    galleries = [gallery_for(row, lang, g.user, force=True) for row in get_rounds()]
    likes = (
        db.session.query(ProjectVote)
        .order_by(ProjectVote.updated_at.desc())
        .all()
    )
    return json_ok(
        **_cards_payload(),
        galleries=galleries,
        projects=[card for gallery in galleries for card in gallery["projects"]],
        project_votes=[item.to_dict() for item in likes],
    )


def _projects_payload():
    from ..task3_engine import ensure_progress, gallery_for, get_rounds

    lang = current_lang()
    ensure_progress()
    galleries = [gallery_for(row, lang, g.user) for row in get_rounds()]
    return {"galleries": galleries}


@bp.get("/projects")
@require_auth
def list_projects():
    """Галереи проектов заданий с таймером — видны после истечения часа."""
    return json_ok(**_projects_payload())


@bp.post("/projects/like")
@require_role(ROLE_LEADER, ROLE_MEMBER)
def like_project():
    """Один лайк на задание; повторный вызов меняет выбор."""
    from ..task3_engine import ensure_progress, get_round

    data = request.get_json(silent=True) or {}
    submission_id = data.get("submission_id")
    submission = db.session.get(Submission, submission_id) if submission_id else None
    if submission is None or not submission.task_id:
        return json_err("not_found", "Проект не найден", 404)

    row = get_round(submission.task_id)
    if row is None:
        return json_err("not_found", "Для этого задания нет голосования", 404)
    ensure_progress(row)
    if not row.likes_enabled:
        return json_err("likes_disabled", "Для этого задания лайки не предусмотрены", 400)
    if not row.can_like:
        return json_err("voting_closed", "Голосование за проекты сейчас закрыто", 400)
    if g.user.team_id and submission.team_id == g.user.team_id:
        return json_err("own_project", "Нельзя голосовать за проект своей команды", 400)

    vote = next((item for item in g.user.project_votes if item.task_id == submission.task_id), None)
    if vote is None:
        vote = ProjectVote(
            user_id=g.user.id,
            task_id=submission.task_id,
            submission_id=submission.id,
        )
        db.session.add(vote)
    else:
        vote.submission_id = submission.id
        vote.updated_at = utcnow()

    bump("votes", "task3")
    db.session.commit()
    return json_ok(**_projects_payload(), message="Лайк учтён")
