import io
import os
import shutil
import tempfile
import unittest
import zipfile

import jwt

from config import Config
from app import create_app
from app.database import db_session
from app.models import (
    Assignment,
    Chapter,
    Class,
    Course,
    InviteCode,
    Question,
    User,
    UserClassRole,
)


class TeacherChapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-teacher-chapters-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "teacher-chapter-test-secret"
            SSO_JWT_SECRET = "teacher-chapter-sso-secret"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")
            SOURCE_QUESTION_BANK_DIR = cls.root

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            own_course = Course(
                name="同名课程",
                owner_external_id="teacher-one",
            )
            other_course = Course(
                name="同名课程",
                owner_external_id="teacher-two",
            )
            second_own_course = Course(
                name="教师一第二门课程",
                owner_external_id="teacher-one",
            )
            db_session.add_all([own_course, other_course, second_own_course])
            db_session.flush()
            own_class = Class(
                name="教师一班级",
                course_id=own_course.id,
                capacity=50,
                current_count=0,
                enabled=True,
            )
            other_class = Class(
                name="教师二班级",
                course_id=other_course.id,
                capacity=50,
                current_count=0,
                enabled=True,
            )
            second_own_class = Class(
                name="教师一第二班级",
                course_id=second_own_course.id,
                capacity=50,
                current_count=0,
                enabled=True,
            )
            db_session.add_all([own_class, other_class, second_own_class])
            db_session.flush()
            teacher = User(
                external_id="teacher-one",
                email="teacher-one@example.com",
                password_hash="unused",
                name="教师一",
                role="teacher",
                class_id=own_class.id,
                enabled=True,
            )
            db_session.add(teacher)
            db_session.flush()
            db_session.add_all([
                UserClassRole(
                    user_id=teacher.id,
                    class_id=own_class.id,
                    role_in_class="teacher",
                ),
                UserClassRole(
                    user_id=teacher.id,
                    class_id=second_own_class.id,
                    role_in_class="teacher",
                ),
                InviteCode(
                    code="TEACHER-ONE-001",
                    level="level_2",
                    class_id=own_class.id,
                    course_name=own_course.name,
                    class_name=own_class.name,
                ),
                InviteCode(
                    code="TEACHER-ONE-002",
                    level="level_2",
                    class_id=second_own_class.id,
                    course_name=second_own_course.name,
                    class_name=second_own_class.name,
                ),
            ])
            own_marker_chapter = Chapter(
                course_id=own_course.id,
                chapter_number=9,
                title="第一班级课程章节",
            )
            second_own_chapter = Chapter(
                course_id=second_own_course.id,
                chapter_number=1,
                title="第二班级课程章节",
            )
            other_chapter = Chapter(
                course_id=other_course.id,
                chapter_number=1,
                title="其他教师章节",
            )
            db_session.add_all([own_marker_chapter, second_own_chapter, other_chapter])
            db_session.commit()
            cls.teacher_id = teacher.id
            cls.own_class_id = own_class.id
            cls.own_course_id = own_course.id
            cls.own_marker_chapter_id = own_marker_chapter.id
            cls.second_own_class_id = second_own_class.id
            cls.second_own_course_id = second_own_course.id
            cls.second_own_chapter_id = second_own_chapter.id
            cls.other_course_id = other_course.id
            cls.other_chapter_id = other_chapter.id

    @classmethod
    def tearDownClass(cls):
        db_session.remove()
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.client = self.app.test_client()
        with self.client.session_transaction() as session:
            session["user_id"] = self.teacher_id
            session["current_class_id"] = self.own_class_id
            session["_csrf_token"] = "test-csrf"

    def _sso_token(self, class_invite_code):
        return jwt.encode(
            {
                "sub": "teacher-one",
                "email": "teacher-one@example.com",
                "role": "teacher",
                "purpose": "homeworks_sso",
                "classInviteCode": class_invite_code,
            },
            self.app.config["SSO_JWT_SECRET"],
            algorithm="HS256",
        )

    def test_question_bank_follows_current_class_from_sso(self):
        response = self.client.get(f"/sso?token={self._sso_token('TEACHER-ONE-002')}")
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as session:
            self.assertEqual(session["current_class_id"], self.second_own_class_id)

        response = self.client.get(
            "/teacher/chapters",
            query_string={"course_id": self.own_course_id},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("教师一第二班级".encode(), response.data)
        self.assertIn("第二班级课程章节".encode(), response.data)
        self.assertNotIn("第一班级课程章节".encode(), response.data)
        self.assertNotIn("教师一第二门课程</option>".encode(), response.data)
        self.assertEqual(
            self.client.get(
                f"/teacher/chapters/{self.own_marker_chapter_id}/questions"
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.get(
                f"/teacher/chapters/{self.second_own_chapter_id}/questions"
            ).status_code,
            200,
        )

        self.client.get(f"/sso?token={self._sso_token('TEACHER-ONE-001')}")
        response = self.client.get("/teacher/chapters")
        self.assertIn("教师一班级".encode(), response.data)
        self.assertIn("第一班级课程章节".encode(), response.data)
        self.assertNotIn("第二班级课程章节".encode(), response.data)

    def test_existing_session_uses_synced_current_class(self):
        with self.client.session_transaction() as session:
            session.pop("current_class_id", None)
        response = self.client.get("/teacher/chapters")
        self.assertEqual(response.status_code, 200)
        self.assertIn("教师一班级".encode(), response.data)
        self.assertIn("第一班级课程章节".encode(), response.data)
        self.assertNotIn("第二班级课程章节".encode(), response.data)
        with self.client.session_transaction() as session:
            self.assertEqual(session["current_class_id"], self.own_class_id)

    def test_teacher_manages_only_own_course_chapters_and_questions(self):
        response = self.client.get("/teacher/chapters")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("其他教师章节".encode(), response.data)

        response = self.client.post(
            f"/teacher/courses/{self.own_course_id}/chapters",
            data={"_csrf": "test-csrf", "chapter_number": "1", "title": "新章节"},
        )
        self.assertEqual(response.status_code, 302)

        with self.app.app_context():
            chapter = db_session.query(Chapter).filter_by(
                course_id=self.own_course_id,
                chapter_number=1,
            ).one()
            chapter_id = chapter.id

        markdown = (
            "# 新章节\n\n"
            "## 一、选择题\n\n"
            "1. 选择题题干\n\nA. 选项一\nB. 选项二\n\n"
            "## 二、简答题\n\n"
            "1. 简答题题干\n\n"
            "## 三、综合题\n\n"
            "1. 综合题题干\n\n![结构图](images/diagram.png)\n"
        )
        archive_buffer = io.BytesIO()
        with zipfile.ZipFile(archive_buffer, "w") as archive:
            archive.writestr("chapter/chapter.md", markdown)
            archive.writestr("chapter/images/diagram.png", b"test-image")
        archive_buffer.seek(0)
        response = self.client.post(
            f"/teacher/chapters/{chapter_id}/questions",
            data={
                "_csrf": "test-csrf",
                "question_bank": (archive_buffer, "chapter.zip"),
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 302)
        response_without_prefix = self.client.get(
            f"/teacher/chapters/{chapter_id}/questions"
        )
        self.assertIn(
            f'src="/chapter-images/{chapter_id}/images/diagram.png"'.encode(),
            response_without_prefix.data,
        )

        response = self.client.get(
            f"/teacher/chapters/{chapter_id}/questions",
            headers={"X-Forwarded-Prefix": "/homeworks"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("选择题题干".encode(), response.data)
        self.assertLess(response.data.index("选择题题干".encode()), response.data.index("简答题题干".encode()))
        self.assertLess(response.data.index("简答题题干".encode()), response.data.index("综合题题干".encode()))
        self.assertIn(
            f'src="/homeworks/chapter-images/{chapter_id}/images/diagram.png"'.encode(),
            response.data,
        )
        self.assertTrue(os.path.isfile(os.path.join(
            self.app.config["CHAPTER_UPLOAD_DIR"],
            str(chapter_id),
            "images",
            "diagram.png",
        )))
        image_response = self.client.get(
            f"/chapter-images/{chapter_id}/images/diagram.png",
            headers={"X-Forwarded-Prefix": "/homeworks"},
        )
        self.assertEqual(image_response.status_code, 200)
        self.assertEqual(image_response.data, b"test-image")
        image_response.close()
        with self.app.app_context():
            self.assertEqual(
                db_session.query(Question).filter_by(chapter_id=chapter_id).count(),
                3,
            )
            self.assertEqual(
                [
                    question.type
                    for question in db_session.query(Question)
                    .filter_by(chapter_id=chapter_id)
                    .order_by(Question.id)
                    .all()
                ],
                ["choice", "short_answer", "comprehensive"],
            )

        response = self.client.get(
            "/teacher/assignments/new",
            query_string={
                "chapter_id": chapter_id,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("教师一班级".encode(), response.data)
        self.assertIn("同名课程".encode(), response.data)
        self.assertNotIn(b'name="class_id"', response.data)
        self.assertNotIn(b'name="course_id"', response.data)
        self.assertLess(response.data.index("选择题题干".encode()), response.data.index("简答题题干".encode()))
        self.assertLess(response.data.index("简答题题干".encode()), response.data.index("综合题题干".encode()))

        self.assertEqual(
            self.client.get(
                f"/teacher/chapters/{self.other_chapter_id}/questions"
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/teacher/courses/{self.other_course_id}/chapters",
                data={"_csrf": "test-csrf", "chapter_number": "2"},
            ).status_code,
            403,
        )

        response = self.client.get(
            "/teacher/assignments/new",
            query_string={
                "class_id": self.second_own_class_id,
                "course_id": self.second_own_course_id,
                "chapter_id": self.second_own_chapter_id,
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("教师一班级".encode(), response.data)
        self.assertNotIn("教师一第二班级".encode(), response.data)
        self.assertNotIn("第二班级课程章节".encode(), response.data)

        with self.app.app_context():
            question_id = (
                db_session.query(Question.id)
                .filter_by(chapter_id=chapter_id)
                .order_by(Question.id)
                .first()[0]
            )
        response = self.client.post(
            "/teacher/assignments",
            data={
                "_csrf": "test-csrf",
                "class_id": self.second_own_class_id,
                "course_id": self.second_own_course_id,
                "chapter_id": chapter_id,
                "title": "当前班级绑定测试",
                "question_ids": [question_id],
                "action": "draft",
            },
        )
        self.assertEqual(response.status_code, 302)
        with self.app.app_context():
            assignment = db_session.query(Assignment).filter_by(
                title="当前班级绑定测试"
            ).one()
            self.assertEqual(assignment.class_id, self.own_class_id)
            self.assertEqual(assignment.course_id, self.own_course_id)


if __name__ == "__main__":
    unittest.main()
