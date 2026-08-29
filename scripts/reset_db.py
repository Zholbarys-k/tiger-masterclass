"""Полный сброс: удаление БД и загруженных файлов, повторное наполнение.

Запуск: python scripts/reset_db.py [--yes]
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config                                       # noqa: E402
from backend import create_app                      # noqa: E402
from backend.db import db                           # noqa: E402
from backend.seed import seed_all                   # noqa: E402


def main() -> None:
    if "--yes" not in sys.argv:
        answer = input("Удалить ВСЕ данные (база, фото, видео, ответы)? [y/N]: ").strip().lower()
        if answer not in ("y", "yes", "д", "да"):
            print("Отменено.")
            return

    for item in config.UPLOAD_DIR.iterdir():
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        elif item.name != ".gitkeep":
            item.unlink(missing_ok=True)

    db_file = config.DATA_DIR / "tiger.db"
    db_file.unlink(missing_ok=True)

    app = create_app()
    with app.app_context():
        db.create_all()
        credentials_path = seed_all(write_credentials=True)

    print("Данные сброшены и созданы заново.")
    print(f"Логины/пароли: {credentials_path}")


if __name__ == "__main__":
    main()
