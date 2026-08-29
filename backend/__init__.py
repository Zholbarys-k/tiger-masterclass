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

    for blueprint in (auth_bp, admin_bp, task_bp, vote_bp, quiz_bp, leaderboard_bp):
        app.register_blueprint(blueprint)

    _register_frontend(app)
    _register_errors(app)

    with app.app_context():
        db.create_all()
        if app.config.get("AUTO_SEED", True):
            _seed_if_empty(app)

    return app


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
