import os
import shutil
import tempfile
import unittest

import jwt

from app import create_app
from app.database import db_session
from app.models import User
from config import Config


class UnifiedAuthenticationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-unified-auth-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "homeworks-auth-test-secret"
            SSO_JWT_SECRET = "homeworks-sso-test-secret"
            SERVICE_PORTAL_URL = "/portal"
            COURSEWORKS_REGISTER_URL = "/?register=1"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            student = User(
                external_id="courseworks-student-id",
                email="student@example.com",
                password_hash="not-used-for-homeworks-login",
                name="学生",
                role="student",
                enabled=True,
            )
            db_session.add(student)
            old_admin = User(
                external_id="retired-superuser-id",
                email="retired-admin@example.com",
                password_hash="not-used-for-homeworks-login",
                name="旧管理员",
                role="super_admin",
                enabled=True,
            )
            db_session.add(old_admin)
            db_session.commit()
            cls.student_id = student.id
            cls.old_admin_id = old_admin.id

    @classmethod
    def tearDownClass(cls):
        db_session.remove()
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.client = self.app.test_client()

    def test_unauthenticated_homeworks_requests_return_to_portal(self):
        for path in ("/", "/login", "/student/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 302)
                self.assertEqual(response.headers["Location"], "/portal")

    def test_local_login_post_never_authenticates(self):
        with self.client.session_transaction() as session:
            session["_csrf_token"] = "test-csrf"
        response = self.client.post(
            "/login",
            data={
                "_csrf": "test-csrf",
                "email": "student@example.com",
                "password": "any-password",
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/portal")
        with self.client.session_transaction() as session:
            self.assertNotIn("user_id", session)

    def test_registration_is_owned_by_the_unified_portal(self):
        response = self.client.get("/register")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/?register=1")

    def test_signed_sso_token_is_the_only_login_path(self):
        token = jwt.encode(
            {
                "sub": "courseworks-student-id",
                "email": "student@example.com",
                "role": "student",
                "purpose": "homeworks_sso",
            },
            self.app.config["SSO_JWT_SECRET"],
            algorithm="HS256",
        )
        response = self.client.get(f"/sso?token={token}")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/student/")
        with self.client.session_transaction() as session:
            self.assertEqual(session["user_id"], self.student_id)

    def test_invalid_sso_token_returns_to_portal(self):
        response = self.client.get("/sso?token=invalid")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/portal")

    def test_retired_superuser_session_is_rejected(self):
        with self.client.session_transaction() as session:
            session["user_id"] = self.old_admin_id
        response = self.client.get("/")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/portal")
        with self.client.session_transaction() as session:
            self.assertNotIn("user_id", session)

    def test_retired_superuser_sso_is_rejected(self):
        token = jwt.encode(
            {
                "sub": "retired-superuser-id",
                "email": "retired-admin@example.com",
                "role": "super_admin",
                "purpose": "homeworks_sso",
            },
            self.app.config["SSO_JWT_SECRET"],
            algorithm="HS256",
        )
        response = self.client.get(f"/sso?token={token}")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/portal")


if __name__ == "__main__":
    unittest.main()
