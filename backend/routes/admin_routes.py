"""Панель администратора: команды, баллы, задания, тест, отправки, голоса."""
from __future__ import annotations

from flask import Blueprint, current_app, g, request

from ..auth import require_role
from ..db import db
from ..models import (
    ROLE_ADMIN,
    ROLE_LEADER,
    ROLE_MEMBER,
    Attachment,
    Question,
    Quiz,
    QuizAnswer,
    ScoreAdjustment,
    Section,
    Submission,
    Task,
    Team,
    User,
    Vote,
    bump,
    utcnow,
)
from ..utils import as_int, current_lang, json_err, json_ok, localized_payload

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
admin_only = require_role(ROLE_ADMIN)


# --------------------------------------------------------------------------- #
# Сводка
# --------------------------------------------------------------------------- #
@bp.get("/overview")
@admin_only
def overview():
    lang = current_lang()
    teams = db.session.query(Team).all()
    quiz = db.session.query(Quiz).order_by(Quiz.id).first()
    active_teams = [t for t in teams if t.has_activity]
    return json_ok(
        stats={
            "teams": len(teams),
            "active_teams": len(active_teams),
            "users": db.session.query(User).count(),
            "leaders": db.session.query(User).filter_by(role=ROLE_LEADER).count(),
            "members": db.session.query(User).filter_by(role=ROLE_MEMBER).count(),
            "admins": db.session.query(User).filter_by(role=ROLE_ADMIN).count(),
            "tasks": db.session.query(Task).count(),
            "submissions": db.session.query(Submission).count(),
            "attachments": db.session.query(Attachment).count(),
            "votes": db.session.query(Vote).count(),
            "quiz_answers": db.session.query(QuizAnswer).count(),
        },
        quiz=quiz.to_dict(lang) if quiz else None,
        participant_password=current_app.config["PARTICIPANT_PASSWORD"],
        admin_password=current_app.config["ADMIN_PASSWORD"],
    )


# --------------------------------------------------------------------------- #
# Команды и пользователи
# --------------------------------------------------------------------------- #
@bp.get("/teams")
@admin_only
def teams_list():
    teams = db.session.query(Team).order_by(Team.number).all()
    return json_ok(teams=[t.to_dict(with_users=True) for t in teams])


@bp.patch("/teams/<int:team_id>")
@admin_only
def update_team(team_id: int):
    """Переименование команды или изменение активности."""
    team = db.session.get(Team, team_id)
    if team is None:
        return json_err("not_found", "Команда не найдена", 404)

    data = request.get_json(silent=True) or {}
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            return json_err("bad_name", "Название не может быть пустым", 400)
        clash = db.session.query(Team).filter(Team.name == name, Team.id != team_id).first()
        if clash:
            return json_err("name_taken", "Такое название уже используется", 400)
        team.name = name
    if "is_active" in data:
        team.is_active = bool(data["is_active"])

    bump("teams", "leaderboard")
    db.session.commit()
    return json_ok(team=team.to_dict(with_users=True))


@bp.patch("/users/<int:user_id>")
@admin_only
def update_user(user_id: int):
    """Изменение логина, имени, активности, перенос в другую команду, смена роли."""
    user = db.session.get(User, user_id)
    if user is None:
        return json_err("not_found", "Пользователь не найден", 404)

    data = request.get_json(silent=True) or {}

    if "login" in data:
        login = (data["login"] or "").strip().lower()
        if len(login) < 3:
            return json_err("bad_login", "Логин слишком короткий (минимум 3 символа)", 400)
        if any(ch.isspace() for ch in login):
            return json_err("bad_login", "Логин не должен содержать пробелы", 400)
        clash = db.session.query(User).filter(User.login == login, User.id != user_id).first()
        if clash:
            return json_err("login_taken", "Такой логин уже занят", 400)
        user.login = login

    if "display_name" in data:
        user.display_name = (data["display_name"] or "").strip()[:120]

    if "is_active" in data:
        user.is_active = bool(data["is_active"])
        if not user.is_active:
            for token in list(user.tokens):
                db.session.delete(token)

    if "team_id" in data:
        if user.role == ROLE_ADMIN:
            return json_err("bad_role", "Администратор не входит в команды", 400)
        new_team_id = data["team_id"]
        if new_team_id in (None, "", 0):
            return json_err("bad_team", "Укажите команду", 400)
        team = db.session.get(Team, as_int(new_team_id))
        if team is None:
            return json_err("not_found", "Команда не найдена", 404)
        if user.role == ROLE_LEADER and team.leader and team.leader.id != user.id:
            # В целевой команде уже есть лидер — переносим пользователя как участника.
            user.role = ROLE_MEMBER
        user.team_id = team.id

    if "role" in data and data["role"] in (ROLE_LEADER, ROLE_MEMBER):
        new_role = data["role"]
        if user.role == ROLE_ADMIN:
            return json_err("bad_role", "Нельзя менять роль администратора", 400)
        if new_role == ROLE_LEADER:
            return _promote_leader(user)
        user.role = ROLE_MEMBER

    bump("teams", "leaderboard")
    db.session.commit()
    return json_ok(user=user.to_dict())


