"""Shared JSON event logging for the Python AES services."""
import json
import logging
import os
import time
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

_writers = {}


class PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        fd = os.open(self.baseFilename, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        return os.fdopen(fd, "a", encoding="utf-8")


def emit(service, event, channel="operations", **fields):
    # Callers pass identifiers and outcomes only, never bodies, tokens or queries.
    try:
        if not all(s.replace("-", "").isalnum() for s in (service, channel)):
            raise ValueError("Invalid log name")
        root = Path(os.environ.get("AES_LOG_ROOT", Path(__file__).resolve().parents[1] / "logs"))
        key = (str(root), service, channel, os.getpid())
        if key not in _writers:
            directory = root / channel
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            file = directory / f"{service}-{os.getpid()}.jsonl"
            fd = os.open(file, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            os.close(fd)
            writer = logging.Logger("aes." + service)
            writer.addHandler(PrivateRotatingHandler(file, maxBytes=20 * 1024 * 1024, backupCount=9, encoding="utf-8"))
            _writers[key] = writer
        record = dict(fields, schemaVersion=1, time=datetime.now(timezone.utc).isoformat(), service=service, event=event, pid=os.getpid())
        _writers[key].info(json.dumps(record, ensure_ascii=False))
    except Exception:
        # Logging must not prevent students from submitting their work.
        logging.getLogger("aes.logging").error("AES event log write failed")


def register_request_logging(app, service):
    from flask import g, request, session

    @app.before_request
    def begin_request_log():
        g.aes_request_started = time.monotonic()
        g.aes_actor_before = session.get("user_id") or (session.get("slideshow_user") or {}).get("external_id")

    @app.after_request
    def finish_request_log(response):
        actor = session.get("user_id") or (session.get("slideshow_user") or {}).get("external_id") or getattr(g, "aes_actor_before", None)
        route = request.url_rule.rule if request.url_rule else "<unmatched>"
        if request.endpoint != "static":
            emit(service, "http_request", route=route, action=request.endpoint, method=request.method,
                 status=response.status_code, userId=actor,
                 durationMs=round((time.monotonic() - getattr(g, "aes_request_started", time.monotonic())) * 1000, 2))
        if request.endpoint and request.endpoint.endswith("sso"):
            emit(service, "sso_login", channel="auth", userId=actor,
                 outcome="success" if getattr(g, "aes_sso_success", False) else "failure")
        if request.endpoint and request.endpoint.endswith("logout"):
            emit(service, "logout", channel="auth", userId=actor, status=response.status_code)
        return response
