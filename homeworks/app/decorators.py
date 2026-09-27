"""Role-based access decorators."""
from functools import wraps

from flask import abort, current_app, redirect

from .auth_utils import current_user


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return redirect(current_app.config["SERVICE_PORTAL_URL"])
        return fn(*args, **kwargs)

    return wrapper


def role_required(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = current_user()
            if user is None:
                return redirect(current_app.config["SERVICE_PORTAL_URL"])
            if user.role not in roles:
                abort(403)
            return fn(*args, **kwargs)

        return wrapper

    return deco
