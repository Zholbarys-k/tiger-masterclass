"""Точка входа для виртуального хостинга Timeweb (Apache + mod_wsgi).

ВАЖНО: замените путь в VENV_SITE_PACKAGES на свой.
Узнать точный путь можно в SSH командой:
    ls -d ~/venv/lib/python*/site-packages

Пример для логина `cw12345` и Python 3.10:
    /home/c/cw12345/venv/lib/python3.10/site-packages
"""
import os
import sys

# --- 1. Путь к site-packages вашего виртуального окружения (ЗАМЕНИТЕ) ---
VENV_SITE_PACKAGES = "/home/c/CHANGE_ME/venv/lib/python3.10/site-packages"

# --- 2. Папка самого проекта (определяется автоматически) ---
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

if os.path.isdir(VENV_SITE_PACKAGES):
    sys.path.insert(0, VENV_SITE_PACKAGES)
sys.path.insert(0, PROJECT_DIR)
os.chdir(PROJECT_DIR)

from backend import create_app   # noqa: E402

application = create_app()
app = application