def _promote_leader(user: User):
    """Сделать пользователя лидером своей команды, прежнего лидера — участником."""
    if not user.team_id:
        return json_err("no_team", "Пользователь не привязан к команде", 400)
    team = db.session.get(Team, user.team_id)
    old_leader = team.leader
    if old_leader and old_leader.id != user.id:
        old_leader.role = ROLE_MEMBER
    user.role = ROLE_LEADER
    bump("teams", "leaderboard")
    db.session.commit()
    return json_ok(user=user.to_dict(), team=team.to_dict(with_users=True))


@bp.post("/teams/<int:team_id>/leader/<int:user_id>")
@admin_only
def set_leader(team_id: int, user_id: int):
    """Назначить лидера команды."""
    user = db.session.get(User, user_id)
    if user is None or user.team_id != team_id:
        return json_err("not_found", "Пользователь не найден в этой команде", 404)
    return _promote_leader(user)


@bp.post("/users/<int:user_id>/move/<int:team_id>")
@admin_only
def move_user(user_id: int, team_id: int):
    """Перенести участника в другую команду."""
    user = db.session.get(User, user_id)
    team = db.session.get(Team, team_id)
    if user is None or team is None:
        return json_err("not_found", "Пользователь или команда не найдены", 404)
    if user.role == ROLE_ADMIN:
        return json_err("bad_role", "Администратор не входит в команды", 400)
    if user.role == ROLE_LEADER and team.leader and team.leader.id != user.id:
        user.role = ROLE_MEMBER
    user.team_id = team.id
    bump("teams", "leaderboard")
    db.session.commit()
    return json_ok(user=user.to_dict())


# --------------------------------------------------------------------------- #
# Баллы
# --------------------------------------------------------------------------- #
@bp.post("/teams/<int:team_id>/score")
@admin_only
def adjust_score(team_id: int):
    """Ручная правка баллов: delta (+/-) или set_total (установить итог)."""
    team = db.session.get(Team, team_id)
    if team is None:
        return json_err("not_found", "Команда не найдена", 404)

    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "Правка администратора")[:255]

    if "set_total" in data and data["set_total"] not in (None, ""):
        target = as_int(data["set_total"], team.total_points)
        delta = target - team.total_points
    else:
        delta = as_int(data.get("delta"), 0)

    if delta == 0:
        return json_err("no_change", "Изменение равно нулю", 400)

    db.session.add(ScoreAdjustment(
        team_id=team.id, admin_id=g.user.id, delta=delta, reason=reason,
    ))
    bump("leaderboard", "teams")
    db.session.commit()
    return json_ok(team=team.to_dict(), delta=delta)


@bp.get("/teams/<int:team_id>/adjustments")
@admin_only
def adjustments(team_id: int):
    rows = (db.session.query(ScoreAdjustment)
            .filter_by(team_id=team_id)
            .order_by(ScoreAdjustment.created_at.desc()).all())
    return json_ok(adjustments=[r.to_dict() for r in rows])


@bp.patch("/submissions/<int:submission_id>/points")
@admin_only
def set_submission_points(submission_id: int):
    """Оценка ответа команды за задание."""
    submission = db.session.get(Submission, submission_id)
    if submission is None:
        return json_err("not_found", "Ответ не найден", 404)
    data = request.get_json(silent=True) or {}
    points = as_int(data.get("points"), 0)
    max_points = submission.task.max_points if submission.task else 100
    submission.points = max(0, min(points, max_points))
    submission.updated_at = utcnow()
    bump("leaderboard", "submissions")
    db.session.commit()
    return json_ok(submission=submission.to_dict(current_lang()))


# --------------------------------------------------------------------------- #
# Отправки и голоса
# --------------------------------------------------------------------------- #
@bp.get("/submissions")
@admin_only
def all_submissions():
    lang = current_lang()
    query = db.session.query(Submission)
    task_id = request.args.get("task_id")
    team_id = request.args.get("team_id")
    if task_id:
        query = query.filter_by(task_id=as_int(task_id))
    if team_id:
        query = query.filter_by(team_id=as_int(team_id))
    rows = query.order_by(Submission.created_at.desc()).all()
    return json_ok(submissions=[r.to_dict(lang) for r in rows])


# --------------------------------------------------------------------------- #
# Задания
# --------------------------------------------------------------------------- #
@bp.get("/tasks")
@admin_only
def admin_tasks():
    lang = current_lang()
    rows = db.session.query(Task).order_by(Task.order, Task.id).all()
    return json_ok(tasks=[t.to_dict(lang, full=True) for t in rows])


