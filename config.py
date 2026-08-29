"""Конфигурация приложения TIGER MasterClass."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = BASE_DIR / "uploads"
CONTENT_DIR = BASE_DIR / "content"
FRONTEND_DIR = BASE_DIR / "frontend"
CREDENTIALS_DIR = BASE_DIR / "credentials"

for _d in (DATA_DIR, UPLOAD_DIR, CREDENTIALS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


class Config:
    # --- Flask ---
    SECRET_KEY = os.environ.get("TIGER_SECRET_KEY", "tiger-masterclass-2026-secret")
    JSON_AS_ASCII = False

    # --- База данных ---
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "TIGER_DATABASE_URI", f"sqlite:///{(DATA_DIR / 'tiger.db').as_posix()}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # --- Пароли мероприятия ---
    PARTICIPANT_PASSWORD = os.environ.get("TIGER_PARTICIPANT_PASSWORD", "BEKTUROV2026")
    ADMIN_PASSWORD = os.environ.get("TIGER_ADMIN_PASSWORD", "TIGERADMIN2026")

    # --- Состав мероприятия ---
    TEAMS_COUNT = 40           # 40 команд × 5 человек = 200 участников
    TEAM_SIZE = 5              # 1 лидер + 4 участника
    ADMINS_COUNT = 10

    # --- Токены ---
    TOKEN_TTL_HOURS = 24

    # Автоматически создать команды и аккаунты при первом запуске
    # (нужно на хостинге, где нельзя запустить scripts/init_db.py).
    AUTO_SEED = os.environ.get("TIGER_AUTO_SEED", "1") != "0"

    # --- Загрузка файлов ---
    MAX_FILE_SIZE = 15 * 1024 * 1024          # 15 МБ на файл
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024     # запас на multipart-обвязку
    MAX_FILES_PER_SUBMISSION = 5
    ALLOWED_IMAGE_EXT = {"jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"}
    ALLOWED_VIDEO_EXT = {"mp4", "mov", "webm", "avi", "mkv", "m4v", "3gp"}

    # --- Сервер ---
    HOST = os.environ.get("TIGER_HOST", "0.0.0.0")
    PORT = int(os.environ.get("TIGER_PORT", "5000"))

    # --- Языки ---
    LANGUAGES = ("kk", "ru", "en")
    DEFAULT_LANGUAGE = "ru"


ALLOWED_EXT = Config.ALLOWED_IMAGE_EXT | Config.ALLOWED_VIDEO_EXT
