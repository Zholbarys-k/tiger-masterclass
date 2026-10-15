"""Точка входа: python run.py"""
from __future__ import annotations

import socket

from backend import create_app
from backend.db import db
from backend.models import ROLE_ADMIN, Team, User
from config import Config

app = create_app()


def local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except OSError:
        return "127.0.0.1"


def print_banner() -> None:
    with app.app_context():
        teams = db.session.query(Team).count()
        users = db.session.query(User).count()
        admins = db.session.query(User).filter_by(role=ROLE_ADMIN).count()

    print("\n" + "=" * 62)
    print("  TIGER MASTERCLASS")
    print("=" * 62)
    print(f"  Команд: {teams}   Аккаунтов: {users}   Админов: {admins}")
    if users == 0:
        print("  ВНИМАНИЕ: база пуста — выполните: python scripts/init_db.py")
    print(f"  Локально:      http://127.0.0.1:{Config.PORT}")
    print(f"  В сети Wi-Fi:  http://{local_ip()}:{Config.PORT}")
    print("=" * 62 + "\n")


if __name__ == "__main__":
    print_banner()
    app.run(host=Config.HOST, port=Config.PORT, debug=False, threaded=True)
