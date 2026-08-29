"""Рейтинг команд и версии состояния для «реального времени»."""
from __future__ import annotations

from datetime import datetime, timezone

from flask import Blueprint, g

from ..auth import require_auth
from ..db import db
from ..models import ROLE_ADMIN, Team, current_versions
from ..utils import json_ok

bp = Blueprint("leaderboard", __name__, url_prefix="/api")


def build_leaderboard(include_empty: bool = False) -> list[dict]:
    """Список команд, отсортированный по баллам. Команды без отправок исключаются."""
    teams = db.session.query(Team).filter_by(is_active=True).all()
    rows = []
    for team in teams:
        if not include_empty and not team.has_activity:
            continue
        last = team.last_activity
        rows.append({
            "team_id": team.id,
            "number": team.number,
            "name": team.name,
            "task_points": team.task_points,
            "quiz_points": team.quiz_points,
            "bonus_points": team.bonus_points,
            "total_points": team.total_points,
            "submissions_count": len(team.submissions),
            "quiz_answered": len(team.quiz_answers),
            "last_activity": last.isoformat() if last else None,
            "_sort_time": last.timestamp() if last else float("inf"),
        })

    rows.sort(key=lambda r: (-r["total_points"], r["_sort_time"], r["number"]))
    for position, row in enumerate(rows, start=1):
        row["rank"] = position
        row.pop("_sort_time", None)
    return rows


@bp.get("/leaderboard")
@require_auth
def leaderboard():
    include_empty = g.user.role == ROLE_ADMIN
    rows = build_leaderboard(include_empty=include_empty)
    my_team_id = g.user.team_id
    my_row = next((r for r in rows if r["team_id"] == my_team_id), None)
    return json_ok(
        teams=rows,
        top_size=10,
        total_ranked=len(rows),
        my_team=my_row,
    )


@bp.get("/state")
@require_auth
def state():
    """Лёгкий эндпоинт опроса: версии разделов + серверное время."""
    return json_ok(
        versions=current_versions(),
        server_time=datetime.now(timezone.utc).isoformat(),
    )