@bp.post("/tasks")
@admin_only
def create_task():
    data = request.get_json(silent=True) or {}
    titles = localized_payload("title", data)
    bodies = localized_payload("body", data)
    if not titles["title_ru"] and not titles["title_en"] and not titles["title_kk"]:
        return json_err("bad_title", "Укажите название задания", 400)

    last_order = db.session.query(Task).count()
    task = Task(
        order=as_int(data.get("order"), last_order + 1),
        max_points=as_int(data.get("max_points"), 10),
        allow_files=bool(data.get("allow_files", True)),
        is_published=bool(data.get("is_published", True)),
        **titles, **bodies,
    )
    db.session.add(task)
    bump("tasks")
    db.session.commit()
    return json_ok(task=task.to_dict(current_lang(), full=True))


@bp.patch("/tasks/<int:task_id>")
@admin_only
def update_task(task_id: int):
    task = db.session.get(Task, task_id)
    if task is None:
        return json_err("not_found", "Задание не найдено", 404)

    data = request.get_json(silent=True) or {}
    for prefix in ("title", "body"):
        if any(f"{prefix}_{code}" in data for code in ("kk", "ru", "en")):
            for field, value in localized_payload(prefix, data).items():
                setattr(task, field, value)
    if "max_points" in data:
        task.max_points = as_int(data["max_points"], task.max_points)
    if "is_published" in data:
        task.is_published = bool(data["is_published"])
    if "allow_files" in data:
        task.allow_files = bool(data["allow_files"])
    if "order" in data:
        task.order = as_int(data["order"], task.order)

    bump("tasks")
    db.session.commit()
    return json_ok(task=task.to_dict(current_lang(), full=True))


@bp.delete("/tasks/<int:task_id>")
@admin_only
def delete_task(task_id: int):
    task = db.session.get(Task, task_id)
    if task is None:
        return json_err("not_found", "Задание не найдено", 404)
    upload_root = current_app.config["UPLOAD_DIR"]
    for submission in task.submissions:
        folder = upload_root / str(submission.id)
        if folder.exists():
            for path in folder.iterdir():
                path.unlink(missing_ok=True)
            folder.rmdir()
    db.session.delete(task)
    bump("tasks", "leaderboard", "submissions")
    db.session.commit()
    return json_ok()


# --------------------------------------------------------------------------- #
# Тест
# --------------------------------------------------------------------------- #
@bp.post("/quiz/toggle")
@admin_only
def toggle_quiz():
    quiz = db.session.query(Quiz).order_by(Quiz.id).first()
    if quiz is None:
        return json_err("not_found", "Тест не найден", 404)
    data = request.get_json(silent=True) or {}
    quiz.is_open = bool(data.get("is_open", not quiz.is_open))
    if "show_results" in data:
        quiz.show_results = bool(data["show_results"])
    if quiz.is_open:
        quiz.opened_at = utcnow()
        quiz.closed_at = None
    else:
        quiz.closed_at = utcnow()
    bump("quiz")
    db.session.commit()
    return json_ok(quiz=quiz.to_dict(current_lang()))


@bp.post("/quiz/reset")
@admin_only
def reset_quiz():
    """Удалить все ответы теста (баллы за тест обнуляются)."""
    db.session.query(QuizAnswer).delete()
    bump("quiz", "leaderboard")
    db.session.commit()
    return json_ok()


@bp.get("/quiz/questions")
@admin_only
def quiz_questions():
    lang = current_lang()
    quiz = db.session.query(Quiz).order_by(Quiz.id).first()
    if quiz is None:
        return json_ok(questions=[])
    return json_ok(
        quiz=quiz.to_dict(lang),
        questions=[q.to_dict(lang, reveal=True) for q in quiz.questions],
    )


# --------------------------------------------------------------------------- #
# Секции
# --------------------------------------------------------------------------- #
@bp.patch("/sections/<int:section_id>")
@admin_only
def update_section(section_id: int):
    section = db.session.get(Section, section_id)
    if section is None:
        return json_err("not_found", "Секция не найдена", 404)
    data = request.get_json(silent=True) or {}
    if "is_open" in data:
        section.is_open = bool(data["is_open"])
    for prefix in ("name", "desc"):
        if any(f"{prefix}_{code}" in data for code in ("kk", "ru", "en")):
            for field, value in localized_payload(prefix, data).items():
                setattr(section, field, value)
    bump("votes")
    db.session.commit()
    return json_ok(section=section.to_dict(current_lang()))


@bp.post("/votes/reset")
@admin_only
def reset_votes():
    db.session.query(Vote).delete()
    bump("votes")
    db.session.commit()
    return json_ok()
