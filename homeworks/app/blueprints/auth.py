"""Authentication bridge from the unified service portal into Homeworks."""

import jwt
from flask import Blueprint, current_app, redirect, request, session, url_for

from ..audit import log
from ..auth_utils import current_user, login_user, logout_user
from ..database import db_session
from ..models import InviteCode, User, UserClassRole

bp = Blueprint("auth", __name__)

_HOME_FOR = {
    "super_admin": "admin.dashboard",
    "teacher": "teacher.dashboard",
    "ta": "ta.dashboard",
    "student": "student.dashboard",
}

def _home_for(role):
    return _HOME_FOR.get(role)


def _portal_redirect():
    return redirect(current_app.config["SERVICE_PORTAL_URL"])


@bp.route("/")
def index():
    user = current_user()
    if user is None:
        return _portal_redirect()
    home = _home_for(user.role)
    if home is None:
        logout_user()
        return _portal_redirect()
    return redirect(url_for(home))


@bp.route("/login", methods=["GET", "POST"])
def login():
    # Keep old bookmarks harmless; credentials are accepted only by the portal.
    return _portal_redirect()


@bp.route("/sso")
def sso():
    token = (request.args.get("token") or "").strip()
    if not token:
        return _portal_redirect()

    try:
        payload = jwt.decode(
            token,
            current_app.config["SSO_JWT_SECRET"],
            algorithms=["HS256"],
        )
    except jwt.PyJWTError:
        return _portal_redirect()

    if payload.get("purpose") != "homeworks_sso":
        return _portal_redirect()

    external_id = (payload.get("sub") or "").strip()
    email = (payload.get("email") or "").strip()
    role = payload.get("role")
    if role not in ("super_admin", "teacher", "ta", "student") or not email or not external_id:
        return _portal_redirect()
    if role == "super_admin" and email.lower() != current_app.config["SUPERUSER_EMAIL"]:
        return _portal_redirect()

    user = db_session.query(User).filter_by(external_id=external_id).first()
    if user is None:
        return _portal_redirect()
    if not user.enabled:
        return _portal_redirect()
    if user.role != role:
        return _portal_redirect()

    login_user(user)
    session_class_id = None
    class_invite_code = (payload.get("classInviteCode") or "").strip()
    if class_invite_code:
        invite = db_session.query(InviteCode).filter_by(code=class_invite_code).first()
        if invite is not None and invite.class_id is not None:
            membership = (
                db_session.query(UserClassRole)
                .filter_by(
                    user_id=user.id,
                    class_id=invite.class_id,
                    role_in_class=role,
                )
                .first()
            )
            if membership is not None:
                session_class_id = invite.class_id
    if session_class_id is None:
        session.pop("current_class_id", None)
    else:
        session["current_class_id"] = session_class_id
    log("sso.login", f"user_id={user.id}")
    return redirect(url_for(_home_for(user.role)))


@bp.route("/register", methods=["GET", "POST"])
def register():
    return redirect(current_app.config["COURSEWORKS_REGISTER_URL"])


@bp.route("/logout", methods=["POST"])
def logout():
    logout_user()
    return _portal_redirect()
