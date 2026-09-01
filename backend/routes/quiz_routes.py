"""Синхронный тест: один вопрос на всех, минута на ответ, затем рейтинг."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import require_auth, require_role
from ..db import db
from ..models import (
    PHASE_FINISHED,
    PHASE_QUESTION,
    PHASE_STANDINGS,
    ROLE_ADMIN,
    ROLE_LEADER,
    Question,
    QuizAnswer,
    Team,
    bump,
    utcnow,
)
from ..quiz_engine import ensure_progress, get_quiz
from ..utils import as_int, current_lang, json_err, json_ok
from .leaderboard_routes import build_leaderboard

bp = Blueprint("quiz", __name__, url_prefix="/api/quiz")

TOP_SIZE = 10


def team_answers(team_id: int | None) -> dict[int, QuizAnswer]:
    if not team_id:
        return {}
    rows = db.session.query(QuizAnswer).filter_by(team_id=team_id).all()
    return {row.question_id: row for row in rows}


def question_stats(question: Question | None) -> dict | None:
    if question is None:
        return None
    total_teams = db.session.query(Team).filter_by(is_active=True).count()
    return {
        "answered_teams": len(question.answers),
        "correct_teams": sum(1 for a in question.answers if a.is_correct),
        "total_teams": total_teams,
    }


def standings_payload(my_team_id: int | None) -> dict:
    """ТОП-10 плюс строка своей команды, даже если она ниже десятого места."""
    rows = build_leaderboard()
    my_row = next((r for r in rows if r["team_id"] == my_team_id), None)
    return {
        "rows": rows[:TOP_SIZE],
        "my": my_row,
        "total_ranked": len(rows),
        "top_size": TOP_SIZE,
    }


@bp.get("/state")
@require_auth
def quiz_state():
    """Живое состояние теста: текущая фаза, вопрос, таймер, рейтинг."""
    lang = current_lang()
    quiz = get_quiz()
    if quiz is None:
        return json_ok(quiz=None, question=None)

    ensure_progress(quiz)

    is_leader = g.user.role == ROLE_LEADER
    is_admin = g.user.role == ROLE_ADMIN
    answers = team_answers(g.user.team_id)

    question = quiz.current_question if quiz.phase in (PHASE_QUESTION, PHASE_STANDINGS) else None
    show_correct = quiz.phase in (PHASE_STANDINGS, PHASE_FINISHED) or is_admin

    question_payload = None
    if question is not None and (quiz.is_open or is_admin):
        my_answer = answers.get(question.id)
        question_payload = question.to_dict(
            lang, reveal=show_correct and (quiz.show_results or is_admin),
        )
        question_payload["number"] = quiz.current_index + 1
        question_payload["my_answer"] = {
            "selected_index": my_answer.selected_index,
            "is_correct": my_answer.is_correct,
            "points": my_answer.points,
        } if my_answer else None
        question_payload["answered"] = my_answer is not None

    remaining = quiz.remaining_seconds
    can_answer = bool(
        is_leader
        and quiz.is_open
        and quiz.phase == PHASE_QUESTION
        and not quiz.is_paused
        and question is not None
        and question.id not in answers
        and (remaining is None or remaining > 0),
    )

    show_standings = quiz.phase in (PHASE_STANDINGS, PHASE_FINISHED)
    team = g.user.team

    # Пока идёт вопрос, результат текущего ответа не показываем: сначала таймер.
    pending = answers.get(question.id) if (quiz.phase == PHASE_QUESTION and question) else None
    hidden_points = pending.points if pending else 0

    return json_ok(
        quiz=quiz.to_dict(lang),
        question=question_payload,
        can_answer=can_answer,
        read_only=not is_leader,
        my_progress={
            "answered": len(answers),
            "total": len(quiz.questions),
            "correct": sum(1 for a in answers.values() if a.is_correct and a is not pending),
            "points": sum(a.points for a in answers.values()) - hidden_points,
        },
        team={
            "id": team.id,
            "name": team.name,
            "total_points": team.total_points - hidden_points,
        } if team else None,
        standings=standings_payload(g.user.team_id) if (show_standings or is_admin) else None,
        question_stats=question_stats(question) if (show_standings or is_admin) else None,
        server_time=utcnow().isoformat() + "Z",
    )


@bp.post("/answer")
@require_role(ROLE_LEADER)
def answer():
    """Ответ лидера на текущий вопрос. Результат раскрывается после таймера."""
    quiz = get_quiz()
    if quiz is None or not quiz.is_open:
        return json_err("quiz_closed", "Тест закрыт", 400)
    if not g.user.team_id:
        return json_err("no_team", "Пользователь не привязан к команде", 400)

    ensure_progress(quiz)

    if quiz.phase != PHASE_QUESTION:
        return json_err("not_answer_time", "Сейчас не время отвечать", 409)
    if quiz.is_paused:
        return json_err("quiz_paused", "Тест приостановлен администратором", 409)

    # ensure_progress уже закрыл фазу, если время вышло: значит здесь таймер идёт.
    current = quiz.current_question
    if current is None:
        return json_err("question_not_found", "Вопрос не найден", 404)

    data = request.get_json(silent=True) or {}
    question_id = as_int(data.get("question_id"), 0)
    selected_index = as_int(data.get("selected_index"), -1)

    if question_id and question_id != current.id:
        return json_err("stale_question", "Вопрос уже сменился", 409)

    options = current.options(current_lang())
    if selected_index < 0 or selected_index >= max(len(options), 1):
        return json_err("bad_option", "Некорректный вариант ответа", 400)

    existing = (db.session.query(QuizAnswer)
                .filter_by(question_id=current.id, team_id=g.user.team_id).one_or_none())
    if existing is not None:
        return json_err("already_answered", "Команда уже ответила на этот вопрос", 400)

    is_correct = selected_index == current.correct_index
    record = QuizAnswer(
        question_id=current.id,
        team_id=g.user.team_id,
        user_id=g.user.id,
        selected_index=selected_index,
        is_correct=is_correct,
        points=current.points if is_correct else 0,
    )
    db.session.add(record)
    bump("quiz", "leaderboard")
    db.session.commit()

    return json_ok(
        accepted=True,
        selected_index=selected_index,
        remaining_seconds=quiz.remaining_seconds,
        stats=question_stats(current),
    )


@bp.get("/results")
@require_role(ROLE_ADMIN)
def results():
    """Сводка по тесту для администратора."""
    lang = current_lang()
    quiz = get_quiz()
    if quiz is None:
        return json_ok(quiz=None, rows=[])

    ensure_progress(quiz)

    rows = []
    for index, question in enumerate(quiz.questions):
        stats = {
            "question_id": question.id,
            "index": index,
            "order": question.order,
            "text": question.to_dict(lang)["text"],
            "correct_index": question.correct_index,
            "options": question.options(lang),
            "points": question.points,
            "answers_count": len(question.answers),
            "correct_count": sum(1 for a in question.answers if a.is_correct),
            "is_current": index == quiz.current_index and quiz.is_live,
            "distribution": {},
        }
        for answer_row in question.answers:
            key = str(answer_row.selected_index)
            stats["distribution"][key] = stats["distribution"].get(key, 0) + 1
        rows.append(stats)

    return json_ok(quiz=quiz.to_dict(lang), rows=rows)
