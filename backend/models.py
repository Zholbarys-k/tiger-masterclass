"""Модели базы данных TIGER MasterClass."""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import UniqueConstraint, func

from .db import db

ROLE_ADMIN = "admin"
ROLE_LEADER = "leader"
ROLE_MEMBER = "member"

# Фазы синхронного теста: один вопрос на всех, затем рейтинг, затем следующий.
PHASE_IDLE = "idle"            # тест открыт, но ещё не запущен администратором
PHASE_QUESTION = "question"    # идёт вопрос, лидеры отвечают
PHASE_STANDINGS = "standings"  # время вышло: правильный ответ и рейтинг команд
PHASE_FINISHED = "finished"    # вопросы закончились
QUIZ_PHASES = (PHASE_IDLE, PHASE_QUESTION, PHASE_STANDINGS, PHASE_FINISHED)

# Фазы задания с таймером (№2, №3 и новые): час на работу, затем голосование.
TIMED_TASK_MIN_ORDER = 2
TASK3_ORDER = 3
PHASE_T3_IDLE = "idle"
PHASE_T3_RUNNING = "running"
PHASE_T3_VOTING = "voting"
PHASE_T3_CLOSED = "closed"
TASK3_PHASES = (PHASE_T3_IDLE, PHASE_T3_RUNNING, PHASE_T3_VOTING, PHASE_T3_CLOSED)
TASK3_DEFAULT_SECONDS = 3600


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _pick(obj, prefix: str, lang: str) -> str:
    """Вернуть локализованное поле prefix_<lang> с откатом на ru → en → kk."""
    for code in (lang, "ru", "en", "kk"):
        value = getattr(obj, f"{prefix}_{code}", None)
        if value:
            return value
    return ""


class Team(db.Model):
    __tablename__ = "teams"

    id = db.Column(db.Integer, primary_key=True)
    number = db.Column(db.Integer, unique=True, nullable=False)
    name = db.Column(db.String(80), unique=True, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    users = db.relationship("User", back_populates="team", lazy="selectin")
    submissions = db.relationship("Submission", back_populates="team", lazy="selectin")
    quiz_answers = db.relationship("QuizAnswer", back_populates="team", lazy="selectin")
    adjustments = db.relationship("ScoreAdjustment", back_populates="team", lazy="selectin")

    # --- расчёт баллов ---
    @property
    def task_points(self) -> int:
        return sum(s.points or 0 for s in self.submissions)

    @property
    def quiz_points(self) -> int:
        return sum(a.points or 0 for a in self.quiz_answers)

    @property
    def bonus_points(self) -> int:
        return sum(a.delta or 0 for a in self.adjustments)

    @property
    def total_points(self) -> int:
        return self.task_points + self.quiz_points + self.bonus_points

    @property
    def has_activity(self) -> bool:
        return bool(self.submissions or self.quiz_answers or self.bonus_points)

    @property
    def last_activity(self) -> datetime | None:
        stamps = [s.created_at for s in self.submissions]
        stamps += [a.created_at for a in self.quiz_answers]
        stamps += [a.created_at for a in self.adjustments]
        return max(stamps) if stamps else None

    @property
    def leader(self):
        return next((u for u in self.users if u.role == ROLE_LEADER), None)

    @property
    def members(self):
        return [u for u in self.users if u.role == ROLE_MEMBER]

    def to_dict(self, with_users: bool = False) -> dict:
        data = {
            "id": self.id,
            "number": self.number,
            "name": self.name,
            "is_active": self.is_active,
            "task_points": self.task_points,
            "quiz_points": self.quiz_points,
            "bonus_points": self.bonus_points,
            "total_points": self.total_points,
            "submissions_count": len(self.submissions),
            "quiz_answered": len(self.quiz_answers),
        }
        if with_users:
            leader = self.leader
            data["leader"] = leader.to_dict() if leader else None
            data["members"] = [u.to_dict() for u in self.members]
        return data


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    login = db.Column(db.String(64), unique=True, nullable=False, index=True)
    display_name = db.Column(db.String(120), nullable=False, default="")
    role = db.Column(db.String(16), nullable=False, default=ROLE_MEMBER)
    team_id = db.Column(db.Integer, db.ForeignKey("teams.id"), nullable=True)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    last_login_at = db.Column(db.DateTime, nullable=True)
    school = db.Column(db.String(120), default="", nullable=False)
    grade = db.Column(db.String(40), default="", nullable=False)
    about = db.Column(db.String(400), default="", nullable=False)

    team = db.relationship("Team", back_populates="users")
    tokens = db.relationship("AuthToken", back_populates="user", cascade="all, delete-orphan")
    vote = db.relationship("Vote", back_populates="user", uselist=False,
                           cascade="all, delete-orphan")
    project_votes = db.relationship("ProjectVote", back_populates="user",
                                   cascade="all, delete-orphan")

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    @property
    def profile_filled(self) -> bool:
        return bool((self.display_name or "").strip())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "login": self.login,
            "display_name": self.display_name or "",
            "school": self.school or "",
            "grade": self.grade or "",
            "about": self.about or "",
            "profile_filled": self.profile_filled,
            "role": self.role,
            "team_id": self.team_id,
            "team_name": self.team.name if self.team else None,
            "is_active": self.is_active,
            "last_login_at": self.last_login_at.isoformat() if self.last_login_at else None,
        }


