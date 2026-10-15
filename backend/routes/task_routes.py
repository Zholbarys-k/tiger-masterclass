"""Задания, отправка ответов лидером, файлы."""
from __future__ import annotations

from flask import Blueprint, current_app, g, request, send_from_directory

from ..auth import require_auth, require_role
from ..db import db
from ..models import (
    PHASE_T3_RUNNING,
    ROLE_ADMIN,
    ROLE_LEADER,
    Attachment,
    Submission,
    Task,
    bump,
    utcnow,
)
from ..utils import current_lang, json_err, json_ok, save_upload, validate_file

bp = Blueprint("tasks", __name__, url_prefix="/api")


@bp.get("/tasks")
@require_auth
def list_tasks():
    """Лента заданий. Участники и лидеры видят только опубликованные."""
    from ..task3_engine import ensure_progress, get_rounds

    lang = current_lang()
    query = db.session.query(Task)
    if g.user.role != ROLE_ADMIN:
        query = query.filter_by(is_published=True)
    tasks = query.order_by(Task.order, Task.id).all()

    my_subs: dict[int, dict] = {}
    if g.user.team_id:
        rows = db.session.query(Submission).filter_by(team_id=g.user.team_id).all()
        my_subs = {row.task_id: row.to_dict(lang) for row in rows}

    rounds = get_rounds()
    ensure_progress()
    rounds_map = {row.task_id: row.to_dict() for row in rounds if row.task_id}

    payload = []
    is_admin = g.user.role == ROLE_ADMIN
    for task in tasks:
        item = task.to_dict(lang)
        item["my_submission"] = my_subs.get(task.id)
        item["round"] = rounds_map.get(task.id)
        hidden = (
            not is_admin
            and item["round"] is not None
            and item["round"]["phase"] != PHASE_T3_RUNNING
        )
        item["content_hidden"] = hidden
        if hidden:
            item["title"] = ""
            item["body"] = ""
        payload.append(item)

    return json_ok(
        tasks=payload,
        can_submit=g.user.role == ROLE_LEADER,
        rounds=rounds_map,
        task3=next((row.to_dict() for row in rounds if row.task_order == 3), None),
    )


@bp.get("/submissions/mine")
@require_auth
def my_submissions():
    lang = current_lang()
    if not g.user.team_id:
        return json_ok(submissions=[])
    rows = (db.session.query(Submission)
            .filter_by(team_id=g.user.team_id)
            .order_by(Submission.created_at.desc()).all())
    return json_ok(submissions=[r.to_dict(lang) for r in rows])


@bp.post("/tasks/<int:task_id>/submit")
@require_role(ROLE_LEADER)
def submit(task_id: int):
    """Отправка итогового ответа команды. Доступно только лидеру."""
    lang = current_lang()
    task = db.session.get(Task, task_id)
    if task is None or not task.is_published:
        return json_err("task_not_found", "Задание не найдено", 404)
    if not g.user.team_id:
        return json_err("no_team", "Пользователь не привязан к команде", 400)

    from ..task3_engine import ensure_progress, get_round, needs_round

    if needs_round(task):
        round_ = get_round(task.id)
        if round_ is not None:
            ensure_progress(round_)
            if not round_.can_submit:
                return json_err(
                    "task_closed",
                    f"Время задания №{task.order} вышло. Ответы больше не принимаются",
                    400,
                )

    text = (request.form.get("text") or "").strip()
    files = [f for f in request.files.getlist("files") if f and f.filename]
    if files and not task.allow_files:
        return json_err("files_disabled", "Для этого задания загрузка файлов отключена", 400)

    if not text and not files:
        return json_err("empty_submission", "Добавьте текст ответа или файл", 400)

    limit = current_app.config["MAX_FILES_PER_SUBMISSION"]
    if len(files) > limit:
        return json_err("too_many_files", f"Можно прикрепить не более {limit} файлов", 400)

    for storage in files:
        valid, message = validate_file(storage)
        if not valid:
            return json_err("bad_file", f"{storage.filename}: {message}", 400)

    submission = (db.session.query(Submission)
                  .filter_by(task_id=task_id, team_id=g.user.team_id).one_or_none())
    if len(files) + (len(submission.attachments) if submission else 0) > limit:
        return json_err("too_many_files", f"Можно прикрепить не более {limit} файлов", 400)
    created = submission is None
    if created:
        submission = Submission(
            task_id=task_id,
            team_id=g.user.team_id,
            user_id=g.user.id,
            text=text,
        )
        db.session.add(submission)
        db.session.flush()
    else:
        if text:
            submission.text = text
        submission.user_id = g.user.id
        submission.updated_at = utcnow()

    for storage in files:
        meta = save_upload(storage, submission.id)
        db.session.add(Attachment(submission_id=submission.id, **meta))

    bump("submissions", "leaderboard", "tasks")
    db.session.commit()

    return json_ok(
        submission=submission.to_dict(lang),
        created=created,
        message="Ответ отправлен" if created else "Ответ обновлён",
    )


@bp.delete("/submissions/<int:submission_id>/attachments/<int:attachment_id>")
@require_role(ROLE_LEADER, ROLE_ADMIN)
def delete_attachment(submission_id: int, attachment_id: int):
    attachment = db.session.get(Attachment, attachment_id)
    if attachment is None or attachment.submission_id != submission_id:
        return json_err("not_found", "Файл не найден", 404)
    submission = attachment.submission
    if g.user.role != ROLE_ADMIN and submission.team_id != g.user.team_id:
        return json_err("forbidden", "Это файл другой команды", 403)

    path = current_app.config["UPLOAD_DIR"] / str(submission_id) / attachment.stored_name
    path.unlink(missing_ok=True)

    db.session.delete(attachment)
    bump("submissions")
    db.session.commit()
    return json_ok()


@bp.get("/files/<int:submission_id>/<path:stored_name>")
@require_auth
def serve_file(submission_id: int, stored_name: str):
    """Отдача загруженного файла: своей команде или администратору."""
    submission = db.session.get(Submission, submission_id)
    if submission is None:
        return json_err("not_found", "Файл не найден", 404)
    if g.user.role != ROLE_ADMIN and submission.team_id != g.user.team_id:
        from ..task3_engine import files_public_for

        if not files_public_for(submission):
            return json_err("forbidden", "Нет доступа к этому файлу", 403)

    folder = current_app.config["UPLOAD_DIR"] / str(submission_id)
    attachment = next(
        (row for row in submission.attachments if row.stored_name == stored_name),
        None,
    )
    if attachment is None:
        return json_err("not_found", "Файл не найден", 404)
    return send_from_directory(
        folder,
        stored_name,
        mimetype=attachment.mime if attachment and attachment.mime else None,
        as_attachment=False,
        max_age=3600,
    )
