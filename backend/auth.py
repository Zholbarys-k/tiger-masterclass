"""Токены, вход/выход и декораторы проверки прав."""
from __future__ import annotations

import secrets
from functools import wraps

from flask import current_app, g, request

from .db import db
from .models import ROLE_ADMIN, AuthToken, User, utcnow
from .utils import json_err


def create_token(user: User) -> AuthToken:
    ttl = current_app.config["TOKEN_TTL_HOURS"]
    token = AuthToken(
        token=secrets.token_hex(24),
        user_id=user.id,
        expires_at=AuthToken.build_expiry(ttl),
    )
    db.session.add(token)
    return token


def revoke_token(raw_token: str) -> None:
    row = db.session.get(AuthToken, raw_token)
    if row is not None:
        db.session.delete(row)
        db.session.commit()


def resolve_user() -> User | None:
    """Найти пользователя по заголовку Authorization: Bearer <token>."""
    header = request.headers.get("Authorization", "")
    raw = header[7:].strip() if header.lower().startswith("bearer ") else \
        (request.args.get("token") or "").strip()
    if not raw:
        return None
    row = db.session.get(AuthToken, raw)
    if row is None:
        return None
    if not row.is_valid:
        db.session.delete(row)
        db.session.commit()
        return None
    user = row.user
    if user is None or not user.is_active:
        return None
    g.auth_token = raw
    return user


def check_password(user: User, password: str) -> bool:
    expected = (
        current_app.config["ADMIN_PASSWORD"]
        if user.role == ROLE_ADMIN
        else current_app.config["PARTICIPANT_PASSWORD"]
    )
    return secrets.compare_digest(password or "", expected)


def require_auth(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = resolve_user()
        if user is None:
            return json_err("unauthorized", "Требуется вход в систему", 401)
        g.user = user
        return view(*args, **kwargs)

    return wrapper


def require_role(*roles: str):
    """Разрешить доступ только указанным ролям (админ проходит всегда, если указан)."""

    def decorator(view):
        @wraps(view)
        @require_auth
        def wrapper(*args, **kwargs):
            if g.user.role not in roles:
                return json_err("forbidden", "Недостаточно прав для этого действия", 403)
            return view(*args, **kwargs)

        return wrapper

    return decorator


def touch_login(user: User) -> None:
    user.last_login_at = utcnow()
