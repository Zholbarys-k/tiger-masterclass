"""Создание базы, команд, аккаунтов и файла credentials.txt.

Запуск: python scripts/init_db.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import create_app                      # noqa: E402
from backend.db import db                           # noqa: E402
from backend.models import ROLE_ADMIN, ROLE_LEADER, ROLE_MEMBER, Team, User  # noqa: E402
from backend.seed import seed_all                   # noqa: E402


def main() -> None:
    app = create_app()
    with app.app_context():
        db.create_all()
        credentials_path = seed_all(write_credentials=True)

        teams = db.session.query(Team).count()
        leaders = db.session.query(User).filter_by(role=ROLE_LEADER).count()
        members = db.session.query(User).filter_by(role=ROLE_MEMBER).count()
        admins = db.session.query(User).filter_by(role=ROLE_ADMIN).count()

    print("=" * 58)
    print("  База данных TIGER MasterClass готова")
    print("=" * 58)
    print(f"  Команд:         {teams}")
    print(f"  Лидеров:        {leaders}")
    print(f"  Участников:     {members}")
    print(f"  Всего в командах: {leaders + members}")
    print(f"  Администраторов: {admins}")
    print(f"  Логины/пароли:  {credentials_path}")
    print("=" * 58)
    print("  Дальше: python run.py")


if __name__ == "__main__":
    main()
