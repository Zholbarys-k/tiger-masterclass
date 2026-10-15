"""Пересоздать команды и участников по настройкам config.py (TEAMS_COUNT, TEAM_SIZE).

Что удаляется: команды, все участники и лидеры, их ответы на задания (и файлы),
ответы теста, выбор карточек кабинетов, лайки, чаты, ручные правки баллов.
Что остаётся: администраторы, задания, вопросы теста, секции, раунды заданий.

Запуск (сервер лучше остановить): python scripts/rebuild_teams.py [--yes]
Затем:                              python scripts/export_credentials.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config                                                   # noqa: E402
from backend import create_app                                  # noqa: E402
from backend.db import db                                       # noqa: E402
from backend.models import (                                    # noqa: E402
    ROLE_ADMIN,
    Attachment,
    AuthToken,
    Message,
    ProjectVote,
    QuizAnswer,
    ScoreAdjustment,
    Submission,
    Team,
    TeamMessage,
    User,
    RoomCard,
    bump,
    STATE_KEYS,
)
from backend.seed import seed_teams_and_users, write_credentials_file  # noqa: E402


def main() -> None:
    if "--yes" not in sys.argv:
        answer = input(
            "Удалить текущих участников, команды и их ответы и создать заново? [y/N]: "
        ).strip().lower()
        if answer not in ("y", "yes", "д", "да"):
            print("Отменено.")
            return

    app = create_app()
    with app.app_context():
        # Уникальность ответа теста теперь «вопрос + пользователь»: пересоздаём таблицу.
        QuizAnswer.__table__.drop(db.engine, checkfirst=True)

        participant_ids = [u.id for u in db.session.query(User).filter(User.role != ROLE_ADMIN)]
        db.session.query(Attachment).delete()
        db.session.query(ProjectVote).delete()
        db.session.query(Submission).delete()
        db.session.query(RoomCard).update({
            "team_id": None, "picked_by_id": None, "picked_at": None,
        })
        db.session.query(ScoreAdjustment).delete()
        db.session.query(TeamMessage).delete()
        db.session.query(Message).delete()
        if participant_ids:
            db.session.query(AuthToken).filter(AuthToken.user_id.in_(participant_ids)).delete(
                synchronize_session=False)
        db.session.query(User).filter(User.role != ROLE_ADMIN).delete(synchronize_session=False)
        db.session.query(Team).delete()
        db.session.commit()

        db.create_all()
        seed_teams_and_users()
        bump(*STATE_KEYS)
        db.session.commit()
        write_credentials_file()

        teams = db.session.query(Team).count()
        users = db.session.query(User).filter(User.role != ROLE_ADMIN).count()

    # Файлы ответов на задания (фото заданий и вопросов в uploads/media остаются).
    for item in config.UPLOAD_DIR.iterdir():
        if item.is_dir() and item.name != "media":
            shutil.rmtree(item, ignore_errors=True)

    print(f"Готово: команд {teams}, участников {users}.")


if __name__ == "__main__":
    main()
