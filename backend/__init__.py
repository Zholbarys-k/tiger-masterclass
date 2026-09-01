"""Фабрика приложения TIGER MasterClass."""
from __future__ import annotations

from flask import Flask, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

import config as app_config

from .db import db


def create_app(config_object: type = app_config.Config) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(app_config.FRONTEND_DIR),
        static_url_path="/static",
    )
    app.config.from_object(config_object)
    app.config.update(
        BASE_DIR=app_config.BASE_DIR,
        DATA_DIR=app_config.DATA_DIR,
        UPLOAD_DIR=app_config.UPLOAD_DIR,
        CONTENT_DIR=app_config.CONTENT_DIR,
        FRONTEND_DIR=app_config.FRONTEND_DIR,
        CREDENTIALS_DIR=app_config.CREDENTIALS_DIR,
    )

    # Корректные схема и IP клиента, когда приложение работает за nginx/Apache.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)

    from .routes.auth_routes import bp as auth_bp
    from .routes.admin_routes import bp as admin_bp
    from .routes.task_routes import bp as task_bp
    from .routes.vote_routes import bp as vote_bp
    from .routes.quiz_routes import bp as quiz_bp
    from .routes.leaderboard_routes import bp as leaderboard_bp
    from .routes.message_routes import bp as message_bp

    for blueprint in (auth_bp, admin_bp, task_bp, vote_bp, quiz_bp, leaderboard_bp, message_bp):
        app.register_blueprint(blueprint)

    _register_frontend(app)
    _register_errors(app)

    with app.app_context():
        db.create_all()
        _ensure_schema(app)
        _ensure_task_rounds(app)
        if app.config.get("AUTO_SEED", True):
            _seed_if_empty(app)

    return app


# Столбцы, добавленные после первых запусков: досоздаём их без потери данных,
# чтобы не пересоздавать базу с логинами участников.
NEW_COLUMNS: dict[str, dict[str, str]] = {
    "quizzes": {
        "phase": "VARCHAR(16) NOT NULL DEFAULT 'idle'",
        "current_index": "INTEGER NOT NULL DEFAULT 0",
        "phase_started_at": "DATETIME",
        "phase_ends_at": "DATETIME",
        "question_seconds": "INTEGER NOT NULL DEFAULT 60",
        "standings_seconds": "INTEGER NOT NULL DEFAULT 20",
        "auto_advance": "BOOLEAN NOT NULL DEFAULT 1",
        "is_paused": "BOOLEAN NOT NULL DEFAULT 0",
        "paused_remaining": "INTEGER NOT NULL DEFAULT 0",
    },
    "users": {
        "school": "VARCHAR(120) NOT NULL DEFAULT ''",
        "grade": "VARCHAR(40) NOT NULL DEFAULT ''",
        "about": "VARCHAR(400) NOT NULL DEFAULT ''",
    },
    "task_rounds": {
        "task_id": "INTEGER",
    },
    "project_votes": {
        "task_id": "INTEGER",
    },
}


def _ensure_schema(app: Flask) -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    tables = set(inspector.get_table_names())
    for table, columns in NEW_COLUMNS.items():
        if table not in tables:
            continue
        existing = {column["name"] for column in inspector.get_columns(table)}
        for name, ddl in columns.items():
            if name in existing:
                continue
            try:
                db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                db.session.commit()
                app.logger.info("Схема обновлена: %s.%s", table, name)
            except Exception as error:  # pragma: no cover
                db.session.rollback()
                app.logger.error("Не удалось добавить %s.%s: %s", table, name, error)
    _rebuild_project_votes(app)


def _rebuild_project_votes(app: Flask) -> None:
    """Один лайк на задание: пересоздать уникальность user_id+task_id."""
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    if "project_votes" not in inspector.get_table_names():
        return
    uniques = inspector.get_unique_constraints("project_votes")
    names = {item.get("name") for item in uniques}
    cols = [item.get("column_names") or [] for item in uniques]
    if any(set(columns) == {"user_id", "task_id"} for columns in cols):
        return
    if "uq_project_vote_user_task" in names:
        return
    try:
        db.session.execute(text("DROP TABLE IF EXISTS project_votes"))
        db.session.commit()
        from .models import ProjectVote

        ProjectVote.__table__.create(db.engine)
        app.logger.info("Таблица project_votes обновлена: лайк на каждое задание")
    except Exception as error:  # pragma: no cover
        db.session.rollback()
        app.logger.error("Не удалось обновить project_votes: %s", error)


def _ensure_task_rounds(app: Flask) -> None:
    try:
        from .task3_engine import ensure_rounds

        ensure_rounds()
    except Exception as error:  # pragma: no cover
        app.logger.error("Не удалось создать пульты заданий: %s", error)


def _seed_if_empty(app: Flask) -> None:
    """При первом запуске (в т.ч. на хостинге) создать команды и аккаунты."""
    from .models import User
    from .seed import seed_all

    if db.session.query(User).count() > 0:
        return
    try:
        seed_all(write_credentials=True)
        app.logger.info("База наполнена: команды, аккаунты, задания, тест, секции.")
    except Exception as error:  # pragma: no cover
        db.session.rollback()
        app.logger.error("Не удалось наполнить базу: %s", error)


def _register_frontend(app: Flask) -> None:
    frontend_dir = str(app_config.FRONTEND_DIR)

    @app.route("/")
    def index():
        return send_from_directory(frontend_dir, "index.html")

    @app.route("/app")
    def workspace():
        return send_from_directory(frontend_dir, "app.html")

    @app.route("/admin")
    def admin_page():
        return send_from_directory(frontend_dir, "admin.html")

    @app.route("/<path:filename>")
    def frontend_files(filename: str):
        """Отдача css/js/i18n/assets по прямым путям."""
        if filename.startswith("api/"):
            return jsonify({"ok": False, "error": "not_found", "message": "Нет такого API"}), 404
        return send_from_directory(frontend_dir, filename)


def _register_errors(app: Flask) -> None:
    @app.errorhandler(413)
    def too_large(_error):
        limit = app.config["MAX_FILE_SIZE"] // (1024 * 1024)
        return jsonify({
            "ok": False,
            "error": "file_too_large",
            "message": f"Файл превышает лимит {limit} МБ",
        }), 413

    @app.errorhandler(404)
    def not_found(error):
        from flask import request

        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "not_found", "message": "Ресурс не найден"}), 404
        return error, 404

    @app.errorhandler(500)
    def server_error(error):  # pragma: no cover
        app.logger.exception("Internal error: %s", error)
        return jsonify({
            "ok": False, "error": "server_error", "message": "Внутренняя ошибка сервера",
        }), 500
