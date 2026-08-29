@echo off
chcp 65001 >nul
title TIGER MasterClass
cd /d "%~dp0"

echo ============================================================
echo   TIGER MasterClass - запуск
echo ============================================================

if not exist "data\tiger.db" (
    echo [1/2] Первый запуск: создаём базу и аккаунты...
    python -m pip install -q -r requirements.txt
    python scripts\init_db.py
) else (
    echo [1/2] База найдена, пропускаем инициализацию.
)

echo [2/2] Запускаем сервер...
echo.
python run.py
pause
