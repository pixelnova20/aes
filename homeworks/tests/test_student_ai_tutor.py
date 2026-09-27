import os
import io
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch

import jwt

from app import create_app
from app.ai_tutor import (
    AiTutorError,
    _ai_tutor_request,
    build_question_context,
    build_review_context,
)
from app.database import db_session
from app.models import (
    Assignment,
    AssignmentQuestion,
    AssignmentQuestionOption,
    Answer,
    Chapter,
    Class,
    Course,
    Grade,
    Submission,
    User,
    UserClassRole,
)
from config import Config


class StudentAiTutorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-student-ai-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "student-ai-test-secret"
            SSO_JWT_SECRET = "student-ai-jwt-secret-long-enough"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            course = Course(name="操作系统", owner_external_id="teacher-id")
            db_session.add(course)
            db_session.flush()
            chapter = Chapter(course_id=course.id, chapter_number=3, title="内存管理")
            klass = Class(name="计科一班", course_id=course.id, enabled=True)
            teacher = User(
                external_id="teacher-id",
                email="teacher@example.com",
                password_hash="unused",
                name="教师",
                role="teacher",
                enabled=True,
            )
            student = User(
                external_id="student-courseworks-id",
                email="student@example.com",
                password_hash="unused",
                name="学生",
                role="student",
                enabled=True,
            )
            db_session.add_all([chapter, klass, teacher, student])
            db_session.flush()
            db_session.add(UserClassRole(
                user_id=student.id,
                class_id=klass.id,
                role_in_class="student",
            ))
            assignment = Assignment(
                title="分页作业",
                course_id=course.id,
                chapter_id=chapter.id,
                class_id=klass.id,
                publisher_id=teacher.id,
                status="published",
            )
            db_session.add(assignment)
            db_session.flush()
            question = AssignmentQuestion(
                assignment_id=assignment.id,
                sort_order=0,
                question_number=2,
                type="choice",
                stem_markdown="虚拟地址由哪两部分组成？",
                stem_html="<p>虚拟地址由哪两部分组成？</p>",
            )
            db_session.add(question)
            db_session.flush()
            db_session.add_all([
                AssignmentQuestionOption(
                    assignment_question_id=question.id,
                    label="A",
                    content_markdown="页号和页内偏移",
                    content_html="页号和页内偏移",
                    sort_order=0,
                ),
                AssignmentQuestionOption(
                    assignment_question_id=question.id,
                    label="B",
                    content_markdown="段号和页号",
                    content_html="段号和页号",
                    sort_order=1,
                ),
            ])
            db_session.commit()
            cls.student_id = student.id
            cls.assignment_id = assignment.id
            cls.question_id = question.id

    @classmethod
    def tearDownClass(cls):
        db_session.remove()
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.client = self.app.test_client()
        with self.client.session_transaction() as session:
            session["user_id"] = self.student_id
            session["_csrf_token"] = "test-csrf"

    def test_answer_page_has_ai_button_and_prefixed_chat_url(self):
        response = self.client.get(
            f"/student/assignments/{self.assignment_id}",
            headers={"X-Forwarded-Prefix": "/homeworks"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("问 AI".encode(), response.data)
        self.assertIn(b"vendor/marked.umd.js", response.data)
        self.assertIn(b"vendor/purify.min.js", response.data)
        self.assertIn(b"renderAssistantMarkdown", response.data)
        self.assertIn(
            f'/homeworks/student/assignments/{self.assignment_id}/questions/{self.question_id}/ai-chat/stream'.encode(),
            response.data,
        )

    def test_logout_clears_homeworks_session_and_returns_to_portal(self):
        response = self.client.post(
            "/logout",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/portal")
        with self.client.session_transaction() as session:
            self.assertNotIn("user_id", session)

    @patch("app.blueprints.student.open_ai_tutor_stream")
    def test_streaming_chat_relays_ndjson_without_buffering(self, open_stream):
        open_stream.return_value = io.BytesIO(
            b'{"delta":"first"}\n{"delta":" second"}\n{"done":true}\n'
        )
        response = self.client.post(
            f"/student/assignments/{self.assignment_id}/questions/{self.question_id}/ai-chat/stream",
            json={"prompt": "给我第一步提示", "history": []},
            headers={"X-CSRF-Token": "test-csrf"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.data,
            b'{"delta":"first"}\n{"delta":" second"}\n{"done":true}\n',
        )
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")

    @patch(
        "app.blueprints.student.open_ai_tutor_stream",
        side_effect=AiTutorError("今日班级 AI Token 配额已用完。", 429),
    )
    def test_streaming_chat_relays_class_quota_errors(self, _open_stream):
        response = self.client.post(
            f"/student/assignments/{self.assignment_id}/questions/{self.question_id}/ai-chat/stream",
            json={"prompt": "再给我一个提示", "history": []},
            headers={"X-CSRF-Token": "test-csrf"},
        )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.get_json()["error"], "今日班级 AI Token 配额已用完。")

    @patch("app.blueprints.student.ask_ai_tutor", return_value="先回忆页表项的作用。")
    def test_chat_uses_authorized_assignment_question(self, ask_ai_tutor):
        response = self.client.post(
            f"/student/assignments/{self.assignment_id}/questions/{self.question_id}/ai-chat",
            json={"prompt": "我应该从哪里开始？", "history": []},
            headers={"X-CSRF-Token": "test-csrf"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["answer"], "先回忆页表项的作用。")
        self.assertEqual(ask_ai_tutor.call_args.args[3].id, self.question_id)
        with self.app.app_context():
            assignment = db_session.get(Assignment, self.assignment_id)
            question = db_session.get(AssignmentQuestion, self.question_id)
            context = build_question_context(assignment, question)
        self.assertIn("虚拟地址由哪两部分组成？", context)
        self.assertIn("A. 页号和页内偏移", context)
        self.assertIn("B. 段号和页号", context)

    @patch("app.blueprints.student.ask_ai_tutor", return_value="正确答案是 B。")
    def test_graded_chat_uses_signed_review_mode_and_feedback(self, ask_ai_tutor):
        with self.app.app_context():
            submission = db_session.query(Submission).filter_by(
                assignment_id=self.assignment_id,
                student_id=self.student_id,
            ).first()
            if submission is None:
                submission = Submission(
                    assignment_id=self.assignment_id,
                    student_id=self.student_id,
                )
                db_session.add(submission)
                db_session.flush()
            submission.status = "graded"
            answer = db_session.query(Answer).filter_by(
                submission_id=submission.id,
                assignment_question_id=self.question_id,
            ).first()
            if answer is None:
                answer = Answer(
                    submission_id=submission.id,
                    assignment_question_id=self.question_id,
                )
                db_session.add(answer)
            answer.choice_answer = "A"
            answer.grader_comment = "正确答案是 B。"
            grade = Grade(
                submission_id=submission.id,
                grader_id=1,
                score=80,
                comment="请复习地址转换。",
                status="submitted",
            )
            db_session.add(grade)
            db_session.commit()

            user = db_session.get(User, self.student_id)
            assignment = db_session.get(Assignment, self.assignment_id)
            question = db_session.get(AssignmentQuestion, self.question_id)
            review_context = build_review_context(question, answer, grade)
            ai_request = _ai_tutor_request(
                self.app.config,
                user,
                assignment,
                question,
                "为什么是 B？",
                [],
                review_context=review_context,
            )
            token = ai_request.get_header("Authorization").removeprefix("Bearer ")
            claims = jwt.decode(
                token,
                self.app.config["SSO_JWT_SECRET"],
                algorithms=["HS256"],
            )
            payload = json.loads(ai_request.data.decode("utf-8"))

        self.assertEqual(claims["purpose"], "homeworks_ai_tutor")
        self.assertEqual(claims["homeworkTutorMode"], "review")
        self.assertEqual(payload["reviewContext"], review_context)
        self.assertIn("学生本题作答：A", review_context)
        self.assertIn("教师本题批注：正确答案是 B。", review_context)
        self.assertIn("本次作业总分：80", review_context)

        response = self.client.post(
            f"/student/assignments/{self.assignment_id}/questions/{self.question_id}/ai-chat",
            json={"prompt": "为什么是 B？", "history": []},
            headers={"X-CSRF-Token": "test-csrf"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            ask_ai_tutor.call_args.kwargs["review_context"], review_context
        )
        answer_page = self.client.get(
            f"/student/assignments/{self.assignment_id}"
        )
        self.assertIn("AI 作业复盘".encode(), answer_page.data)
        self.assertIn("询问答案、教师批注或解题过程".encode(), answer_page.data)

        with self.app.app_context():
            grade = db_session.query(Grade).filter_by(
                submission_id=submission.id
            ).one()
            answer = db_session.query(Answer).filter_by(
                submission_id=submission.id,
                assignment_question_id=self.question_id,
            ).one()
            submission = db_session.get(Submission, submission.id)
            db_session.delete(grade)
            answer.choice_answer = None
            answer.grader_comment = None
            submission.status = "not_started"
            db_session.commit()

    @patch("app.blueprints.student.ask_ai_tutor")
    def test_chat_rejects_question_outside_assignment(self, ask_ai_tutor):
        response = self.client.post(
            f"/student/assignments/{self.assignment_id}/questions/999999/ai-chat",
            json={"prompt": "给我提示", "history": []},
            headers={"X-CSRF-Token": "test-csrf"},
        )
        self.assertEqual(response.status_code, 404)
        ask_ai_tutor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
