import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aes_logging import emit, register_request_logging
from flask import Flask, g, session


class LoggingTests(unittest.TestCase):
    def test_route_logging_excludes_tokens_and_request_bodies(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AES_LOG_ROOT": directory}):
            app = Flask(__name__)
            app.secret_key = "test-only"
            register_request_logging(app, "homeworks")

            @app.post("/sso")
            def sso():
                session["user_id"] = 7
                g.aes_sso_success = True
                return "ok"

            app.test_client().post("/sso?token=SECRET-TOKEN", json={"password": "SECRET-PASSWORD"})
            files = list(Path(directory).rglob("*.jsonl"))
            self.assertEqual(len(files), 2)
            self.assertNotIn("SECRET", "".join(f.read_text() for f in files))
            for file in files:
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            event = json.loads(next(Path(directory, "auth").glob("*.jsonl")).read_text())
            self.assertEqual(event["userId"], 7)
            self.assertEqual(event["outcome"], "success")

    def test_logging_failure_does_not_break_caller(self):
        with tempfile.NamedTemporaryFile() as file, patch.dict(os.environ, {"AES_LOG_ROOT": file.name}):
            emit("homeworks", "test")


if __name__ == "__main__":
    unittest.main()
