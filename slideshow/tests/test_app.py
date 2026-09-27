import io
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import jwt

from config import Config
from slideshow_app import create_app
from slideshow_app.ai_chat import SlideAiError


class SlideshowAppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="slideshow-app-")
        cls.accounts_db = os.path.join(cls.root, "accounts.db")
        cls.courses_db = os.path.join(cls.root, "courses.db")
        with sqlite3.connect(cls.accounts_db) as db:
            db.executescript("""
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY, external_id TEXT, email TEXT,
                    class_id INTEGER, enabled INTEGER
                );
                INSERT INTO users VALUES (1, 'teacher-1', 'teacher@example.com', 10, 1);
                INSERT INTO users VALUES (2, 'student-1', 'student@example.com', 10, 1);
                INSERT INTO users VALUES (3, 'student-2', 'other@example.com', 20, 1);
            """)
        with sqlite3.connect(cls.courses_db) as db:
            db.executescript("""
                CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT, owner_external_id TEXT);
                CREATE TABLE classes (id INTEGER PRIMARY KEY, name TEXT, course_id INTEGER, enabled INTEGER);
                INSERT INTO courses VALUES (1, '操作系统', 'teacher-1');
                INSERT INTO courses VALUES (2, '计算机网络', 'teacher-2');
                INSERT INTO courses VALUES (3, '编译原理', 'teacher-1');
                INSERT INTO classes VALUES (10, '计科一班', 1, 1);
                INSERT INTO classes VALUES (20, '计科二班', 2, 1);
                INSERT INTO classes VALUES (30, '计科三班', 3, 1);
            """)

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "slideshow-test-session-secret"
            SSO_JWT_SECRET = "slideshow-test-jwt-secret"
            SERVICE_PORTAL_URL = "/portal"
            APPLICATION_ROOT = "/"
            SESSION_COOKIE_PATH = "/"
            DATABASE = os.path.join(cls.root, "slideshow.db")
            ACCOUNT_DATABASE = cls.accounts_db
            COURSE_DATABASE = cls.courses_db
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            AI_PROVIDER = "mock"

        cls.app = create_app(TestConfig)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def token(self, external_id, email, role):
        return jwt.encode(
            {
                "sub": external_id,
                "email": email,
                "name": email.split("@", 1)[0],
                "role": role,
                "purpose": "service_sso",
                "service": "slideshow",
            },
            self.app.config["SSO_JWT_SECRET"],
            algorithm="HS256",
        )

    def login(self, client, external_id, email, role):
        response = client.get(f"/sso?token={self.token(external_id, email, role)}")
        self.assertEqual(response.status_code, 302)
        with client.session_transaction() as session:
            return session["_csrf_token"]

    def test_unauthenticated_requests_do_not_expose_presentations(self):
        client = self.app.test_client()
        self.assertEqual(client.get("/").headers["Location"], "/portal")
        self.assertEqual(client.get("/api/presentations").status_code, 401)

    @patch(
        "slideshow_app.routes.open_slide_chat_stream",
        side_effect=SlideAiError("今日班级 AI Token 配额已用完。", 429),
    )
    @patch("slideshow_app.routes.get_presentation")
    def test_ai_chat_relays_class_quota_errors(self, get_presentation, _open_stream):
        get_presentation.return_value = {
            "id": "quota-deck",
            "title": "配额测试课件",
            "class_name": "计科一班",
            "course_name": "操作系统",
            "slide_count": 1,
            "slides": [{
                "slide_index": 0,
                "image_filename": "001.jpg",
                "extracted_text": "进程管理",
            }],
        }
        student = self.app.test_client()
        csrf = self.login(student, "student-1", "student@example.com", "student")
        response = student.post(
            "/api/presentations/quota-deck/chat/stream",
            json={"message": "解释这一页", "slideIndex": 0, "history": []},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.get_json()["message"], "今日班级 AI Token 配额已用完。")

    @patch("slideshow_app.routes.PresentationConverter.convert")
    def test_teacher_upload_student_access_and_ai_chat(self, convert):
        def fake_convert(_source, presentation_dir):
            slides_dir = Path(presentation_dir) / "slides"
            slides_dir.mkdir()
            (slides_dir / "001.jpg").write_bytes(b"first-slide")
            (slides_dir / "002.jpg").write_bytes(b"second-slide")
            return [
                {"index": 0, "image_filename": "001.jpg", "text": "进程是资源分配的基本单位"},
                {"index": 1, "image_filename": "002.jpg", "text": "线程是调度的基本单位"},
            ]

        convert.side_effect = fake_convert
        teacher = self.app.test_client()
        csrf = self.login(teacher, "teacher-1", "teacher@example.com", "teacher")
        upload = teacher.post(
            "/presentations",
            data={
                "_csrf": csrf,
                "title": "进程与线程",
                "class_id": "10",
                "presentation": (io.BytesIO(b"fake-pptx"), "课程课件.pptx"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(upload.status_code, 302)
        presentation_id = upload.headers["Location"].rstrip("/").split("/")[-1]
        teacher_viewer = teacher.get(upload.headers["Location"])
        self.assertEqual(teacher_viewer.status_code, 200)
        self.assertNotIn(b"student-chat-collapsible", teacher_viewer.data)

        student = self.app.test_client()
        student_csrf = self.login(student, "student-1", "student@example.com", "student")
        listing = student.get("/api/presentations").get_json()
        self.assertEqual([item["id"] for item in listing["presentations"]], [presentation_id])
        detail = student.get(f"/api/presentations/{presentation_id}").get_json()
        self.assertEqual(detail["slideCount"], 2)
        student_viewer = student.get(f"/presentations/{presentation_id}")
        self.assertIn(b"student-chat-collapsible", student_viewer.data)
        self.assertIn(b'id="chat-open-button"', student_viewer.data)
        image_response = student.get(detail["slides"][0]["imageUrl"])
        self.assertEqual(image_response.data, b"first-slide")
        image_response.close()

        chat = student.post(
            f"/api/presentations/{presentation_id}/chat/stream",
            json={"message": "解释这一页", "slideIndex": 0, "history": []},
            headers={"X-CSRF-Token": student_csrf},
        )
        self.assertEqual(chat.status_code, 200)
        self.assertIn("第 1 页".encode(), chat.data)

        outsider = self.app.test_client()
        self.login(outsider, "student-2", "other@example.com", "student")
        self.assertEqual(outsider.get(f"/api/presentations/{presentation_id}").status_code, 404)

    def test_missing_presentation_returns_404(self):
        client = self.app.test_client()
        self.login(client, "student-1", "student@example.com", "student")
        self.assertEqual(client.get("/api/presentations/missing").status_code, 404)

    def test_teacher_presentations_follow_current_class(self):
        now = "2026-09-15T12:00:00+00:00"
        with sqlite3.connect(self.app.config["DATABASE"]) as database:
            database.executemany(
                """
                INSERT OR REPLACE INTO presentations (
                    id, title, original_filename, owner_external_id, class_id,
                    class_name, course_name, content_sha256, slide_count,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, 'teacher-1', ?, ?, ?, ?, 0, 'ready', ?, ?)
                """,
                [
                    ("current-class-deck", "当前班课件", "current.pptx", 10, "计科一班", "操作系统", "hash-current", now, now),
                    ("other-class-deck", "其他班课件", "other.pptx", 30, "计科三班", "编译原理", "hash-other", now, now),
                ],
            )

        teacher = self.app.test_client()
        self.login(teacher, "teacher-1", "teacher@example.com", "teacher")
        ids = {item["id"] for item in teacher.get("/api/presentations").get_json()["presentations"]}
        self.assertIn("current-class-deck", ids)
        self.assertNotIn("other-class-deck", ids)
        self.assertEqual(teacher.get("/presentations/other-class-deck").status_code, 404)

        try:
            with sqlite3.connect(self.accounts_db) as database:
                database.execute("UPDATE users SET class_id = 30 WHERE external_id = 'teacher-1'")
            ids = {item["id"] for item in teacher.get("/api/presentations").get_json()["presentations"]}
            self.assertNotIn("current-class-deck", ids)
            self.assertIn("other-class-deck", ids)
            self.assertEqual(teacher.get("/presentations/current-class-deck").status_code, 404)
        finally:
            with sqlite3.connect(self.accounts_db) as database:
                database.execute("UPDATE users SET class_id = 10 WHERE external_id = 'teacher-1'")
            with sqlite3.connect(self.app.config["DATABASE"]) as database:
                database.execute(
                    "DELETE FROM presentations WHERE id IN ('current-class-deck', 'other-class-deck')"
                )

    @patch("slideshow_app.routes.PresentationConverter.convert")
    def test_only_uploader_can_delete_presentation_and_files(self, convert):
        def fake_convert(_source, presentation_dir):
            slides_dir = Path(presentation_dir) / "slides"
            slides_dir.mkdir()
            (slides_dir / "001.jpg").write_bytes(b"slide")
            return [{"index": 0, "image_filename": "001.jpg", "text": "测试页面"}]

        convert.side_effect = fake_convert
        teacher = self.app.test_client()
        teacher_csrf = self.login(
            teacher, "teacher-1", "teacher@example.com", "teacher"
        )
        upload = teacher.post(
            "/presentations",
            data={
                "_csrf": teacher_csrf,
                "title": "待删除课件",
                "class_id": "10",
                "presentation": (io.BytesIO(b"delete-me"), "待删除.pptx"),
            },
            content_type="multipart/form-data",
        )
        presentation_id = upload.headers["Location"].rstrip("/").split("/")[-1]
        presentation_dir = Path(self.app.config["UPLOAD_DIR"]) / "presentations" / presentation_id

        teacher_index = teacher.get("/")
        self.assertIn(
            f'/presentations/{presentation_id}/delete'.encode(), teacher_index.data
        )

        student = self.app.test_client()
        student_csrf = self.login(
            student, "student-1", "student@example.com", "student"
        )
        self.assertNotIn(
            f'/presentations/{presentation_id}/delete'.encode(), student.get("/").data
        )
        forbidden = student.post(
            f"/presentations/{presentation_id}/delete",
            data={"_csrf": student_csrf},
        )
        self.assertEqual(forbidden.status_code, 403)
        self.assertTrue(presentation_dir.exists())

        other_teacher = self.app.test_client()
        other_csrf = self.login(
            other_teacher, "teacher-2", "other-teacher@example.com", "teacher"
        )
        hidden = other_teacher.post(
            f"/presentations/{presentation_id}/delete",
            data={"_csrf": other_csrf},
        )
        self.assertEqual(hidden.status_code, 404)
        self.assertTrue(presentation_dir.exists())

        deleted = teacher.post(
            f"/presentations/{presentation_id}/delete",
            data={"_csrf": teacher_csrf},
            follow_redirects=True,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertIn("已删除".encode(), deleted.data)
        self.assertFalse(presentation_dir.exists())
        with sqlite3.connect(self.app.config["DATABASE"]) as database:
            presentation_count = database.execute(
                "SELECT COUNT(*) FROM presentations WHERE id = ?", (presentation_id,)
            ).fetchone()[0]
            slide_count = database.execute(
                "SELECT COUNT(*) FROM slides WHERE presentation_id = ?", (presentation_id,)
            ).fetchone()[0]
        self.assertEqual(presentation_count, 0)
        self.assertEqual(slide_count, 0)


if __name__ == "__main__":
    unittest.main()
