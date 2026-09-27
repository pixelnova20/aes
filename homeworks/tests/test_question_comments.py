import os
import shutil
import tempfile
import unittest

from app import create_app
from app.database import db_session
from app.models import (
    Answer,
    Assignment,
    AssignmentQuestion,
    AssignmentQuestionOption,
    Chapter,
    Class,
    Course,
    Grade,
    Submission,
    User,
    UserClassRole,
)
from config import Config


class QuestionCommentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-question-comments-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "question-comment-test-secret"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            course = Course(name="操作系统", owner_external_id="comment-teacher")
            db_session.add(course)
            db_session.flush()
            chapter = Chapter(course_id=course.id, chapter_number=1, title="概述")
            klass = Class(name="批注测试班", course_id=course.id, enabled=True)
            teacher = User(
                external_id="comment-teacher",
                email="teacher@example.com",
                password_hash="unused",
                name="教师",
                role="teacher",
                enabled=True,
            )
            student = User(
                external_id="comment-student",
                email="student@example.com",
                password_hash="unused",
                name="学生",
                role="student",
                enabled=True,
            )
            other_student = User(
                external_id="comment-other-student",
                email="other-student@example.com",
                password_hash="unused",
                name="其他学生",
                role="student",
                enabled=True,
            )
            db_session.add_all([chapter, klass, teacher, student, other_student])
            db_session.flush()
            db_session.add_all([
                UserClassRole(
                    user_id=teacher.id,
                    class_id=klass.id,
                    role_in_class="teacher",
                ),
                UserClassRole(
                    user_id=student.id,
                    class_id=klass.id,
                    role_in_class="student",
                ),
                UserClassRole(
                    user_id=other_student.id,
                    class_id=klass.id,
                    role_in_class="student",
                ),
            ])
            assignment = Assignment(
                title="选择题作业",
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
                question_number=1,
                type="choice",
                stem_markdown="正确答案是哪一项？",
                stem_html="<p>正确答案是哪一项？</p>",
            )
            db_session.add(question)
            db_session.flush()
            db_session.add_all([
                AssignmentQuestionOption(
                    assignment_question_id=question.id,
                    label=label,
                    content_markdown=label,
                    content_html=label,
                    sort_order=index,
                )
                for index, label in enumerate(("A", "B", "C", "D"))
            ])
            submission = Submission(
                assignment_id=assignment.id,
                student_id=student.id,
                status="submitted",
            )
            db_session.add(submission)
            db_session.flush()
            answer = Answer(
                submission_id=submission.id,
                assignment_question_id=question.id,
                choice_answer="D",
            )
            db_session.add(answer)
            db_session.commit()

            cls.teacher_id = teacher.id
            cls.student_id = student.id
            cls.other_student_id = other_student.id
            cls.assignment_id = assignment.id
            cls.question_id = question.id
            cls.answer_id = answer.id
            cls.submission_id = submission.id

    @classmethod
    def tearDownClass(cls):
        db_session.remove()
        shutil.rmtree(cls.root, ignore_errors=True)

    def client_for(self, user_id):
        client = self.app.test_client()
        with client.session_transaction() as session:
            session["user_id"] = user_id
            session["_csrf_token"] = "test-csrf"
        return client

    def test_grading_can_be_saved_as_draft_then_submitted(self):
        teacher = self.client_for(self.teacher_id)
        student = self.client_for(self.student_id)
        initial_dashboard = student.get("/student/")
        self.assertEqual(initial_dashboard.status_code, 200)
        self.assertIn("已完成".encode(), initial_dashboard.data)
        self.assertIn("选择题作业".encode(), initial_dashboard.data)
        self.assertIn("暂无待完成作业".encode(), initial_dashboard.data)

        grading_page = teacher.get(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}"
        )
        self.assertEqual(grading_page.status_code, 200)
        self.assertIn("本题批注".encode(), grading_page.data)
        self.assertIn(
            f'name="question_comment_{self.question_id}"'.encode(),
            grading_page.data,
        )
        self.assertIn("学生选择".encode(), grading_page.data)
        self.assertIn(">D<".encode(), grading_page.data)
        self.assertIn(b'name="action" value="draft"', grading_page.data)
        self.assertIn(b'name="action" value="submit"', grading_page.data)
        self.assertNotIn(b'name="score" class="form-control" style="width:160px;" value="" required', grading_page.data)

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            data={
                "_csrf": "test-csrf",
                "score": "",
                "comment": "尚未完成的总体评价",
                f"question_comment_{self.question_id}": "答案是 B。",
                "action": "draft",
            },
        )
        self.assertEqual(response.status_code, 302)

        with self.app.app_context():
            answer = db_session.get(Answer, self.answer_id)
            grade = (
                db_session.query(Grade)
                .filter_by(submission_id=self.submission_id)
                .one()
            )
            self.assertEqual(answer.grader_comment, "答案是 B。")
            self.assertIsNone(grade.score)
            self.assertEqual(grade.comment, "尚未完成的总体评价")
            self.assertEqual(grade.status, "draft")
            self.assertEqual(
                db_session.get(Submission, self.submission_id).status,
                "submitted",
            )

        draft_answer_page = student.get(
            f"/student/assignments/{self.assignment_id}"
        )
        self.assertEqual(draft_answer_page.status_code, 200)
        self.assertNotIn("教师批注".encode(), draft_answer_page.data)
        self.assertNotIn("答案是 B。".encode(), draft_answer_page.data)

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            data={
                "_csrf": "test-csrf",
                "score": "",
                "comment": "",
                f"question_comment_{self.question_id}": "",
                "action": "submit",
            },
            follow_redirects=True,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("提交批改时必须填写分数".encode(), response.data)
        with self.app.app_context():
            self.assertEqual(
                db_session.query(Grade)
                .filter_by(submission_id=self.submission_id)
                .one()
                .status,
                "draft",
            )

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            data={
                "_csrf": "test-csrf",
                "score": "80",
                "action": "submit",
            },
        )
        self.assertEqual(response.status_code, 302)
        with self.app.app_context():
            answer = db_session.get(Answer, self.answer_id)
            grade = (
                db_session.query(Grade)
                .filter_by(submission_id=self.submission_id)
                .one()
            )
            self.assertIsNone(answer.grader_comment)
            self.assertEqual(grade.score, 80)
            self.assertIsNone(grade.comment)
            self.assertEqual(grade.status, "submitted")
            self.assertEqual(
                db_session.get(Submission, self.submission_id).status,
                "graded",
            )

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            data={
                "_csrf": "test-csrf",
                "score": "80",
                f"question_comment_{self.question_id}": "答案是 B。",
                "action": "submit",
            },
        )
        self.assertEqual(response.status_code, 302)

        answer_page = student.get(f"/student/assignments/{self.assignment_id}")
        self.assertEqual(answer_page.status_code, 200)
        self.assertIn("教师批注".encode(), answer_page.data)
        self.assertIn("答案是 B。".encode(), answer_page.data)

        dashboard = student.get("/student/")
        self.assertEqual(dashboard.status_code, 200)
        self.assertIn(
            f'href="/student/assignments/{self.assignment_id}"'.encode(),
            dashboard.data,
        )

        with self.app.app_context():
            assignment = db_session.get(Assignment, self.assignment_id)
            assignment.status = "draft"
            db_session.commit()

        teacher_detail = teacher.get(
            f"/teacher/assignments/{self.assignment_id}"
        )
        self.assertNotIn(
            f'/teacher/assignments/{self.assignment_id}/grade/{self.student_id}'.encode(),
            teacher_detail.data,
        )
        blocked_grading = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            data={
                "_csrf": "test-csrf",
                "score": "99",
                "action": "submit",
            },
            follow_redirects=True,
        )
        self.assertEqual(blocked_grading.status_code, 200)
        self.assertIn("草稿状态的作业不能批改".encode(), blocked_grading.data)
        with self.app.app_context():
            self.assertEqual(
                db_session.query(Grade)
                .filter_by(submission_id=self.submission_id)
                .one()
                .score,
                80,
            )

        historical_dashboard = student.get("/student/")
        self.assertEqual(historical_dashboard.status_code, 200)
        self.assertIn("已批改".encode(), historical_dashboard.data)
        self.assertIn("选择题作业".encode(), historical_dashboard.data)
        self.assertIn("作业已撤回".encode(), historical_dashboard.data)

        grades_page = student.get("/student/grades")
        self.assertEqual(grades_page.status_code, 200)
        self.assertIn(
            f'href="/student/assignments/{self.assignment_id}"'.encode(),
            grades_page.data,
        )
        historical_answer = student.get(
            f"/student/assignments/{self.assignment_id}"
        )
        self.assertEqual(historical_answer.status_code, 200)
        self.assertIn("历史提交记录".encode(), historical_answer.data)
        self.assertIn("答案是 B。".encode(), historical_answer.data)
        self.assertNotIn("问 AI".encode(), historical_answer.data)

        other_student = self.client_for(self.other_student_id)
        other_dashboard = other_student.get("/student/")
        self.assertNotIn("选择题作业".encode(), other_dashboard.data)
        self.assertEqual(
            other_student.get(
                f"/student/assignments/{self.assignment_id}"
            ).status_code,
            403,
        )


if __name__ == "__main__":
    unittest.main()
