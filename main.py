"""Точка входа для production-серверов (gunicorn, mod_wsgi, Passenger).

Timeweb Cloud App Platform ожидает файл main.py с переменной `app`:
    gunicorn main:app --timeout 60 --bind 0.0.0.0:80

Виртуальный хостинг (mod_wsgi) использует переменную `application` через index.wsgi.
"""
from backend import create_app

app = create_app()
application = app   # синоним для WSGI-серверов

if __name__ == "__main__":
    from config import Config

    app.run(host=Config.HOST, port=Config.PORT)
