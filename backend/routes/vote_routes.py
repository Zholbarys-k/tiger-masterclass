"""Голосование за секции мастер-класса и лайки проектов задания №3."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import require_auth, require_role
from ..db import db
from ..models import ROLE_ADMIN, ROLE_LEADER, ROLE_MEMBER, ProjectVote, Section, Submission, Vote, bump, utcnow
from ..utils import current_lang, json_err, json_ok

bp = Blueprint("votes", __name__, url_prefix="/api")


def _results(lang: str) -> dict:
    sections = db.session.query(Section).order_by(Section.order, Section.id).all()
    total = db.session.query(Vote).count()
    items = []
    for section in sections:
        count = len(section.votes)
        items.append({
            **section.to_dict(lang),
            "votes": count,
            "percent": round(count * 100 / total, 1) if total else 0.0,
        })
    items.sort(key=lambda s: (-s["votes"], s["name"]))
    return {"sections": items, "total_votes": total}


@bp.get("/sections")
@require_auth
def sections():
    lang = current_lang()
    data = _results(lang)
    my_vote = g.user.vote
    return json_ok(
        **data,
        my_vote_section_id=my_vote.section_id if my_vote else None,
        can_vote=g.user.role in (ROLE_LEADER, ROLE_MEMBER),
    )


@bp.post("/votes")
@require_role(ROLE_LEADER, ROLE_MEMBER)
def cast_vote():
    """Один голос на пользователя; повторный вызов меняет выбор."""
    data = request.get_json(silent=True) or {}
    section_id = data.get("section_id")
    section = db.session.get(Section, section_id) if section_id else None
    if section is None:
        return json_err("section_not_found", "Секция не найдена", 404)
    if not section.is_open:
        return json_err("section_closed", "Голосование за эту секцию закрыто", 400)

    vote = g.user.vote
    if vote is None:
        vote = Vote(user_id=g.user.id, section_id=section.id)
        db.session.add(vote)
    else:
        vote.section_id = section.id
        vote.updated_at = utcnow()

    bump("votes")
    db.session.commit()

    lang = current_lang()
    return json_ok(**_results(lang), my_vote_section_id=section.id, message="Голос учтён")


@bp.get("/votes/all")
@require_role(ROLE_ADMIN)
def all_votes():
    """Полный список голосов — только для администратора."""
    lang = current_lang()
    rows = db.session.query(Vote).order_by(Vote.updated_at.desc()).all()
    sections_map = {s.id: s.to_dict(lang)["name"] for s in db.session.query(Section).all()}
    payload = []
    for row in rows:
        item = row.to_dict()
        item["section_name"] = sections_map.get(row.section_id, "")
        payload.append(item)
    from ..task3_engine import ensure_progress, gallery_for, get_rounds

    ensure_progress()
    galleries = [gallery_for(row, lang, g.user, force=True) for row in get_rounds()]
    likes = (
        db.session.query(ProjectVote)
        .order_by(ProjectVote.updated_at.desc())
        .all()
    )
    return json_ok(
        votes=payload,
        **_results(lang),
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
