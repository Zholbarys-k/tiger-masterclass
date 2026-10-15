"""Вопросы участников и лидеров администраторам."""
from __future__ import annotations

from flask import Blueprint, g, request
from sqlalchemy import func

from ..auth import require_auth, require_role
from ..db import db
from ..models import ROLE_ADMIN, ROLE_LEADER, ROLE_MEMBER, Message, TeamMessage, User, bump, utcnow
from ..utils import json_object, json_err, json_ok

bp = Blueprint("messages", __name__, url_prefix="/api")

BODY_MAX = 1000
THREAD_LIMIT = 200


def unread_count_for(user: User) -> int:
    """Сколько входящих сообщений ещё не прочитано этим пользователем."""
    if user.role == ROLE_ADMIN:
        query = db.session.query(func.count(Message.id)).filter(
            Message.is_read.is_(False),
            Message.author_id == Message.thread_user_id,
        )
    else:
        query = db.session.query(func.count(Message.id)).filter(
            Message.is_read.is_(False),
            Message.thread_user_id == user.id,
            Message.author_id != user.id,
        )
    return query.scalar() or 0


def _clean_body(raw) -> str | None:
    body = (raw or "").strip()
    if not body:
        return None
    return body[:BODY_MAX]


def _thread_payload(user_id: int, mark_reader_id: int | None = None) -> list[dict]:
    rows = (
        db.session.query(Message)
        .filter_by(thread_user_id=user_id)
        .order_by(Message.created_at.asc(), Message.id.asc())
        .limit(THREAD_LIMIT)
        .all()
    )
    if mark_reader_id:
        changed = False
        for row in rows:
            if row.author_id != mark_reader_id and not row.is_read:
                row.is_read = True
                changed = True
        if changed:
            bump("messages")
            db.session.commit()
    return [row.to_dict() for row in rows]


@bp.get("/messages")
@require_auth
def my_messages():
    """Ветка текущего участника или лидера."""
    if g.user.role == ROLE_ADMIN:
        return json_err("admin_inbox", "Администратор читает сообщения во вкладке «Сообщения»", 400)
    messages = _thread_payload(g.user.id, mark_reader_id=g.user.id)
    return json_ok(messages=messages, unread=0)


@bp.post("/messages")
@require_role(ROLE_LEADER, ROLE_MEMBER)
def send_message():
    """Вопрос администраторам от участника или лидера."""
    body = _clean_body((json_object()).get("body"))
    if not body:
        return json_err("empty", "Напишите сообщение", 400)

    record = Message(
        thread_user_id=g.user.id,
        author_id=g.user.id,
        body=body,
        is_read=False,
        created_at=utcnow(),
    )
    db.session.add(record)
    bump("messages")
    db.session.commit()
    return json_ok(message=record.to_dict())


@bp.get("/admin/messages")
@require_role(ROLE_ADMIN)
def admin_threads():
    """Список переписок: последняя реплика и счётчик непрочитанных."""
    last_id = (
        db.session.query(Message.thread_user_id, func.max(Message.id).label("last_id"))
        .group_by(Message.thread_user_id)
        .subquery()
    )
    rows = (
        db.session.query(Message)
        .join(last_id, Message.id == last_id.c.last_id)
        .order_by(Message.created_at.desc())
        .all()
    )
    unread_rows = (
        db.session.query(Message.thread_user_id, func.count(Message.id))
        .filter(Message.is_read.is_(False), Message.author_id == Message.thread_user_id)
        .group_by(Message.thread_user_id)
        .all()
    )
    unread_map = {user_id: count for user_id, count in unread_rows}

    threads = []
    for row in rows:
        person = row.thread_user
        threads.append({
            "user_id": row.thread_user_id,
            "login": person.login if person else "",
            "display_name": (person.display_name if person else "") or "",
            "role": person.role if person else "",
            "team_name": person.team.name if person and person.team else "",
            "last_body": row.body,
            "last_at": row.created_at.isoformat() if row.created_at else None,
            "unread": unread_map.get(row.thread_user_id, 0),
        })
    return json_ok(threads=threads, unread=sum(unread_map.values()))


@bp.get("/admin/messages/<int:user_id>")
@require_role(ROLE_ADMIN)
def admin_thread(user_id: int):
    person = db.session.get(User, user_id)
    if person is None or person.role == ROLE_ADMIN:
        return json_err("not_found", "Участник не найден", 404)
    messages = _thread_payload(user_id, mark_reader_id=g.user.id)
    return json_ok(user=person.to_dict(), messages=messages)


@bp.post("/admin/messages/<int:user_id>")
@require_role(ROLE_ADMIN)
def admin_reply(user_id: int):
    person = db.session.get(User, user_id)
    if person is None or person.role == ROLE_ADMIN:
        return json_err("not_found", "Участник не найден", 404)
    body = _clean_body((json_object()).get("body"))
    if not body:
        return json_err("empty", "Напишите сообщение", 400)

    record = Message(
        thread_user_id=person.id,
        author_id=g.user.id,
        body=body,
        is_read=False,
        created_at=utcnow(),
    )
    db.session.add(record)
    bump("messages")
    db.session.commit()
    return json_ok(message=record.to_dict())


@bp.post("/admin/messages/reset")
@require_role(ROLE_ADMIN)
def reset_all_chats():
    """Удалить все переписки с админами и все командные чаты."""
    admin_deleted = db.session.query(Message).delete()
    team_deleted = db.session.query(TeamMessage).delete()
    bump("messages", "teamchat")
    db.session.commit()
    return json_ok(admin_deleted=admin_deleted, team_deleted=team_deleted)


def _require_team_id():
    if g.user.role == ROLE_ADMIN or not g.user.team_id:
        return None
    return g.user.team_id


@bp.get("/team/messages")
@require_role(ROLE_LEADER, ROLE_MEMBER)
def team_messages():
    """Чат своей команды."""
    team_id = _require_team_id()
    if not team_id:
        return json_err("no_team", "Вы не в команде", 400)
    rows = (
        db.session.query(TeamMessage)
        .filter_by(team_id=team_id)
        .order_by(TeamMessage.created_at.asc(), TeamMessage.id.asc())
        .limit(THREAD_LIMIT)
        .all()
    )
    return json_ok(
        messages=[row.to_dict() for row in rows],
        can_clear=g.user.role == ROLE_LEADER,
    )


@bp.post("/team/messages")
@require_role(ROLE_LEADER, ROLE_MEMBER)
def send_team_message():
    team_id = _require_team_id()
    if not team_id:
        return json_err("no_team", "Вы не в команде", 400)
    body = _clean_body((json_object()).get("body"))
    if not body:
        return json_err("empty", "Напишите сообщение", 400)
    record = TeamMessage(
        team_id=team_id,
        author_id=g.user.id,
        body=body,
        created_at=utcnow(),
    )
    db.session.add(record)
    bump("teamchat")
    db.session.commit()
    return json_ok(message=record.to_dict())


@bp.delete("/team/messages")
@require_role(ROLE_LEADER)
def clear_team_chat():
    """Лидер очищает чат своей команды."""
    team_id = _require_team_id()
    if not team_id:
        return json_err("no_team", "Вы не в команде", 400)
    deleted = db.session.query(TeamMessage).filter_by(team_id=team_id).delete()
    bump("teamchat")
    db.session.commit()
    return json_ok(deleted=deleted)