class AuthToken(db.Model):
    __tablename__ = "auth_tokens"

    token = db.Column(db.String(64), primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)

    user = db.relationship("User", back_populates="tokens")

    @property
    def is_valid(self) -> bool:
        return self.expires_at > utcnow()

    @staticmethod
    def build_expiry(hours: int) -> datetime:
        return utcnow() + timedelta(hours=hours)


class Task(db.Model):
    __tablename__ = "tasks"

    id = db.Column(db.Integer, primary_key=True)
    order = db.Column(db.Integer, default=0, nullable=False)
    title_kk = db.Column(db.String(200), default="")
    title_ru = db.Column(db.String(200), default="")
    title_en = db.Column(db.String(200), default="")
    body_kk = db.Column(db.Text, default="")
    body_ru = db.Column(db.Text, default="")
    body_en = db.Column(db.Text, default="")
    max_points = db.Column(db.Integer, default=10, nullable=False)
    allow_files = db.Column(db.Boolean, default=True, nullable=False)
    is_published = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    submissions = db.relationship("Submission", back_populates="task",
                                  cascade="all, delete-orphan", lazy="selectin")

    def to_dict(self, lang: str = "ru", full: bool = False) -> dict:
        data = {
            "id": self.id,
            "order": self.order,
            "title": _pick(self, "title", lang),
            "body": _pick(self, "body", lang),
            "max_points": self.max_points,
            "allow_files": self.allow_files,
            "is_published": self.is_published,
            "created_at": self.created_at.isoformat(),
            "submissions_count": len(self.submissions),
        }
        if full:
            for code in ("kk", "ru", "en"):
                data[f"title_{code}"] = getattr(self, f"title_{code}") or ""
                data[f"body_{code}"] = getattr(self, f"body_{code}") or ""
        return data


class Submission(db.Model):
    __tablename__ = "submissions"

    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("tasks.id"), nullable=False, index=True)
    team_id = db.Column(db.Integer, db.ForeignKey("teams.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    text = db.Column(db.Text, default="")
    points = db.Column(db.Integer, default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    task = db.relationship("Task", back_populates="submissions")
    team = db.relationship("Team", back_populates="submissions")
    user = db.relationship("User")
    attachments = db.relationship("Attachment", back_populates="submission",
                                  cascade="all, delete-orphan", lazy="selectin")

    __table_args__ = (UniqueConstraint("task_id", "team_id", name="uq_submission_task_team"),)

    def to_dict(self, lang: str = "ru") -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "task_title": _pick(self.task, "title", lang) if self.task else "",
            "team_id": self.team_id,
            "team_name": self.team.name if self.team else "",
            "author": self.user.login if self.user else "",
            "text": self.text or "",
            "points": self.points,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "attachments": [a.to_dict() for a in self.attachments],
        }


class Attachment(db.Model):
    __tablename__ = "attachments"

    id = db.Column(db.Integer, primary_key=True)
    submission_id = db.Column(db.Integer, db.ForeignKey("submissions.id"),
                              nullable=False, index=True)
    stored_name = db.Column(db.String(160), nullable=False)
    original_name = db.Column(db.String(255), default="")
    mime = db.Column(db.String(80), default="")
    size_bytes = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    submission = db.relationship("Submission", back_populates="attachments")

    @property
    def kind(self) -> str:
        return "video" if (self.mime or "").startswith("video") else "image"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "url": f"/api/files/{self.submission_id}/{self.stored_name}",
            "original_name": self.original_name,
            "mime": self.mime,
            "kind": self.kind,
            "size_bytes": self.size_bytes,
        }


class Section(db.Model):
    __tablename__ = "sections"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(40), unique=True, nullable=False)
    icon = db.Column(db.String(8), default="🔬")
    name_kk = db.Column(db.String(160), default="")
    name_ru = db.Column(db.String(160), default="")
    name_en = db.Column(db.String(160), default="")
    desc_kk = db.Column(db.Text, default="")
    desc_ru = db.Column(db.Text, default="")
    desc_en = db.Column(db.Text, default="")
    order = db.Column(db.Integer, default=0)
    is_open = db.Column(db.Boolean, default=True, nullable=False)

    votes = db.relationship("Vote", back_populates="section",
                            cascade="all, delete-orphan", lazy="selectin")

    def to_dict(self, lang: str = "ru") -> dict:
        return {
            "id": self.id,
            "code": self.code,
            "icon": self.icon,
            "name": _pick(self, "name", lang),
            "description": _pick(self, "desc", lang),
            "is_open": self.is_open,
            "votes": len(self.votes),
        }


