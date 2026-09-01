"""Авторизация: вход, выход, текущий пользователь."""
from __future__ import annotations

from flask import Blueprint, g, request

from ..auth import check_password, create_token, require_auth, revoke_token, touch_login
from ..db import db
from ..models import ROLE_ADMIN, User
from ..utils import json_err, json_ok

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@bp.post("/login")
def login():
    """Вход по логину и общему паролю. Роль определяется по логину."""
    data = request.get_json(silent=True) or {}
    login_value = (data.get("login") or "").strip().lower()
    password = data.get("password") or ""

    if not login_value or not password:
        return json_err("missing_fields", "Введите логин и пароль", 400)

    user = db.session.query(User).filter(User.login == login_value).one_or_none()
    if user is None or not user.is_active:
        return json_err("bad_credentials", "Неверный логин или пароль", 401)

    if not check_password(user, password):
        return json_err("bad_credentials", "Неверный логин или пароль", 401)

    token = create_token(user)
    touch_login(user)
    db.session.commit()

    return json_ok(
        token=token.token,
        user=user.to_dict(),
        redirect="/admin" if user.role == ROLE_ADMIN else "/app",
    )


@bp.post("/logout")
@require_auth
def logout():
    revoke_token(getattr(g, "auth_token", ""))
    return json_ok()


@bp.get("/me")
@require_auth
def me():
    team = g.user.team
    return json_ok(
        user=g.user.to_dict(),
        team=team.to_dict(with_users=True) if team else None,
    )


@bp.patch("/profile")
@require_auth
def update_profile():
    """Участник или лидер заполняет данные о себе."""
    data = request.get_json(silent=True) or {}

    if "display_name" in data:
        g.user.display_name = (data.get("display_name") or "").strip()[:120]
    if "school" in data:
        g.user.school = (data.get("school") or "").strip()[:120]
    if "grade" in data:
        g.user.grade = (data.get("grade") or "").strip()[:40]
    if "about" in data:
        g.user.about = (data.get("about") or "").strip()[:400]

    db.session.commit()
    return json_ok(user=g.user.to_dict())
