"""Экспорт логинов и паролей из базы в три текстовых файла.

Берёт АКТУАЛЬНЫЕ логины из БД, поэтому запускать можно и после того,
как администратор поменял логины в панели.

Запуск: python scripts/export_credentials.py
Результат в папке credentials/:
    credentials.txt   — полный список (участники по командам + администраторы)
    credentials.csv   — таблица для Excel / Google Sheets
    team_cards.txt    — карточки команд для распечатки и раздачи
"""
from __future__ import annotations

import csv
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import create_app                              # noqa: E402
from backend.db import db                                   # noqa: E402
from backend.models import ROLE_ADMIN, Team, User           # noqa: E402
from backend.seed import write_credentials_file             # noqa: E402


def export_csv(path: Path, teams: list[Team], admins: list[User],
               participant_pwd: str, admin_pwd: str) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, delimiter=";")
        writer.writerow(["Команда №", "Название команды", "Логин", "Пароль", "Роль"])
        for admin in admins:
            writer.writerow(["", "—", admin.login, admin_pwd, "Администратор"])
        for team in teams:
            leader = team.leader
            if leader:
                writer.writerow([f"{team.number:02d}", team.name, leader.login,
                                 participant_pwd, "Лидер"])
            for member in sorted(team.members, key=lambda u: u.login):
                writer.writerow([f"{team.number:02d}", team.name, member.login,
                                 participant_pwd, "Участник"])


def export_team_cards(path: Path, teams: list[Team], participant_pwd: str) -> None:
    """Карточки команд: распечатать, разрезать и раздать каждой команде."""
    lines: list[str] = []
    for team in teams:
        leader = team.leader
        members = sorted(team.members, key=lambda u: u.login)
        lines.append("+" + "-" * 56 + "+")
        lines.append(f"|  TIGER MASTERCLASS   ·   КОМАНДА #{team.number:02d}".ljust(57) + "|")
        lines.append(f"|  {team.name}".ljust(57) + "|")
        lines.append("|" + " " * 56 + "|")
        lines.append(f"|  Пароль для всех: {participant_pwd}".ljust(57) + "|")
        lines.append("|" + " " * 56 + "|")
        if leader:
            lines.append(f"|  ЛИДЕР (отправляет ответы):  {leader.login}".ljust(57) + "|")
        for index, member in enumerate(members, start=1):
            lines.append(f"|  Участник {index}:                 {member.login}".ljust(57) + "|")
        lines.append("|" + " " * 56 + "|")
        lines.append("|  Сайт: http://<IP>:5000".ljust(57) + "|")
        lines.append("+" + "-" * 56 + "+")
        lines.append("")

    header = [
        "КАРТОЧКИ КОМАНД ДЛЯ РАСПЕЧАТКИ",
        f"Сгенерировано: {datetime.now():%d.%m.%Y %H:%M}",
        "Распечатайте, разрежьте по рамкам и выдайте каждой команде свою карточку.",
        "",
    ]
    path.write_text("\n".join(header + lines), encoding="utf-8")


def main() -> None:
    app = create_app()
    with app.app_context():
        folder: Path = app.config["CREDENTIALS_DIR"]
        participant_pwd = app.config["PARTICIPANT_PASSWORD"]
        admin_pwd = app.config["ADMIN_PASSWORD"]

        teams = db.session.query(Team).order_by(Team.number).all()
        admins = db.session.query(User).filter_by(role=ROLE_ADMIN).order_by(User.login).all()
        if not teams:
            print("База пуста. Сначала выполните: python scripts/init_db.py")
            return

        txt_path = write_credentials_file()
        csv_path = folder / "credentials.csv"
        cards_path = folder / "team_cards.txt"
        export_csv(csv_path, teams, admins, participant_pwd, admin_pwd)
        export_team_cards(cards_path, teams, participant_pwd)

        total = sum(len(team.users) for team in teams)

    print("=" * 62)
    print("  Логины и пароли экспортированы")
    print("=" * 62)
    print(f"  Участников: {total}   Администраторов: {len(admins)}")
    print(f"  Полный список:      {txt_path}")
    print(f"  Таблица для Excel:  {csv_path}")
    print(f"  Карточки на печать: {cards_path}")
    print("=" * 62)


if __name__ == "__main__":
    main()