class Vote(db.Model):
    __tablename__ = "votes"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=False)
    section_id = db.Column(db.Integer, db.ForeignKey("sections.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user = db.relationship("User", back_populates="vote")
    section = db.relationship("Section", back_populates="votes")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_login": self.user.login if self.user else "",
            "user_role": self.user.role if self.user else "",
            "team_name": self.user.team.name if self.user and self.user.team else "",
            "section_id": self.section_id,
            "updated_at": self.updated_at.isoformat(),
        }


class TaskRound(db.Model):
    """Синхронный таймер задания: час на работу, затем голосование лайками."""

    __tablename__ = "task_rounds"

    id = db.Column(db.Integer, primary_key=True)
    task_id = db.Column(db.Integer, db.ForeignKey("tasks.id"), nullable=True, unique=True, index=True)
    task_order = db.Column(db.Integer, default=TASK3_ORDER, nullable=False)
    phase = db.Column(db.String(16), default=PHASE_T3_IDLE, nullable=False)
    duration_seconds = db.Column(db.Integer, default=TASK3_DEFAULT_SECONDS, nullable=False)
    phase_started_at = db.Column(db.DateTime, nullable=True)
    phase_ends_at = db.Column(db.DateTime, nullable=True)
    is_paused = db.Column(db.Boolean, default=False, nullable=False)
    paused_remaining = db.Column(db.Integer, default=0, nullable=False)

    task = db.relationship("Task")

    @property
    def is_live(self) -> bool:
        return self.phase == PHASE_T3_RUNNING

    @property
    def can_submit(self) -> bool:
        return self.phase == PHASE_T3_RUNNING

    @property
    def projects_visible(self) -> bool:
        return self.phase in (PHASE_T3_VOTING, PHASE_T3_CLOSED)

    @property
    def can_like(self) -> bool:
        return self.phase == PHASE_T3_VOTING

    @property
    def remaining_seconds(self) -> int | None:
        if not self.is_live:
            return None
        if self.is_paused:
            return max(0, self.paused_remaining or 0)
        if self.phase_ends_at is None:
            return None
        left = (self.phase_ends_at - utcnow()).total_seconds()
        return max(0, int(math.ceil(left)))

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "task_order": self.task_order,
            "phase": self.phase,
            "duration_seconds": self.duration_seconds,
            "is_paused": self.is_paused,
            "remaining_seconds": self.remaining_seconds,
            "phase_seconds": self.duration_seconds,
            "phase_started_at": self.phase_started_at.isoformat() if self.phase_started_at else None,
            "phase_ends_at": self.phase_ends_at.isoformat() if self.phase_ends_at else None,
            "can_submit": self.can_submit,
            "projects_visible": self.projects_visible,
            "can_like": self.can_like,
        }


