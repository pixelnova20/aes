"""Authentication helpers (session-based)."""
from datetime import datetime

from flask import g, session

from .database import db_session


def current_user():
    return getattr(g, "user", None)


def login_user(user):
    session["user_id"] = user.id
    session.permanent = True
    user.last_login_at = datetime.now()
    db_session.commit()
    # Set g.user so that audit logging within the same request can find the user
    g.user = user


def logout_user():
    user = current_user()
    if user is not None:
        user.last_login_at = datetime.now()
        db_session.commit()
    session.pop("user_id", None)
    session.pop("current_class_id", None)
    session.pop("_csrf_token", None)
