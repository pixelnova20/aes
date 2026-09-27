import secrets
from functools import wraps

import jwt
from flask import current_app, g, jsonify, redirect, request, session

from .class_access import current_class_for_account


ALLOWED_ROLES = {"teacher", "ta", "student"}


def current_user():
    return getattr(g, "slideshow_user", None)


def load_current_user():
    g.slideshow_user = session.get("slideshow_user")
    if g.slideshow_user is not None:
        class_context = current_class_for_account(g.slideshow_user["external_id"])
        g.slideshow_user.update({
            "class_id": class_context["class_id"] if class_context else None,
            "class_name": class_context["class_name"] if class_context else None,
            "course_name": class_context["course_name"] if class_context else None,
        })
        session["slideshow_user"] = g.slideshow_user
    if "_csrf_token" not in session:
        session["_csrf_token"] = secrets.token_hex(24)


def establish_sso_session(token):
    payload = jwt.decode(
        token,
        current_app.config["SSO_JWT_SECRET"],
        algorithms=["HS256"],
    )
    if payload.get("purpose") != "service_sso" or payload.get("service") != "slideshow":
        raise jwt.InvalidTokenError("令牌用途无效")
    role = payload.get("role")
    external_id = str(payload.get("sub") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    if role not in ALLOWED_ROLES or not external_id or not email:
        raise jwt.InvalidTokenError("令牌身份无效")

    class_context = current_class_for_account(external_id)
    session.clear()
    session.permanent = True
    session["_csrf_token"] = secrets.token_hex(24)
    session["slideshow_user"] = {
        "external_id": external_id,
        "email": email,
        "name": str(payload.get("name") or email.split("@", 1)[0]),
        "role": role,
        "class_id": class_context["class_id"] if class_context else None,
        "class_name": class_context["class_name"] if class_context else None,
        "course_name": class_context["course_name"] if class_context else None,
    }


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            return redirect(current_app.config["SERVICE_PORTAL_URL"])
        return view(*args, **kwargs)

    return wrapped


def api_login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if current_user() is None:
            return jsonify({"message": "请从服务门户进入幻灯片模块。"}), 401
        return view(*args, **kwargs)

    return wrapped


def roles_required(*roles):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            user = current_user()
            if user is None:
                return redirect(current_app.config["SERVICE_PORTAL_URL"])
            if user["role"] not in roles:
                return "无权执行此操作", 403
            return view(*args, **kwargs)

        return wrapped

    return decorator


def csrf_token():
    return session.get("_csrf_token", "")


def validate_csrf():
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    submitted = request.form.get("_csrf") or request.headers.get("X-CSRF-Token")
    if not submitted or submitted != session.get("_csrf_token"):
        return jsonify({"message": "CSRF 校验失败。"}), 400
    return None
