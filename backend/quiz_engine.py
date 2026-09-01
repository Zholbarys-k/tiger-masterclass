"""Движок синхронного теста.

Один вопрос показывается всем одновременно. Когда время вышло — фаза меняется
на рейтинг команд, затем автоматически (или по команде админа) идёт следующий
вопрос. Планировщик не нужен: фазы пересчитываются по метке времени при любом
обращении к API, а переход выполняется условным UPDATE — поэтому даже сотни
одновременных запросов не смогут перескочить вопрос дважды.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import update

from .db import db
from .models import (
    PHASE_FINISHED,
    PHASE_IDLE,
    PHASE_QUESTION,
    PHASE_STANDINGS,
    Quiz,
    QuizAnswer,
    bump,
    utcnow,
)

# Если сервер долго никто не опрашивал, не «пролистываем» вопросы пачкой,
# а стартуем следующую фазу от текущего момента.
DRIFT_TOLERANCE_SECONDS = 5
MIN_SECONDS = 5
MAX_SECONDS = 900


def get_quiz() -> Quiz | None:
    return db.session.query(Quiz).order_by(Quiz.id).first()


def clamp_seconds(value: int, fallback: int) -> int:
    if value < MIN_SECONDS or value > MAX_SECONDS:
        return fallback
    return value


# --------------------------------------------------------------------------- #
# Автоматический ход теста
# --------------------------------------------------------------------------- #
def ensure_progress(quiz: Quiz | None) -> bool:
    """Догнать расписание теста: закрыть просроченные фазы. True — были изменения."""
    if quiz is None or not quiz.is_live or quiz.is_paused or quiz.phase_ends_at is None:
        return False

    changed = False
    for _ in range(len(quiz.questions) * 2 + 4):
        if not quiz.is_live or quiz.is_paused or quiz.phase_ends_at is None:
            break
        now = utcnow()
        if now < quiz.phase_ends_at:
            break

        # Точка отсчёта следующей фазы: конец предыдущей, если отставание мало.
        late = (now - quiz.phase_ends_at).total_seconds()
        start = quiz.phase_ends_at if late <= DRIFT_TOLERANCE_SECONDS else now

        if quiz.phase == PHASE_QUESTION:
            values = _standings_values(quiz, start)
        elif quiz.auto_advance:
            values = _next_values(quiz, start)
        else:
            break  # рейтинг висит до команды администратора

        if _transition(quiz, quiz.phase, quiz.current_index, values):
            changed = True
        else:
            db.session.refresh(quiz)  # другой запрос уже перевёл фазу

    return changed


def _standings_values(quiz: Quiz, start) -> dict:
    return {
        "phase": PHASE_STANDINGS,
        "phase_started_at": start,
        "phase_ends_at": start + timedelta(seconds=quiz.standings_seconds),
        "is_paused": False,
        "paused_remaining": 0,
    }


def _question_values(quiz: Quiz, index: int, start) -> dict:
    return {
        "phase": PHASE_QUESTION,
        "current_index": index,
        "phase_started_at": start,
        "phase_ends_at": start + timedelta(seconds=quiz.question_seconds),
        "is_paused": False,
        "paused_remaining": 0,
    }


def _finished_values(start) -> dict:
    return {
        "phase": PHASE_FINISHED,
        "phase_started_at": start,
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    }


def _next_values(quiz: Quiz, start) -> dict:
    next_index = quiz.current_index + 1
    if next_index >= len(quiz.questions):
        return _finished_values(start)
    return _question_values(quiz, next_index, start)


def _transition(quiz: Quiz, from_phase: str, from_index: int, values: dict) -> bool:
    """Условный UPDATE: применяем переход, только если фаза ещё не сменилась."""
    result = db.session.execute(
        update(Quiz)
        .where(Quiz.id == quiz.id, Quiz.phase == from_phase, Quiz.current_index == from_index)
        .values(**values),
    )
    if not result.rowcount:
        db.session.commit()
        return False
    bump("quiz", "leaderboard")
    db.session.commit()
    db.session.refresh(quiz)
    return True


# --------------------------------------------------------------------------- #
# Действия администратора
# --------------------------------------------------------------------------- #
def apply_values(quiz: Quiz, values: dict) -> None:
    for field, value in values.items():
        setattr(quiz, field, value)
    bump("quiz", "leaderboard")
    db.session.commit()


def start(quiz: Quiz, index: int = 0) -> None:
    """Запустить тест с указанного вопроса (по умолчанию с первого)."""
    if not quiz.questions:
        return
    index = max(0, min(index, len(quiz.questions) - 1))
    quiz.is_open = True
    quiz.opened_at = quiz.opened_at or utcnow()
    quiz.closed_at = None
    apply_values(quiz, _question_values(quiz, index, utcnow()))


def goto(quiz: Quiz, index: int) -> None:
    if not quiz.questions:
        return
    index = max(0, min(index, len(quiz.questions) - 1))
    apply_values(quiz, _question_values(quiz, index, utcnow()))


def reveal(quiz: Quiz) -> None:
    """Досрочно завершить вопрос и показать рейтинг."""
    if quiz.phase != PHASE_QUESTION:
        return
    apply_values(quiz, _standings_values(quiz, utcnow()))


def next_question(quiz: Quiz) -> None:
    if quiz.phase == PHASE_IDLE:
        start(quiz, 0)
        return
    if quiz.phase == PHASE_FINISHED:
        return
    apply_values(quiz, _next_values(quiz, utcnow()))


def prev_question(quiz: Quiz) -> None:
    target = quiz.current_index - 1 if quiz.phase != PHASE_FINISHED else len(quiz.questions) - 1
    if target < 0:
        target = 0
    goto(quiz, target)


def finish(quiz: Quiz) -> None:
    apply_values(quiz, _finished_values(utcnow()))


def pause(quiz: Quiz) -> None:
    if not quiz.is_live or quiz.is_paused:
        return
    apply_values(quiz, {
        "is_paused": True,
        "paused_remaining": quiz.remaining_seconds or 0,
    })


def resume(quiz: Quiz) -> None:
    if not quiz.is_paused:
        return
    left = max(1, quiz.paused_remaining or 1)
    apply_values(quiz, {
        "is_paused": False,
        "paused_remaining": 0,
        "phase_ends_at": utcnow() + timedelta(seconds=left),
    })


def extend(quiz: Quiz, seconds: int) -> None:
    """Добавить (или отнять) время текущей фазе на ходу."""
    if not quiz.is_live:
        return
    if quiz.is_paused:
        apply_values(quiz, {"paused_remaining": max(1, (quiz.paused_remaining or 0) + seconds)})
        return
    base = quiz.phase_ends_at or utcnow()
    new_end = base + timedelta(seconds=seconds)
    if new_end <= utcnow():
        new_end = utcnow() + timedelta(seconds=1)
    apply_values(quiz, {"phase_ends_at": new_end})


def reset(quiz: Quiz, clear_answers: bool = True) -> None:
    """Вернуть тест в исходное состояние (по умолчанию — с очисткой ответов)."""
    if clear_answers:
        db.session.query(QuizAnswer).delete()
    apply_values(quiz, {
        "phase": PHASE_IDLE,
        "current_index": 0,
        "phase_started_at": None,
        "phase_ends_at": None,
        "is_paused": False,
        "paused_remaining": 0,
    })


def set_open(quiz: Quiz, is_open: bool) -> None:
    quiz.is_open = is_open
    if is_open:
        quiz.opened_at = utcnow()
        quiz.closed_at = None
    else:
        quiz.closed_at = utcnow()
        quiz.phase = PHASE_IDLE
        quiz.phase_ends_at = None
        quiz.is_paused = False
    bump("quiz")
    db.session.commit()


def settings(quiz: Quiz, data: dict) -> None:
    """Изменить тайминги на ходу: новое время применяется и к текущей фазе."""
    if "question_seconds" in data:
        new_value = clamp_seconds(int(data["question_seconds"] or 0), quiz.question_seconds)
        _retime(quiz, PHASE_QUESTION, quiz.question_seconds, new_value)
        quiz.question_seconds = new_value
    if "standings_seconds" in data:
        new_value = clamp_seconds(int(data["standings_seconds"] or 0), quiz.standings_seconds)
        _retime(quiz, PHASE_STANDINGS, quiz.standings_seconds, new_value)
        quiz.standings_seconds = new_value
    if "auto_advance" in data:
        quiz.auto_advance = bool(data["auto_advance"])
    if "show_results" in data:
        quiz.show_results = bool(data["show_results"])
    bump("quiz")
    db.session.commit()


def _retime(quiz: Quiz, phase: str, old_seconds: int, new_seconds: int) -> None:
    """Сдвинуть конец текущей фазы на разницу таймингов."""
    if quiz.phase != phase or new_seconds == old_seconds:
        return
    delta = new_seconds - old_seconds
    if quiz.is_paused:
        quiz.paused_remaining = max(1, (quiz.paused_remaining or 0) + delta)
        return
    if quiz.phase_ends_at is None:
        return
    quiz.phase_ends_at += timedelta(seconds=delta)
    if quiz.phase_ends_at <= utcnow():
        quiz.phase_ends_at = utcnow() + timedelta(seconds=1)
