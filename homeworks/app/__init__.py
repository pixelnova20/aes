"""Application factory."""
import os
import secrets

from flask import Flask, abort, g, render_template, request, session
from markupsafe import Markup
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config

from .database import close_db, db_session, init_db
from .models import User


def _register_csrf(app):
    @app.before_request
    def _ensure_csrf_token():
        if "_csrf_token" not in session:
            session["_csrf_token"] = secrets.token_hex(16)

    @app.before_request
    def _csrf_protect():
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            token = session.get("_csrf_token")
            submitted = request.form.get("_csrf") or request.headers.get(
                "X-CSRF-Token"
            )
            if not token or token != submitted:
                abort(400, description="CSRF 校验失败")


def _register_globals(app):
    @app.before_request
    def _load_current_user():
        g.user = None
        uid = session.get("user_id")
        if uid:
            g.user = db_session.get(User, uid)
            if (
                g.user is not None
                and g.user.role == "super_admin"
                and g.user.email.strip().lower() != app.config["SUPERUSER_EMAIL"]
            ):
                session.clear()
                g.user = None

    @app.context_processor
    def _inject_helpers():
        def csrf_token():
            return session.get("_csrf_token", "")

        return {"csrf_token": csrf_token, "current_user": getattr(g, "user", None)}

    @app.template_filter("dt")
    def _fmt_datetime(value):
        if value is None:
            return "—"
        return value.strftime("%Y-%m-%d %H:%M")

    @app.template_filter("content_html")
    def _content_html(value):
        """Render stored question HTML under the request's current URL prefix."""
        html = str(value or "")
        prefix = request.script_root.rstrip("/")
        if prefix:
            html = html.replace(
                'src="/chapter-images/',
                f'src="{prefix}/chapter-images/',
            ).replace(
                "src='/chapter-images/",
                f"src='{prefix}/chapter-images/",
            )
        return Markup(html)


def create_app(config_object=Config):
    app = Flask(__name__)
    app.config.from_object(config_object)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    os.makedirs(os.path.dirname(app.config["ACCOUNT_DATABASE"]), exist_ok=True)
    os.makedirs(os.path.dirname(app.config["COURSE_DATABASE"]), exist_ok=True)
    os.makedirs(app.config["CHAPTER_UPLOAD_DIR"], exist_ok=True)
    os.makedirs(app.config["ANSWER_UPLOAD_DIR"], exist_ok=True)

    init_db(app)
    app.teardown_appcontext(close_db)

    _register_csrf(app)
    _register_globals(app)

    from .blueprints import admin, auth, files, student, ta, teacher

    app.register_blueprint(auth.bp)
    app.register_blueprint(admin.bp)
    app.register_blueprint(teacher.bp)
    app.register_blueprint(ta.bp)
    app.register_blueprint(student.bp)
    app.register_blueprint(files.bp)

    # Run data migrations before serving requests.
    with app.app_context():
        try:
            from .migration import run_migrations
            run_migrations()
        except Exception:
            pass  # table may not exist yet on first run

    @app.template_filter("dt")
    def _fmt_datetime(value):
        if value is None:
            return "—"
        return value.strftime("%Y-%m-%d %H:%M")

    @app.context_processor
    def _inject_now():
        from datetime import datetime
        return {"now": datetime.now()}

    @app.errorhandler(403)
    def forbidden(e):
        return render_template("error.html", code=403, message="没有权限访问该资源"), 403

    @app.errorhandler(404)
    def not_found(e):
        return render_template("error.html", code=404, message="页面不存在"), 404

    return app
