"""Модели базы данных TIGER MasterClass."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import UniqueConstraint, func

from .db import db

ROLE_ADMIN = "admin"
ROLE_LEADER = "leader"
ROLE_MEMBER = "member"


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

    team = db.relationship("Team", back_populates="users")
    tokens = db.relationship("AuthToken", back_populates="user", cascade="all, delete-orphan")
    vote = db.relationship("Vote", back_populates="user", uselist=False,
                           cascade="all, delete-orphan")

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "login": self.login,
            "display_name": self.display_name,
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

    questions = db.relationship("Question", back_populates="quiz",
                                cascade="all, delete-orphan",
                                order_by="Question.order", lazy="selectin")

    def to_dict(self, lang: str = "ru") -> dict:
        return {
            "id": self.id,
            "title": _pick(self, "title", lang),
            "is_open": self.is_open,
            "show_results": self.show_results,
            "questions_count": len(self.questions),
            "total_points": sum(q.points for q in self.questions),
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
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


class StateVersion(db.Model):
    """Счётчики версий для «реального времени» через лёгкий polling."""

    __tablename__ = "state_versions"

    key = db.Column(db.String(32), primary_key=True)
    version = db.Column(db.Integer, default=1, nullable=False)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow, nullable=False)


STATE_KEYS = ("tasks", "quiz", "votes", "leaderboard", "teams", "submissions")


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
