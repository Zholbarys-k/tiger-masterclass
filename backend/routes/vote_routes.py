"""Голосование за секции мастер-класса."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import require_auth, require_role
from ..db import db
from ..models import ROLE_ADMIN, ROLE_LEADER, ROLE_MEMBER, Section, Vote, bump, utcnow
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
    return json_ok(votes=payload, **_results(lang))
