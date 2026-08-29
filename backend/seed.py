"""Наполнение базы: команды, пользователи, секции, задания, тест, credentials.txt."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from flask import current_app

from .db import db
from .models import (
    ROLE_ADMIN,
    ROLE_LEADER,
    ROLE_MEMBER,
    Question,
    Quiz,
    STATE_KEYS,
    Section,
    StateVersion,
    Task,
    Team,
    User,
    bump,
)
from .team_names import generate_team_names


def leader_login(team_no: int) -> str:
    return f"t{team_no:02d}-leader"


def member_login(team_no: int, index: int) -> str:
    return f"t{team_no:02d}-p{index}"


def admin_login(index: int) -> str:
    return f"admin{index:02d}"


# --------------------------------------------------------------------------- #
# Команды и пользователи
# --------------------------------------------------------------------------- #
def seed_teams_and_users() -> None:
    cfg = current_app.config
    teams_count = cfg["TEAMS_COUNT"]
    team_size = cfg["TEAM_SIZE"]
    names = generate_team_names(teams_count)

    for number in range(1, teams_count + 1):
        team = db.session.query(Team).filter_by(number=number).one_or_none()
        if team is None:
            team = Team(number=number, name=names[number - 1])
            db.session.add(team)
            db.session.flush()

        login = leader_login(number)
        if db.session.query(User).filter_by(login=login).one_or_none() is None:
            db.session.add(User(
                login=login,
                display_name=f"Leader {number:02d}",
                role=ROLE_LEADER,
                team_id=team.id,
            ))

        for index in range(1, team_size):
            login = member_login(number, index)
            if db.session.query(User).filter_by(login=login).one_or_none() is None:
                db.session.add(User(
                    login=login,
                    display_name=f"Member {number:02d}-{index}",
                    role=ROLE_MEMBER,
                    team_id=team.id,
                ))

    for index in range(1, cfg["ADMINS_COUNT"] + 1):
        login = admin_login(index)
        if db.session.query(User).filter_by(login=login).one_or_none() is None:
            db.session.add(User(
                login=login,
                display_name=f"Administrator {index:02d}",
                role=ROLE_ADMIN,
                team_id=None,
            ))

    db.session.commit()


# --------------------------------------------------------------------------- #
# Секции, задания, тест
# --------------------------------------------------------------------------- #
def _load_json(name: str) -> dict:
    path: Path = current_app.config["CONTENT_DIR"] / name
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def seed_sections_and_tasks() -> None:
    data = _load_json("sections.json")

    for order, item in enumerate(data.get("sections", []), start=1):
        if db.session.query(Section).filter_by(code=item["code"]).one_or_none():
            continue
        db.session.add(Section(
            code=item["code"],
            icon=item.get("icon", "🔬"),
            order=order,
            name_kk=item["name_kk"], name_ru=item["name_ru"], name_en=item["name_en"],
            desc_kk=item.get("desc_kk", ""), desc_ru=item.get("desc_ru", ""),
            desc_en=item.get("desc_en", ""),
        ))

    if db.session.query(Task).count() == 0:
        for item in data.get("starter_tasks", []):
            db.session.add(Task(
                order=item.get("order", 0),
                max_points=item.get("max_points", 10),
                title_kk=item["title_kk"], title_ru=item["title_ru"], title_en=item["title_en"],
                body_kk=item["body_kk"], body_ru=item["body_ru"], body_en=item["body_en"],
                is_published=True,
            ))

    db.session.commit()


def seed_quiz() -> None:
    if db.session.query(Quiz).count() > 0:
        return

    data = _load_json("quiz_questions.json")
    quiz = Quiz(
        title_kk=data.get("title_kk", ""),
        title_ru=data.get("title_ru", ""),
        title_en=data.get("title_en", ""),
        is_open=False,
        show_results=True,
    )
    db.session.add(quiz)
    db.session.flush()

    for order, item in enumerate(data.get("questions", []), start=1):
        db.session.add(Question(
            quiz_id=quiz.id,
            order=order,
            points=item.get("points", 2),
            correct_index=item.get("correct_index", 0),
            text_kk=item["text_kk"], text_ru=item["text_ru"], text_en=item["text_en"],
            options_kk=json.dumps(item["options_kk"], ensure_ascii=False),
            options_ru=json.dumps(item["options_ru"], ensure_ascii=False),
            options_en=json.dumps(item["options_en"], ensure_ascii=False),
        ))

    db.session.commit()


def seed_state_versions() -> None:
    for key in STATE_KEYS:
        if db.session.get(StateVersion, key) is None:
            db.session.add(StateVersion(key=key, version=1))
    db.session.commit()


# --------------------------------------------------------------------------- #
# Файл с логинами и паролями
# --------------------------------------------------------------------------- #
def write_credentials_file() -> Path:
    cfg = current_app.config
    path: Path = cfg["CREDENTIALS_DIR"] / "credentials.txt"
    participant_pwd = cfg["PARTICIPANT_PASSWORD"]
    admin_pwd = cfg["ADMIN_PASSWORD"]

    teams = db.session.query(Team).order_by(Team.number).all()
    admins = db.session.query(User).filter_by(role=ROLE_ADMIN).order_by(User.login).all()
    total_participants = sum(len(t.users) for t in teams)

    lines: list[str] = []
    add = lines.append

    add("=" * 78)
    add("TIGER MASTERCLASS - ЛОГИНЫ И ПАРОЛИ / ЛОГИН МЕН ПАРОЛЬДЕР / LOGINS & PASSWORDS")
    add("=" * 78)
    add(f"Сгенерировано: {datetime.now():%d.%m.%Y %H:%M}")
    add(f"Команд: {len(teams)}   Участников: {total_participants}   Администраторов: {len(admins)}")
    add("")
    add(f"ПАРОЛЬ УЧАСТНИКОВ И ЛИДЕРОВ (единый):  {participant_pwd}")
    add(f"ПАРОЛЬ АДМИНИСТРАТОРОВ (единый):       {admin_pwd}")
    add("")
    add("Роль определяется автоматически по логину. Логины можно изменить")
    add("в панели администратора: вкладка «Команды» -> «Изменить логин».")
    add("")
    add("-" * 78)
    add("АДМИНИСТРАТОРЫ / ӘКІМШІЛЕР / ADMINISTRATORS")
    add("-" * 78)
    add(f"{'ЛОГИН':<18}{'ПАРОЛЬ':<22}РОЛЬ")
    for admin in admins:
        add(f"{admin.login:<18}{admin_pwd:<22}Администратор / Admin")
    add("")

    add("-" * 78)
    add("КОМАНДЫ / КОМАНДАЛАР / TEAMS")
    add("-" * 78)
    for team in teams:
        add("")
        add(f"КОМАНДА #{team.number:02d} — {team.name}")
        add(f"  {'ЛОГИН':<18}{'ПАРОЛЬ':<22}РОЛЬ")
        leader = team.leader
        if leader:
            add(f"  {leader.login:<18}{participant_pwd:<22}ЛИДЕР / КОМАНДА БАСШЫСЫ / LEADER")
        for member in sorted(team.members, key=lambda u: u.login):
            add(f"  {member.login:<18}{participant_pwd:<22}Участник / Қатысушы / Member")

    add("")
    add("=" * 78)
    add("ПАМЯТКА")
    add("=" * 78)
    add("1. Лидер команды — единственный, кто отправляет итоговый ответ и файлы (до 15 МБ).")
    add("2. Тест: 15 вопросов, отвечает только лидер, участники видят вопросы и варианты.")
    add("3. Голосование за секции доступно и лидерам, и участникам (1 голос, можно изменить).")
    add("4. Рейтинг обновляется автоматически; команды без отправок в рейтинге не показываются.")
    add("5. Адрес сайта в локальной сети: http://<IP-компьютера>:5000")
    add("")

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def seed_all(write_credentials: bool = True) -> Path | None:
    seed_teams_and_users()
    seed_sections_and_tasks()
    seed_quiz()
    seed_state_versions()
    bump(*STATE_KEYS)
    db.session.commit()
    return write_credentials_file() if write_credentials else None
