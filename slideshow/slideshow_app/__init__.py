import os

from flask import Flask, g, render_template
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config

from .auth import csrf_token, current_user, load_current_user, validate_csrf
from .database import init_db


def create_app(config_object=Config):
    app = Flask(__name__)
    app.config.from_object(config_object)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    os.makedirs(app.config["UPLOAD_DIR"], exist_ok=True)
    init_db(app)

    app.before_request(load_current_user)
    app.before_request(validate_csrf)

    from .routes import bp
    app.register_blueprint(bp)

    @app.context_processor
    def inject_globals():
        return {"current_user": current_user(), "csrf_token": csrf_token}

    @app.errorhandler(403)
    def forbidden(_error):
        return render_template("error.html", code=403, message="没有权限访问该演示文稿。"), 403

    @app.errorhandler(404)
    def not_found(_error):
        return render_template("error.html", code=404, message="演示文稿不存在或你无权查看。"), 404

    @app.errorhandler(413)
    def too_large(_error):
        return render_template("error.html", code=413, message="PPT 文件超过 80 MB 上传限制。"), 413

    return app
