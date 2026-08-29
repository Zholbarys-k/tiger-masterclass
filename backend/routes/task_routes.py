"""Задания, отправка ответов лидером, файлы."""
from __future__ import annotations

from flask import Blueprint, current_app, g, request, send_from_directory

from ..auth import require_auth, require_role
from ..db import db
from ..models import (
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
    lang = current_lang()
    query = db.session.query(Task)
    if g.user.role != ROLE_ADMIN:
        query = query.filter_by(is_published=True)
    tasks = query.order_by(Task.order, Task.id).all()

    my_subs: dict[int, dict] = {}
    if g.user.team_id:
        rows = db.session.query(Submission).filter_by(team_id=g.user.team_id).all()
        my_subs = {row.task_id: row.to_dict(lang) for row in rows}

    payload = []
    for task in tasks:
        item = task.to_dict(lang)
        item["my_submission"] = my_subs.get(task.id)
        payload.append(item)

    return json_ok(tasks=payload, can_submit=g.user.role == ROLE_LEADER)


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

    text = (request.form.get("text") or "").strip()
    files = [f for f in request.files.getlist("files") if f and f.filename]

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
        return json_err("forbidden", "Нет доступа к этому файлу", 403)

    folder = current_app.config["UPLOAD_DIR"] / str(submission_id)
    return send_from_directory(folder, stored_name)
