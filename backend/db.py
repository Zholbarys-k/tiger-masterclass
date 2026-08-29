"""Единственный экземпляр SQLAlchemy для всего приложения."""
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
