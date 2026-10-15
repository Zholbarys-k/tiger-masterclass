"""Таймеры заданий (№2, №3 и новые) и галереи проектов для голосования лайками."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, update

from .db import db
from .models import (
    PHASE_T3_CLOSED,
    PHASE_T3_IDLE,
    PHASE_T3_RUNNING,
    PHASE_T3_VOTING,
    TASK3_DEFAULT_SECONDS,
    TIMED_TASK_MIN_ORDER,
    ProjectVote,
    Submission,
    Task,
    TaskRound,
    Team,
    bump,
    utcnow,
)

MIN_SECONDS = 60
MAX_SECONDS = 4 * 3600


def clamp_seconds(value: int, fallback: int = TASK3_DEFAULT_SECONDS) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    if number < MIN_SECONDS or number > MAX_SECONDS:
        return fallback
    return number


def needs_round(task: Task) -> bool:
    return (task.order or 0) >= TIMED_TASK_MIN_ORDER


def get_task(task_id: int | None = None, order: int | None = None) -> Task | None:
    query = db.session.query(Task)
    if task_id:
        return query.filter_by(id=task_id).first()
    if order is not None:
        return query.filter_by(order=order).order_by(Task.id.asc()).first()
    return None


def ensure_rounds() -> list[TaskRound]:
    """Создать пульты для задания №2, №3 и любых новых заданий."""
    tasks = (
        db.session.query(Task)
        .filter(Task.order >= TIMED_TASK_MIN_ORDER)
        .order_by(Task.order.asc(), Task.id.asc())
        .all()
    )
    rows = db.session.query(TaskRound).all()
    by_task = {row.task_id: row for row in rows if row.task_id}
    by_order = {row.task_order: row for row in rows if not row.task_id}
    created = False
    for task in tasks:
        row = by_task.get(task.id) or by_order.get(task.order)
        if row is None:
            row = TaskRound(
                task_id=task.id,
                task_order=task.order,
                phase=PHASE_T3_IDLE,
                duration_seconds=TASK3_DEFAULT_SECONDS,
            )
            db.session.add(row)
            by_task[task.id] = row
            created = True
        else:
            if row.task_id != task.id:
                row.task_id = task.id
                created = True
            if row.task_order != task.order:
                row.task_order = task.order
                created = True
    if created:
        try:
            db.session.commit()
        except Exception:  # параллельный запрос уже создал пульт
            db.session.rollback()
    return (
        db.session.query(TaskRound)
        .filter(TaskRound.task_id.isnot(None))
        .order_by(TaskRound.task_order.asc(), TaskRound.id.asc())
        .all()
    )


def get_rounds() -> list[TaskRound]:
    return ensure_rounds()


def get_round(task_id: int | None = None) -> TaskRound | None:
    ensure_rounds()
    if task_id:
        return db.session.query(TaskRound).filter_by(task_id=task_id).first()
    return db.session.query(TaskRound).order_by(TaskRound.task_order.asc()).first()


def ensure_progress(round_: TaskRound | None = None) -> bool:
    """Если час вышел — открыть голосование за проекты."""
    rows = [round_] if round_ is not None else get_rounds()
    changed = False
    for row in rows:
        if row is None:
            continue
        if row.phase != PHASE_T3_RUNNING or row.is_paused or row.phase_ends_at is None:
            continue
        if utcnow() < row.phase_ends_at:
            continue
        result = db.session.execute(
            update(TaskRound)
            .where(TaskRound.id == row.id, TaskRound.phase == PHASE_T3_RUNNING)
            .values(
                phase=row.after_work_phase,
                phase_started_at=utcnow(),
                phase_ends_at=None,
                is_paused=False,
                paused_remaining=0,
            ),
        )
        if result.rowcount:
            changed = True
            db.session.refresh(row)
        else:
            db.session.refresh(row)
    if changed:
        bump("task3", "votes", "tasks")
        db.session.commit()
    else:
        db.session.commit()
    return changed


def apply_values(row: TaskRound, values: dict) -> None:
    for field, value in values.items():
        setattr(row, field, value)
    bump("task3", "votes", "tasks")
    db.session.commit()


def start(row: TaskRound) -> None:
    now = utcnow()
    apply_values(row, {
        "phase": PHASE_T3_RUNNING,
        "phase_started_at": now,
        "phase_ends_at": now + timedelta(seconds=row.duration_seconds),
        "is_paused": False,
        "paused_remaining": 0,
    })


def finish(row: TaskRound) -> None:
    apply_values(row, {
        "phase": row.after_work_phase,
        "phase_started_at": utcnow(),
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    })


def close_voting(row: TaskRound) -> None:
    apply_values(row, {
        "phase": PHASE_T3_CLOSED,
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    })


def open_voting(row: TaskRound) -> None:
    if not row.likes_enabled:
        return
    apply_values(row, {
        "phase": PHASE_T3_VOTING,
        "phase_started_at": row.phase_started_at or utcnow(),
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    })


def pause(row: TaskRound) -> None:
    if not row.is_live or row.is_paused:
        return
    apply_values(row, {
        "is_paused": True,
        "paused_remaining": row.remaining_seconds or 0,
    })


def resume(row: TaskRound) -> None:
    if not row.is_paused:
        return
    left = max(1, row.paused_remaining or 1)
    apply_values(row, {
        "is_paused": False,
        "paused_remaining": 0,
        "phase_ends_at": utcnow() + timedelta(seconds=left),
    })


def extend(row: TaskRound, seconds: int) -> None:
    if not row.is_live:
        return
    if row.is_paused:
        apply_values(row, {"paused_remaining": max(1, (row.paused_remaining or 0) + seconds)})
        return
    base = row.phase_ends_at or utcnow()
    new_end = base + timedelta(seconds=seconds)
    if new_end <= utcnow():
        new_end = utcnow() + timedelta(seconds=1)
    apply_values(row, {"phase_ends_at": new_end})


def reset(row: TaskRound, clear_likes: bool = True) -> None:
    if clear_likes and row.task_id:
        db.session.query(ProjectVote).filter_by(task_id=row.task_id).delete()
    apply_values(row, {
        "phase": PHASE_T3_IDLE,
        "phase_started_at": None,
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    })


def reset_all_rounds() -> None:
    for row in get_rounds():
        row.phase = PHASE_T3_IDLE
        row.phase_started_at = None
        row.phase_ends_at = None
        row.is_paused = False
        row.paused_remaining = 0
    bump("task3", "votes", "tasks")
    db.session.commit()


def settings(row: TaskRound, data: dict) -> None:
    if "duration_seconds" in data:
        new_value = clamp_seconds(data["duration_seconds"], row.duration_seconds)
        if row.phase == PHASE_T3_RUNNING:
            delta = new_value - row.duration_seconds
            if row.is_paused:
                row.paused_remaining = max(1, (row.paused_remaining or 0) + delta)
            elif row.phase_ends_at is not None:
                row.phase_ends_at += timedelta(seconds=delta)
                if row.phase_ends_at <= utcnow():
                    row.phase_ends_at = utcnow() + timedelta(seconds=1)
        row.duration_seconds = new_value
    bump("task3", "tasks")
    db.session.commit()


def files_public_for(submission: Submission) -> bool:
    task = submission.task
    if task is None or not needs_round(task):
        return False
    row = get_round(task.id)
    if row is None:
        return False
    ensure_progress(row)
    return row.projects_visible


def project_cards(task_id: int, lang: str = "ru") -> list[dict]:
    likes = dict(
        db.session.query(ProjectVote.submission_id, func.count(ProjectVote.id))
        .filter(ProjectVote.task_id == task_id)
        .group_by(ProjectVote.submission_id)
        .all()
    )
    rows = (
        db.session.query(Submission)
        .filter_by(task_id=task_id)
        .join(Team, Submission.team_id == Team.id)
        .order_by(Team.number.asc(), Submission.id.asc())
        .all()
    )
    cards = []
    for submission in rows:
        photo = next((a.to_dict() for a in submission.attachments if a.kind == "image"), None)
        video = next((a.to_dict() for a in submission.attachments if a.kind == "video"), None)
        cards.append({
            "id": submission.id,
            "task_id": task_id,
            "team_id": submission.team_id,
            "team_number": submission.team.number if submission.team else 0,
            "title": submission.team.name if submission.team else "",
            "description": (submission.text or "").strip(),
            "photo": photo,
            "video": video,
            "likes": likes.get(submission.id, 0),
        })
    return cards


def gallery_for(row: TaskRound, lang: str, user, *, force: bool = False) -> dict:
    from .models import ROLE_ADMIN, ROLE_LEADER, ROLE_MEMBER

    visible = row.projects_visible or force or (user and user.role == ROLE_ADMIN)
    cards = project_cards(row.task_id, lang) if visible and row.task_id else []
    my_like = None
    if user and row.task_id:
        my_like = next((vote.submission_id for vote in user.project_votes if vote.task_id == row.task_id), None)
    task = row.task
    return {
        "task_id": row.task_id,
        "task_order": row.task_order,
        "task_title": task.to_dict(lang)["title"] if task else f"#{row.task_order}",
        "round": row.to_dict(),
        "projects": cards,
        "my_like_id": my_like,
        "can_like": row.can_like and user is not None and user.role in (ROLE_LEADER, ROLE_MEMBER),
        "total_likes": sum(card["likes"] for card in cards),
    }