class ProjectVote(db.Model):
    """Один лайк участника за проект конкретного задания."""

    __tablename__ = "project_votes"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    task_id = db.Column(db.Integer, db.ForeignKey("tasks.id"), nullable=True, index=True)
    submission_id = db.Column(db.Integer, db.ForeignKey("submissions.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user = db.relationship("User", back_populates="project_votes")
    submission = db.relationship("Submission")

    __table_args__ = (UniqueConstraint("user_id", "task_id", name="uq_project_vote_user_task"),)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "user_login": self.user.login if self.user else "",
            "user_role": self.user.role if self.user else "",
            "team_name": self.user.team.name if self.user and self.user.team else "",
            "task_id": self.task_id,
            "submission_id": self.submission_id,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Quiz(db.Model):
    __tablename__ = "quizzes"

    id = db.Column(db.Integer, primary_key=True)
    title_kk = db.Column(db.String(200), default="")
    title_ru = db.Column(db.String(200), default="")
    title_en = db.Column(db.String(200), default="")
    is_open = db.Column(db.Boolean, default=False, nullable=False)
    show_results = db.Column(db.Boolean, default=True, nullable=False)
    opened_at = db.Column(db.DateTime, nullable=True)
    closed_at = db.Column(db.DateTime, nullable=True)

    # --- синхронный режим «один вопрос на всех» ---
    phase = db.Column(db.String(16), default=PHASE_IDLE, nullable=False)
    current_index = db.Column(db.Integer, default=0, nullable=False)
    phase_started_at = db.Column(db.DateTime, nullable=True)
    phase_ends_at = db.Column(db.DateTime, nullable=True)
    question_seconds = db.Column(db.Integer, default=60, nullable=False)
    standings_seconds = db.Column(db.Integer, default=20, nullable=False)
    auto_advance = db.Column(db.Boolean, default=True, nullable=False)
    is_paused = db.Column(db.Boolean, default=False, nullable=False)
    paused_remaining = db.Column(db.Integer, default=0, nullable=False)

    questions = db.relationship("Question", back_populates="quiz",
                                cascade="all, delete-orphan",
                                order_by="Question.order", lazy="selectin")

    # --- живое состояние ---
    @property
    def questions_count(self) -> int:
        return len(self.questions)

    def question_at(self, index: int):
        if 0 <= index < len(self.questions):
            return self.questions[index]
        return None

    @property
    def current_question(self):
        return self.question_at(self.current_index)

    @property
    def is_live(self) -> bool:
        return self.phase in (PHASE_QUESTION, PHASE_STANDINGS)

    @property
    def remaining_seconds(self) -> int | None:
        """Сколько секунд осталось до конца текущей фазы (None — таймера нет)."""
        if not self.is_live:
            return None
        if self.is_paused:
            return max(0, self.paused_remaining or 0)
        if self.phase_ends_at is None:
            return None
        left = (self.phase_ends_at - utcnow()).total_seconds()
        return max(0, int(math.ceil(left)))

    @property
    def phase_seconds(self) -> int:
        return self.question_seconds if self.phase == PHASE_QUESTION else self.standings_seconds

    def to_dict(self, lang: str = "ru") -> dict:
        return {
            "id": self.id,
            "title": _pick(self, "title", lang),
            "is_open": self.is_open,
            "show_results": self.show_results,
            "questions_count": len(self.questions),
            "total_points": sum(q.points for q in self.questions),
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
            "phase": self.phase,
            "current_index": self.current_index,
            "current_number": self.current_index + 1 if self.is_live else 0,
            "question_seconds": self.question_seconds,
            "standings_seconds": self.standings_seconds,
            "auto_advance": self.auto_advance,
            "is_paused": self.is_paused,
            "remaining_seconds": self.remaining_seconds,
            "phase_seconds": self.phase_seconds,
            "phase_started_at": self.phase_started_at.isoformat() if self.phase_started_at else None,
            "phase_ends_at": self.phase_ends_at.isoformat() if self.phase_ends_at else None,
        }


class Question(db.Model):
    __tablename__ = "questions"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    order = db.Column(db.Integer, default=0, nullable=False)
    text_kk = db.Column(db.Text, default="")
    text_ru = db.Column(db.Text, default="")
    text_en = db.Column(db.Text, default="")
    options_kk = db.Column(db.Text, default="[]")   # JSON-массив строк
    options_ru = db.Column(db.Text, default="[]")
    options_en = db.Column(db.Text, default="[]")
    correct_index = db.Column(db.Integer, default=0, nullable=False)
    points = db.Column(db.Integer, default=2, nullable=False)

    quiz = db.relationship("Quiz", back_populates="questions")
    answers = db.relationship("QuizAnswer", back_populates="question",
                              cascade="all, delete-orphan", lazy="selectin")

    def options(self, lang: str = "ru") -> list[str]:
        for code in (lang, "ru", "en", "kk"):
            raw = getattr(self, f"options_{code}", None)
            if raw:
                try:
                    parsed = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if parsed:
                    return parsed
        return []

    def to_dict(self, lang: str = "ru", reveal: bool = False) -> dict:
        data = {
            "id": self.id,
            "order": self.order,
            "text": _pick(self, "text", lang),
            "options": self.options(lang),
            "points": self.points,
        }
        if reveal:
            data["correct_index"] = self.correct_index
        return data


class QuizAnswer(db.Model):
    __tablename__ = "quiz_answers"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(db.Integer, db.ForeignKey("questions.id"),
                            nullable=False, index=True)
    team_id = db.Column(db.Integer, db.ForeignKey("teams.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    selected_index = db.Column(db.Integer, nullable=False)
    is_correct = db.Column(db.Boolean, default=False, nullable=False)
    points = db.Column(db.Integer, default=0, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    question = db.relationship("Question", back_populates="answers")
    team = db.relationship("Team", back_populates="quiz_answers")
    user = db.relationship("User")

    __table_args__ = (UniqueConstraint("question_id", "team_id", name="uq_answer_question_team"),)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question_id": self.question_id,
            "team_id": self.team_id,
            "team_name": self.team.name if self.team else "",
            "selected_index": self.selected_index,
            "is_correct": self.is_correct,
            "points": self.points,
            "created_at": self.created_at.isoformat(),
        }


class ScoreAdjustment(db.Model):
    __tablename__ = "score_adjustments"

    id = db.Column(db.Integer, primary_key=True)
    team_id = db.Column(db.Integer, db.ForeignKey("teams.id"), nullable=False, index=True)
    admin_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    delta = db.Column(db.Integer, default=0, nullable=False)
    reason = db.Column(db.String(255), default="")
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    team = db.relationship("Team", back_populates="adjustments")
    admin = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "team_id": self.team_id,
            "team_name": self.team.name if self.team else "",
            "delta": self.delta,
            "reason": self.reason,
            "admin": self.admin.login if self.admin else "",
            "created_at": self.created_at.isoformat(),
        }


class Message(db.Model):
    """Переписка участника/лидера с администраторами (одна ветка на человека)."""

    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    thread_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body = db.Column(db.Text, nullable=False)
    is_read = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    thread_user = db.relationship("User", foreign_keys=[thread_user_id])
    author = db.relationship("User", foreign_keys=[author_id])

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "thread_user_id": self.thread_user_id,
            "author_id": self.author_id,
            "author_login": self.author.login if self.author else "",
            "author_name": (self.author.display_name if self.author else "") or "",
            "author_role": self.author.role if self.author else "",
            "body": self.body,
            "is_read": self.is_read,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class TeamMessage(db.Model):
    """Сообщения внутри команды: видят лидер и участники своей команды."""

    __tablename__ = "team_messages"

    id = db.Column(db.Integer, primary_key=True)
    team_id = db.Column(db.Integer, db.ForeignKey("teams.id"), nullable=False, index=True)
    author_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=utcnow, nullable=False)

    team = db.relationship("Team")
    author = db.relationship("User")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "team_id": self.team_id,
            "author_id": self.author_id,
            "author_login": self.author.login if self.author else "",
            "author_name": (self.author.display_name if self.author else "") or "",
            "author_role": self.author.role if self.author else "",
            "body": self.body,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class StateVersion(db.Model):
    """Счётчики версий для «реального времени» через лёгкий polling."""

    __tablename__ = "state_versions"

    key = db.Column(db.String(32), primary_key=True)
    version = db.Column(db.Integer, default=1, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)


STATE_KEYS = ("tasks", "quiz", "votes", "leaderboard", "teams", "submissions", "messages", "teamchat", "task3")


def bump(*keys: str) -> None:
    """Увеличить версию разделов, чтобы клиенты подтянули изменения."""
    for key in keys:
        row = db.session.get(StateVersion, key)
        if row is None:
            row = StateVersion(key=key, version=1)
            db.session.add(row)
        else:
            row.version = (row.version or 0) + 1
            row.updated_at = utcnow()


def current_versions() -> dict[str, int]:
    rows = db.session.query(StateVersion).all()
    versions = {key: 0 for key in STATE_KEYS}
    for row in rows:
        versions[row.key] = row.version
    return versions


def count_users(role: str | None = None) -> int:
    query = db.session.query(func.count(User.id))
    if role:
        query = query.filter(User.role == role)
    return query.scalar() or 0
