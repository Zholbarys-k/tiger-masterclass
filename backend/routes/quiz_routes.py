"""Тест: 15 вопросов появляются одновременно, отвечает только лидер."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import require_auth, require_role
from ..db import db
from ..models import (
    ROLE_ADMIN,
    ROLE_LEADER,
    Question,
    Quiz,
    QuizAnswer,
    bump,
)
from ..utils import as_int, current_lang, json_err, json_ok

bp = Blueprint("quiz", __name__, url_prefix="/api/quiz")


def get_quiz() -> Quiz | None:
    return db.session.query(Quiz).order_by(Quiz.id).first()


def team_answers(team_id: int | None) -> dict[int, QuizAnswer]:
    if not team_id:
        return {}
    rows = db.session.query(QuizAnswer).filter_by(team_id=team_id).all()
    return {row.question_id: row for row in rows}


@bp.get("/state")
@require_auth
def quiz_state():
    """Состояние теста для текущего пользователя."""
    lang = current_lang()
    quiz = get_quiz()
    if quiz is None:
        return json_ok(quiz=None, questions=[])

    is_leader = g.user.role == ROLE_LEADER
    is_admin = g.user.role == ROLE_ADMIN
    answers = team_answers(g.user.team_id)

    questions = []
    if quiz.is_open or is_admin:
        for question in quiz.questions:
            answer = answers.get(question.id)
            # Правильный ответ раскрываем только после ответа лидера (или админу).
            reveal = is_admin or (answer is not None and quiz.show_results)
            item = question.to_dict(lang, reveal=reveal)
            item["my_answer"] = {
                "selected_index": answer.selected_index,
                "is_correct": answer.is_correct,
                "points": answer.points,
            } if answer else None
            item["answered"] = answer is not None
            questions.append(item)

    team = g.user.team
    earned = sum(a.points for a in answers.values())
    correct = sum(1 for a in answers.values() if a.is_correct)

    return json_ok(
        quiz=quiz.to_dict(lang),
        questions=questions,
        can_answer=is_leader and quiz.is_open,
        read_only=not is_leader,
        my_progress={
            "answered": len(answers),
            "total": len(quiz.questions),
            "correct": correct,
            "points": earned,
        },
        team={"id": team.id, "name": team.name, "total_points": team.total_points} if team else None,
    )


@bp.post("/answer")
@require_role(ROLE_LEADER)
def answer():
    """Ответ лидера: сразу возвращаем правильность и баллы команды."""
    quiz = get_quiz()
    if quiz is None or not quiz.is_open:
        return json_err("quiz_closed", "Тест закрыт", 400)
    if not g.user.team_id:
        return json_err("no_team", "Пользователь не привязан к команде", 400)

    data = request.get_json(silent=True) or {}
    question_id = as_int(data.get("question_id"), 0)
    selected_index = as_int(data.get("selected_index"), -1)

    question = db.session.get(Question, question_id)
    if question is None or question.quiz_id != quiz.id:
        return json_err("question_not_found", "Вопрос не найден", 404)

    options = question.options(current_lang())
    if selected_index < 0 or selected_index >= max(len(options), 1):
        return json_err("bad_option", "Некорректный вариант ответа", 400)

    existing = (db.session.query(QuizAnswer)
                .filter_by(question_id=question.id, team_id=g.user.team_id).one_or_none())
    if existing is not None:
        return json_err("already_answered", "Команда уже ответила на этот вопрос", 400)

    is_correct = selected_index == question.correct_index
    record = QuizAnswer(
        question_id=question.id,
        team_id=g.user.team_id,
        user_id=g.user.id,
        selected_index=selected_index,
        is_correct=is_correct,
        points=question.points if is_correct else 0,
    )
    db.session.add(record)
    bump("quiz", "leaderboard")
    db.session.commit()

    answers = team_answers(g.user.team_id)
    team = g.user.team
    return json_ok(
        is_correct=is_correct,
        points=record.points,
        correct_index=question.correct_index if quiz.show_results else None,
        my_progress={
            "answered": len(answers),
            "total": len(quiz.questions),
            "correct": sum(1 for a in answers.values() if a.is_correct),
            "points": sum(a.points for a in answers.values()),
        },
        team_total=team.total_points if team else 0,
    )


@bp.get("/results")
@require_role(ROLE_ADMIN)
def results():
    """Сводка по тесту для администратора."""
    lang = current_lang()
    quiz = get_quiz()
    if quiz is None:
        return json_ok(quiz=None, rows=[])

    rows = []
    for question in quiz.questions:
        stats = {
            "question_id": question.id,
            "order": question.order,
            "text": question.to_dict(lang)["text"],
            "correct_index": question.correct_index,
            "options": question.options(lang),
            "answers_count": len(question.answers),
            "correct_count": sum(1 for a in question.answers if a.is_correct),
            "distribution": {},
        }
        for answer_row in question.answers:
            key = str(answer_row.selected_index)
            stats["distribution"][key] = stats["distribution"].get(key, 0) + 1
        rows.append(stats)

    return json_ok(quiz=quiz.to_dict(lang), rows=rows)
