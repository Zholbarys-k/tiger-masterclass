"""Вспомогательные функции: ответы API, язык, работа с файлами."""
from __future__ import annotations

import uuid
from pathlib import Path

from flask import current_app, jsonify, request
from werkzeug.datastructures import FileStorage
from werkzeug.exceptions import BadRequest

LANGUAGES = ("kk", "ru", "en")


def json_object() -> dict:
    """Прочитать JSON-объект и проверить типы полей до изменения данных."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise BadRequest("Ожидается JSON-объект")
    text_fields = {
        "login", "password", "display_name", "school", "grade", "about",
        "name", "reason", "body", "action", "role",
    }
    integer_fields = {
        "section_id", "submission_id", "question_id", "selected_index",
        "team_id", "task_id", "index", "seconds", "question_seconds",
        "standings_seconds", "order", "max_points", "points", "delta", "set_total",
        "duration_seconds", "voting_seconds",
    }
    boolean_fields = {
        "is_active", "allow_files", "is_published", "is_open", "show_results",
        "auto_advance", "reset_answers", "clear_answers", "clear_likes",
    }
    for key, value in data.items():
        if key in boolean_fields and not isinstance(value, bool):
            raise BadRequest("Логическое поле должно содержать true или false")
        if key in text_fields or key.endswith(("_kk", "_ru", "_en")):
            if value is not None and not isinstance(value, str):
                raise BadRequest("Текстовое поле должно содержать строку")
        if key in integer_fields and value not in (None, ""):
            try:
                if isinstance(value, (bool, float, list, dict)):
                    raise ValueError
                int(value)
            except (TypeError, ValueError, OverflowError):
                raise BadRequest("Числовое поле должно содержать целое число") from None
    return data


def json_ok(**payload):
    data = {"ok": True}
    data.update(payload)
    return jsonify(data)


def json_err(code: str, message: str, status: int = 400):
    return jsonify({"ok": False, "error": code, "message": message}), status


def current_lang() -> str:
    lang = (request.args.get("lang") or request.headers.get("X-Lang") or "").lower()
    if lang in LANGUAGES:
        return lang
    return current_app.config.get("DEFAULT_LANGUAGE", "ru")


def as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def file_ext(filename: str) -> str:
    return Path(filename or "").suffix.lower().lstrip(".")


def validate_file(storage: FileStorage) -> tuple[bool, str]:
    """Проверить MIME-тип, расширение и размер файла (до 15 МБ)."""
    cfg = current_app.config
    name = storage.filename or ""
    if not name:
        return False, "Файл без имени"

    mime = (storage.mimetype or "").lower()
    ext = file_ext(name)
    allowed_ext = cfg["ALLOWED_IMAGE_EXT"] | cfg["ALLOWED_VIDEO_EXT"]

    is_media_mime = mime.startswith("image/") or mime.startswith("video/")
    if not is_media_mime:
        return False, "Разрешены только изображения и видео"
    if ext and ext not in allowed_ext:
        return False, f"Формат .{ext} не поддерживается"

    storage.stream.seek(0, 2)
    size = storage.stream.tell()
    storage.stream.seek(0)
    if size <= 0:
        return False, "Пустой файл"
    if size > cfg["MAX_FILE_SIZE"]:
        limit_mb = cfg["MAX_FILE_SIZE"] // (1024 * 1024)
        return False, f"Файл больше {limit_mb} МБ"
    return True, ""


def save_upload(storage: FileStorage, submission_id: int) -> dict:
    """Сохранить файл в uploads/<submission_id>/<uuid>.<ext> и вернуть метаданные."""
    upload_root: Path = current_app.config["UPLOAD_DIR"]
    folder = upload_root / str(submission_id)
    folder.mkdir(parents=True, exist_ok=True)

    ext = file_ext(storage.filename)
    stored_name = f"{uuid.uuid4().hex}{('.' + ext) if ext else ''}"
    target = folder / stored_name

    storage.stream.seek(0)
    storage.save(target)

    return {
        "stored_name": stored_name,
        "original_name": (storage.filename or "")[:255],
        "mime": (storage.mimetype or "")[:80],
        "size_bytes": target.stat().st_size,
    }


def localized_payload(prefix: str, source: dict) -> dict:
    """Собрать поля prefix_kk/ru/en из входного JSON, дополняя пустые языки."""
    values = {code: (source.get(f"{prefix}_{code}") or "").strip() for code in LANGUAGES}
    fallback = values["ru"] or values["en"] or values["kk"] or ""
    return {f"{prefix}_{code}": (values[code] or fallback) for code in LANGUAGES}
