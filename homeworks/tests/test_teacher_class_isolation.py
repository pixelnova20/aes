import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta

from app import create_app
from app.database import db_session
from app.models import Assignment, Chapter, Class, Course, User, UserClassRole
from config import Config


class TeacherCurrentClassIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-teacher-class-isolation-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "teacher-class-isolation-secret"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            old_course = Course(name="旧课程", owner_external_id="teacher-isolation")
            current_course = Course(name="当前课程", owner_external_id="teacher-isolation")
            db_session.add_all([old_course, current_course])
            db_session.flush()
            old_class = Class(name="旧班级", course_id=old_course.id, enabled=True)
            current_class = Class(name="当前班级", course_id=current_course.id, enabled=True)
            old_chapter = Chapter(course_id=old_course.id, chapter_number=1)
            current_chapter = Chapter(course_id=current_course.id, chapter_number=1)
            db_session.add_all([old_class, current_class, old_chapter, current_chapter])
            db_session.flush()
            teacher = User(
                external_id="teacher-isolation",
                email="isolation@example.com",
                password_hash="unused",
                name="隔离测试教师",
                role="teacher",
                class_id=current_class.id,
                enabled=True,
            )
            db_session.add(teacher)
            db_session.flush()
            db_session.add_all([
                UserClassRole(user_id=teacher.id, class_id=old_class.id, role_in_class="teacher"),
                UserClassRole(user_id=teacher.id, class_id=current_class.id, role_in_class="teacher"),
            ])
            due_at = datetime.now() + timedelta(days=7)
            old_assignment = Assignment(
                title="旧班作业",
                course_id=old_course.id,
                chapter_id=old_chapter.id,
                class_id=old_class.id,
                publisher_id=teacher.id,
                due_at=due_at,
                status="published",
            )
            current_assignment = Assignment(
                title="当前班作业",
                course_id=current_course.id,
                chapter_id=current_chapter.id,
                class_id=current_class.id,
                publisher_id=teacher.id,
                due_at=due_at,
                status="published",
            )
            db_session.add_all([old_assignment, current_assignment])
            db_session.commit()
            cls.teacher_id = teacher.id
            cls.old_class_id = old_class.id
            cls.current_class_id = current_class.id
            cls.old_assignment_id = old_assignment.id
            cls.current_assignment_id = current_assignment.id

    @classmethod
    def tearDownClass(cls):
        db_session.remove()
        shutil.rmtree(cls.root, ignore_errors=True)

    def client(self):
        client = self.app.test_client()
        with client.session_transaction() as session:
            session["user_id"] = self.teacher_id
            session["current_class_id"] = self.current_class_id
            session["_csrf_token"] = "test-csrf"
        return client

    def test_dashboard_and_assignment_urls_use_current_class(self):
        client = self.client()
        dashboard = client.get("/teacher/")
        self.assertEqual(dashboard.status_code, 200)
        self.assertIn("当前班级".encode(), dashboard.data)
        self.assertIn("当前班作业".encode(), dashboard.data)
        self.assertNotIn("旧班级".encode(), dashboard.data)
        self.assertNotIn("旧班作业".encode(), dashboard.data)
        self.assertEqual(
            client.get(f"/teacher/assignments/{self.current_assignment_id}").status_code,
            200,
        )
        self.assertEqual(
            client.get(f"/teacher/assignments/{self.old_assignment_id}").status_code,
            403,
        )

    def test_grade_export_rejects_a_previous_class(self):
        client = self.client()
        selector = client.get("/teacher/export-grades")
        self.assertEqual(selector.status_code, 200)
        self.assertIn("当前班级".encode(), selector.data)
        self.assertNotIn("旧班级".encode(), selector.data)
        self.assertEqual(
            client.get(f"/teacher/export-grades?class_id={self.old_class_id}").status_code,
            403,
        )


if __name__ == "__main__":
    unittest.main()
