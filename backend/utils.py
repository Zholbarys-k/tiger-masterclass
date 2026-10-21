"""Вспомогательные функции: ответы API, язык, работа с файлами."""
from __future__ import annotations

import uuid
from pathlib import Path

from flask import current_app, jsonify, request
from werkzeug.datastructures import FileStorage

LANGUAGES = ("kk", "ru", "en")


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


def validate_file(storage: FileStorage, max_size: int | None = None) -> tuple[bool, str]:
    """Проверить MIME-тип, расширение и размер файла.

    max_size=None — берётся MAX_FILE_SIZE из конфига; 0 — без ограничения.
    """
    cfg = current_app.config
    name = storage.filename or ""
    if not name:
        return False, "Файл без имени"

    mime = (storage.mimetype or "").lower()
    ext = file_ext(name)
    allowed_ext = cfg["ALLOWED_IMAGE_EXT"] | cfg["ALLOWED_VIDEO_EXT"]

    is_media_mime = mime.startswith("image/") or mime.startswith("video/")
    if not is_media_mime and ext not in allowed_ext:
        return False, "Разрешены только изображения и видео"
    if ext and ext not in allowed_ext:
        return False, f"Формат .{ext} не поддерживается"

    storage.stream.seek(0, 2)
    size = storage.stream.tell()
    storage.stream.seek(0)
    if size <= 0:
        return False, "Пустой файл"
    limit = cfg["MAX_FILE_SIZE"] if max_size is None else max_size
    if limit and size > limit:
        return False, f"Файл больше {limit // (1024 * 1024)} МБ"
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


MEDIA_FOLDER = "media"


def validate_image(storage: FileStorage) -> tuple[bool, str]:
    """Проверить, что файл — изображение до 15 МБ (для фото к заданиям и вопросам)."""
    valid, message = validate_file(storage, current_app.config["MAX_IMAGE_SIZE"])
    if not valid:
        return valid, message
    mime = (storage.mimetype or "").lower()
    ext = file_ext(storage.filename)
    if not mime.startswith("image/") and ext not in current_app.config["ALLOWED_IMAGE_EXT"]:
        return False, "Можно загрузить только изображение"
    if ext and ext not in current_app.config["ALLOWED_IMAGE_EXT"]:
        return False, "Можно загрузить только изображение"
    return True, ""


def save_media(storage: FileStorage) -> str:
    """Сохранить картинку в uploads/media/<uuid>.<ext> и вернуть имя файла."""
    folder: Path = current_app.config["UPLOAD_DIR"] / MEDIA_FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    ext = file_ext(storage.filename)
    stored_name = f"{uuid.uuid4().hex}{('.' + ext) if ext else ''}"
    storage.stream.seek(0)
    storage.save(folder / stored_name)
    return stored_name


def remove_media(stored_name: str | None) -> None:
    if not stored_name:
        return
    path: Path = current_app.config["UPLOAD_DIR"] / MEDIA_FOLDER / Path(stored_name).name
    path.unlink(missing_ok=True)


def localized_payload(prefix: str, source: dict) -> dict:
    """Собрать поля prefix_kk/ru/en из входного JSON, дополняя пустые языки."""
    values = {code: (source.get(f"{prefix}_{code}") or "").strip() for code in LANGUAGES}
    fallback = values["ru"] or values["en"] or values["kk"] or ""
    return {f"{prefix}_{code}": (values[code] or fallback) for code in LANGUAGES}
