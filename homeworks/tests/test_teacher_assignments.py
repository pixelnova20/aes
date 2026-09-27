import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta

from config import Config
from app import create_app
from app.database import db_session
from app.helpers import snapshot_question_to_aq
from app.models import (
    Answer,
    Assignment,
    AssignmentQuestion,
    Chapter,
    Class,
    Course,
    Grade,
    Question,
    Submission,
    UploadedFile,
    User,
    UserClassRole,
)


class TeacherAssignmentWithdrawalTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="homeworks-assignment-withdrawal-")

        class TestConfig(Config):
            TESTING = True
            SECRET_KEY = "assignment-withdrawal-test-secret"
            APPLICATION_ROOT = "/"
            ACCOUNT_DATABASE = os.path.join(cls.root, "accounts.db")
            COURSE_DATABASE = os.path.join(cls.root, "courses.db")
            UPLOAD_DIR = os.path.join(cls.root, "uploads")
            CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
            ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

        cls.app = create_app(TestConfig)
        with cls.app.app_context():
            course = Course(name="操作系统", owner_external_id="teacher-owner")
            db_session.add(course)
            db_session.flush()
            klass = Class(name="测试班", course_id=course.id, enabled=True)
            chapter = Chapter(course_id=course.id, chapter_number=1, title="概述")
            db_session.add_all([klass, chapter])
            db_session.flush()
            question_one = Question(
                chapter_id=chapter.id,
                question_number=1,
                type="short_answer",
                stem_markdown="第一题",
                stem_html="<p>第一题</p>",
            )
            question_two = Question(
                chapter_id=chapter.id,
                question_number=2,
                type="comprehensive",
                stem_markdown="第二题",
                stem_html="<p>第二题</p>",
            )
            db_session.add_all([question_one, question_two])
            db_session.flush()
            teacher = User(
                external_id="teacher-owner",
                email="teacher@example.com",
                password_hash="unused",
                name="发布教师",
                role="teacher",
                enabled=True,
            )
            other_teacher = User(
                external_id="teacher-other",
                email="other-teacher@example.com",
                password_hash="unused",
                name="其他教师",
                role="teacher",
                enabled=True,
            )
            student = User(
                external_id="student-one",
                email="student@example.com",
                password_hash="unused",
                name="学生",
                role="student",
                enabled=True,
            )
            db_session.add_all([teacher, other_teacher, student])
            db_session.flush()
            db_session.add_all([
                UserClassRole(user_id=teacher.id, class_id=klass.id, role_in_class="teacher"),
                UserClassRole(user_id=student.id, class_id=klass.id, role_in_class="student"),
            ])
            assignment = Assignment(
                title="可撤回作业",
                course_id=course.id,
                chapter_id=chapter.id,
                class_id=klass.id,
                publisher_id=teacher.id,
                due_at=datetime.now() + timedelta(days=2),
                status="published",
                published_at=datetime.now(),
            )
            db_session.add(assignment)
            db_session.flush()
            assignment_question = AssignmentQuestion(
                assignment_id=assignment.id,
                question_id=question_one.id,
                sort_order=0,
                question_number=question_one.question_number,
                type=question_one.type,
                stem_markdown=question_one.stem_markdown,
                stem_html=question_one.stem_html,
            )
            db_session.add(assignment_question)
            db_session.flush()
            snapshot_question_to_aq(assignment_question, question_one)
            submission = Submission(
                assignment_id=assignment.id,
                student_id=student.id,
                status="saved",
                first_saved_at=datetime.now(),
            )
            db_session.add(submission)
            db_session.commit()
            cls.teacher_id = teacher.id
            cls.other_teacher_id = other_teacher.id
            cls.student_id = student.id
            cls.assignment_id = assignment.id
            cls.submission_id = submission.id
            cls.course_id = course.id
            cls.class_id = klass.id
            cls.chapter_id = chapter.id
            cls.question_one_id = question_one.id
            cls.question_two_id = question_two.id
            cls.upload_dir = TestConfig.UPLOAD_DIR

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

    def test_withdraw_hides_assignment_and_preserves_submission(self):
        teacher = self.client_for(self.teacher_id)
        student = self.client_for(self.student_id)

        old_listing = teacher.get("/teacher/assignments")
        self.assertEqual(old_listing.status_code, 302)
        self.assertTrue(old_listing.location.endswith("/teacher/"))
        dashboard = teacher.get("/teacher/")
        self.assertEqual(dashboard.status_code, 200)
        self.assertIn("可撤回作业".encode(), dashboard.data)
        self.assertNotIn(">我的作业<".encode(), dashboard.data)
        detail = teacher.get(f"/teacher/assignments/{self.assignment_id}")
        self.assertIn(
            f'/teacher/assignments/{self.assignment_id}/withdraw'.encode(),
            detail.data,
        )
        self.assertIn("撤回后学生将无法查看或提交".encode(), detail.data)
        self.assertNotIn(
            f'/teacher/assignments/{self.assignment_id}/grade/{self.student_id}'.encode(),
            detail.data,
        )
        grading_page = teacher.get(
            f"/teacher/assignments/{self.assignment_id}/grade/{self.student_id}",
            follow_redirects=True,
        )
        self.assertEqual(grading_page.status_code, 200)
        self.assertIn("尚未提交作业，不能批改".encode(), grading_page.data)
        self.assertIn("可撤回作业".encode(), student.get("/student/").data)
        self.assertEqual(
            student.get(f"/student/assignments/{self.assignment_id}").status_code,
            200,
        )

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/withdraw",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 302)

        with self.app.app_context():
            assignment = db_session.get(Assignment, self.assignment_id)
            self.assertEqual(assignment.status, "draft")
            self.assertIsNone(assignment.published_at)
            submission = db_session.get(Submission, self.submission_id)
            self.assertIsNotNone(submission)
            self.assertEqual(submission.status, "saved")

        edit_page = teacher.get(
            f"/teacher/assignments/{self.assignment_id}/edit"
        )
        self.assertEqual(edit_page.status_code, 200)
        self.assertIn("题目内容已锁定".encode(), edit_page.data)
        self.assertNotIn(b'name="question_ids"', edit_page.data)

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/edit",
            data={
                "_csrf": "test-csrf",
                "title": "可撤回作业",
                "description": "撤回后修改的说明",
                "due_at": (datetime.now() + timedelta(days=3)).strftime(
                    "%Y-%m-%dT%H:%M"
                ),
                "action": "draft",
                "question_ids": str(self.question_two_id),
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/teacher/"))
        with self.app.app_context():
            assignment = db_session.get(Assignment, self.assignment_id)
            self.assertEqual(assignment.description, "撤回后修改的说明")
            self.assertEqual(
                [aq.question_id for aq in assignment.assignment_questions],
                [self.question_one_id],
            )

        detail = teacher.get(f"/teacher/assignments/{self.assignment_id}")
        self.assertIn("删除草稿".encode(), detail.data)
        self.assertIn("删除作业将连带删除学生的答案".encode(), detail.data)

        self.assertNotIn("可撤回作业".encode(), student.get("/student/").data)
        self.assertEqual(
            student.get(f"/student/assignments/{self.assignment_id}").status_code,
            403,
        )

        response = teacher.post(
            f"/teacher/assignments/{self.assignment_id}/publish",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 302)
        with self.app.app_context():
            assignment = db_session.get(Assignment, self.assignment_id)
            self.assertEqual(assignment.status, "published")
            self.assertIsNotNone(assignment.published_at)
            self.assertIsNotNone(db_session.get(Submission, self.submission_id))
        self.assertIn("可撤回作业".encode(), student.get("/student/").data)

    def test_draft_with_answers_can_be_confirmed_and_deleted(self):
        relative_path = "student-one/delete-with-assignment.png"
        full_path = os.path.join(self.upload_dir, relative_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as attachment:
            attachment.write(b"assignment attachment")

        with self.app.app_context():
            draft = Assignment(
                title="已有作答的草稿",
                course_id=self.course_id,
                chapter_id=self.chapter_id,
                class_id=self.class_id,
                publisher_id=self.teacher_id,
                due_at=datetime.now() + timedelta(days=2),
                status="draft",
            )
            db_session.add(draft)
            db_session.flush()
            question = db_session.get(Question, self.question_two_id)
            assignment_question = AssignmentQuestion(
                assignment_id=draft.id,
                question_id=question.id,
                sort_order=0,
                question_number=question.question_number,
                type=question.type,
                stem_markdown=question.stem_markdown,
                stem_html=question.stem_html,
            )
            db_session.add(assignment_question)
            db_session.flush()
            submission = Submission(
                assignment_id=draft.id,
                student_id=self.student_id,
                status="submitted",
                submitted_at=datetime.now(),
            )
            db_session.add(submission)
            db_session.flush()
            answer = Answer(
                submission_id=submission.id,
                assignment_question_id=assignment_question.id,
                text_answer="学生答案",
            )
            db_session.add(answer)
            db_session.flush()
            uploaded_file = UploadedFile(
                answer_id=answer.id,
                uploader_id=self.student_id,
                file_path=relative_path,
                original_name="answer.png",
                file_size=os.path.getsize(full_path),
            )
            grade = Grade(
                submission_id=submission.id,
                grader_id=self.teacher_id,
                score=88,
                comment="批改记录",
            )
            db_session.add_all([uploaded_file, grade])
            db_session.commit()
            ids = {
                "assignment": draft.id,
                "assignment_question": assignment_question.id,
                "submission": submission.id,
                "answer": answer.id,
                "uploaded_file": uploaded_file.id,
                "grade": grade.id,
            }

        teacher = self.client_for(self.teacher_id)
        detail = teacher.get(f"/teacher/assignments/{ids['assignment']}")
        self.assertEqual(detail.status_code, 200)
        self.assertIn("删除草稿".encode(), detail.data)
        self.assertIn("删除作业将连带删除学生的答案".encode(), detail.data)

        response = teacher.post(
            f"/teacher/assignments/{ids['assignment']}/delete",
            data={"_csrf": "test-csrf"},
            follow_redirects=True,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("作业及其学生答案已删除".encode(), response.data)
        self.assertFalse(os.path.exists(full_path))

        with self.app.app_context():
            self.assertIsNone(db_session.get(Assignment, ids["assignment"]))
            self.assertIsNone(
                db_session.get(AssignmentQuestion, ids["assignment_question"])
            )
            self.assertIsNone(db_session.get(Submission, ids["submission"]))
            self.assertIsNone(db_session.get(Answer, ids["answer"]))
            self.assertIsNone(db_session.get(UploadedFile, ids["uploaded_file"]))
            self.assertIsNone(db_session.get(Grade, ids["grade"]))

    def test_plain_draft_can_be_edited_and_deleted(self):
        with self.app.app_context():
            draft = Assignment(
                title="待编辑草稿",
                course_id=self.course_id,
                chapter_id=self.chapter_id,
                class_id=self.class_id,
                publisher_id=self.teacher_id,
                due_at=None,
                status="draft",
            )
            db_session.add(draft)
            db_session.flush()
            question = db_session.get(Question, self.question_one_id)
            assignment_question = AssignmentQuestion(
                assignment_id=draft.id,
                question_id=question.id,
                sort_order=0,
                question_number=question.question_number,
                type=question.type,
                stem_markdown=question.stem_markdown,
                stem_html=question.stem_html,
            )
            db_session.add(assignment_question)
            db_session.flush()
            snapshot_question_to_aq(assignment_question, question)
            db_session.commit()
            draft_id = draft.id

        teacher = self.client_for(self.teacher_id)
        detail = teacher.get(
            f"/teacher/assignments/{draft_id}",
            headers={"X-Forwarded-Prefix": "/homeworks"},
        )
        self.assertEqual(detail.status_code, 200)
        self.assertIn(">返回</button>".encode(), detail.data)
        self.assertNotIn("作业列表".encode(), detail.data)
        self.assertIn(b'data-fallback-url="/homeworks/teacher/"', detail.data)
        self.assertIn(b"window.history.back()", detail.data)
        self.assertIn("编辑".encode(), detail.data)
        self.assertIn("删除草稿".encode(), detail.data)

        edit_page = teacher.get(f"/teacher/assignments/{draft_id}/edit")
        self.assertEqual(edit_page.status_code, 200)
        self.assertIn(b'name="question_ids"', edit_page.data)
        self.assertIn(
            f'value="{self.question_one_id}" checked'.encode(), edit_page.data
        )

        due_at = datetime.now() + timedelta(days=4)
        response = teacher.post(
            f"/teacher/assignments/{draft_id}/edit",
            data={
                "_csrf": "test-csrf",
                "title": "修改后的草稿",
                "description": "新的说明",
                "due_at": due_at.strftime("%Y-%m-%dT%H:%M"),
                "action": "draft",
                "question_ids": str(self.question_two_id),
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/teacher/"))
        with self.app.app_context():
            draft = db_session.get(Assignment, draft_id)
            self.assertEqual(draft.title, "修改后的草稿")
            self.assertEqual(draft.description, "新的说明")
            self.assertEqual(draft.status, "draft")
            self.assertEqual(
                [aq.question_id for aq in draft.assignment_questions],
                [self.question_two_id],
            )

        response = teacher.post(
            f"/teacher/assignments/{draft_id}/delete",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.location.endswith("/teacher/"))
        with self.app.app_context():
            self.assertIsNone(db_session.get(Assignment, draft_id))

    def test_other_teacher_cannot_withdraw_assignment(self):
        other_teacher = self.client_for(self.other_teacher_id)
        response = other_teacher.post(
            f"/teacher/assignments/{self.assignment_id}/withdraw",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 403)
        response = other_teacher.post(
            f"/teacher/assignments/{self.assignment_id}/delete",
            data={"_csrf": "test-csrf"},
        )
        self.assertEqual(response.status_code, 403)
        with self.app.app_context():
            self.assertEqual(
                db_session.get(Assignment, self.assignment_id).status,
                "published",
            )


if __name__ == "__main__":
    unittest.main()
