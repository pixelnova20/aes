"""SQLAlchemy ORM models for the homework system."""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


def now():
    return datetime.now()


ROLE_LABELS = {
    "super_admin": "超级管理员",
    "teacher": "教师",
    "ta": "助教",
    "student": "学生",
}

ACCOUNT_SCHEMA = "accounts"

TYPE_LABELS = {
    "choice": "选择题",
    "blank": "填空题",
    "short_answer": "简答题",
    "comprehensive": "综合题",
}

ASSIGNMENT_STATUS_LABELS = {
    "draft": "草稿",
    "published": "已发布",
    "closed": "已关闭",
}

SUBMISSION_STATUS_LABELS = {
    "not_started": "未开始",
    "saved": "暂存",
    "submitted": "已提交",
    "graded": "已批改",
}

# --------------------------------------------------------------------------
# User & role models
# --------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", "invite_code", name="uq_user_email_invite"),
        UniqueConstraint("student_no", "invite_code", name="uq_user_student_invite"),
        {"schema": ACCOUNT_SCHEMA},
    )

    id = Column(Integer, primary_key=True)
    external_id = Column(String(191), unique=True, nullable=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    name = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False, default="student")
    student_no = Column(String(64), nullable=True, index=True)
    invite_code = Column(String(64), nullable=True)
    upload_dir = Column(String(512), nullable=True)
    course_name = Column(String(255), nullable=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=True)  # deprecated
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)
    last_login_at = Column(DateTime, nullable=True)

    klass = relationship("Class", backref="members")
    class_roles = relationship(
        "UserClassRole", backref="user", cascade="all, delete-orphan"
    )

    @property
    def role_label(self):
        return ROLE_LABELS.get(self.role, self.role)


class UserClassRole(Base):
    """Multi-class membership: a user may belong to multiple classes with
    possibly different roles (teacher / ta / student) in each."""
    __tablename__ = "user_class_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "class_id", name="uq_user_class"),
        {"schema": ACCOUNT_SCHEMA},
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=False, index=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False)
    role_in_class = Column(String(32), nullable=False)  # teacher / ta / student
    created_at = Column(DateTime, nullable=False, default=now)

    klass = relationship("Class", backref="user_roles")


class Class(Base):
    __tablename__ = "classes"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    capacity = Column(Integer, nullable=False, default=50)
    current_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=now)
    enabled = Column(Boolean, nullable=False, default=True)

    course = relationship("Course", backref="classes")


class InviteCode(Base):
    __tablename__ = "invite_codes"
    __table_args__ = {"schema": ACCOUNT_SCHEMA}

    id = Column(Integer, primary_key=True)
    code = Column(String(64), unique=True, nullable=False, index=True)
    level = Column(String(16), nullable=False, default="level_1")
    parent_code = Column(String(64), nullable=True)
    teacher_external_id = Column(String(191), nullable=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=True)
    course_name = Column(String(255), nullable=True)
    class_name = Column(String(255), nullable=True)
    capacity = Column(Integer, nullable=True)
    used_count = Column(Integer, nullable=False, default=0)
    enabled = Column(Boolean, nullable=False, default=True)
    expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now)

    klass = relationship("Class", backref="invite_codes")


# --------------------------------------------------------------------------
# Course & chapter models
# --------------------------------------------------------------------------
class Course(Base):
    __tablename__ = "courses"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    owner_external_id = Column(String(191), nullable=True)
    created_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)


class Chapter(Base):
    __tablename__ = "chapters"
    __table_args__ = (
        UniqueConstraint(
            "course_id", "chapter_number", name="uq_course_chapter_number"
        ),
    )

    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    chapter_number = Column(Integer, nullable=False)
    title = Column(String(255), nullable=True)
    markdown_path = Column(String(512), nullable=True)
    markdown_original_name = Column(String(255), nullable=True)
    markdown_uploaded_at = Column(DateTime, nullable=True)
    parse_status = Column(String(32), nullable=False, default="not_uploaded")
    created_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    course = relationship("Course", backref="chapters")

    @property
    def parse_status_label(self):
        return {
            "not_uploaded": "未上传",
            "parsed": "已解析",
            "parse_failed": "解析失败",
        }.get(self.parse_status, self.parse_status)


# --------------------------------------------------------------------------
# Question bank models
# --------------------------------------------------------------------------
class Question(Base):
    __tablename__ = "questions"

    id = Column(Integer, primary_key=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False, index=True)
    question_number = Column(Integer, nullable=False)
    type = Column(String(32), nullable=False)
    stem_markdown = Column(Text, nullable=False)
    stem_html = Column(Text, nullable=False)
    reference_answer = Column(Text, nullable=True)
    score = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    options = relationship(
        "QuestionOption",
        backref="question",
        order_by="QuestionOption.sort_order",
        cascade="all, delete-orphan",
    )

    @property
    def type_label(self):
        return TYPE_LABELS.get(self.type, self.type)


class QuestionOption(Base):
    __tablename__ = "question_options"

    id = Column(Integer, primary_key=True)
    question_id = Column(
        Integer, ForeignKey("questions.id"), nullable=False, index=True
    )
    label = Column(String(8), nullable=False)
    content_markdown = Column(Text, nullable=False)
    content_html = Column(Text, nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)


# --------------------------------------------------------------------------
# Assignment & snapshot models
# --------------------------------------------------------------------------
class Assignment(Base):
    __tablename__ = "assignments"

    id = Column(Integer, primary_key=True)
    title = Column(String(255), nullable=False)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False)
    publisher_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=False)
    description = Column(Text, nullable=True)
    due_at = Column(DateTime, nullable=True)
    status = Column(String(32), nullable=False, default="draft")
    created_at = Column(DateTime, nullable=False, default=now)
    published_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    assignment_questions = relationship(
        "AssignmentQuestion",
        backref="assignment",
        order_by="AssignmentQuestion.sort_order",
        cascade="all, delete-orphan",
    )
    course = relationship("Course", backref="assignments")
    chapter = relationship("Chapter", backref="assignments")
    klass = relationship("Class", backref="assignments")
    publisher = relationship("User", backref="published_assignments")

    @property
    def status_label(self):
        return ASSIGNMENT_STATUS_LABELS.get(self.status, self.status)

    @property
    def is_past_due(self):
        if self.due_at is None:
            return False
        return datetime.now() > self.due_at


class AssignmentQuestion(Base):
    """Snapshot of a question frozen at assignment-publish time so that
    re-uploading the chapter bank does not affect published assignments."""
    __tablename__ = "assignment_questions"

    id = Column(Integer, primary_key=True)
    assignment_id = Column(
        Integer, ForeignKey("assignments.id"), nullable=False, index=True
    )
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=True)  # nullable: reference may be deleted
    sort_order = Column(Integer, nullable=False, default=0)
    score = Column(Float, nullable=True)

    # Snapshot fields (copied from Question at publish time).
    question_number = Column(Integer, nullable=False)
    type = Column(String(32), nullable=False)
    stem_markdown = Column(Text, nullable=False, default="")
    stem_html = Column(Text, nullable=False, default="")

    question = relationship("Question", backref="assignment_questions")
    snapshot_options = relationship(
        "AssignmentQuestionOption",
        backref="assignment_question",
        order_by="AssignmentQuestionOption.sort_order",
        cascade="all, delete-orphan",
    )

    @property
    def type_label(self):
        return TYPE_LABELS.get(self.type, self.type)


class AssignmentQuestionOption(Base):
    """Snapshot of a choice option frozen at assignment-publish time."""
    __tablename__ = "assignment_question_options"

    id = Column(Integer, primary_key=True)
    assignment_question_id = Column(
        Integer, ForeignKey("assignment_questions.id"), nullable=False, index=True
    )
    label = Column(String(8), nullable=False)
    content_markdown = Column(Text, nullable=False, default="")
    content_html = Column(Text, nullable=False, default="")
    sort_order = Column(Integer, nullable=False, default=0)


# --------------------------------------------------------------------------
# Submission & answer models
# --------------------------------------------------------------------------
class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (
        UniqueConstraint(
            "assignment_id", "student_id", name="uq_assignment_student"
        ),
    )

    id = Column(Integer, primary_key=True)
    assignment_id = Column(
        Integer, ForeignKey("assignments.id"), nullable=False, index=True
    )
    student_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=False)
    status = Column(String(32), nullable=False, default="not_started")
    first_saved_at = Column(DateTime, nullable=True)
    submitted_at = Column(DateTime, nullable=True)
    is_late = Column(Boolean, nullable=False, default=False)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    assignment = relationship("Assignment", backref="submissions")
    student = relationship("User", backref="submissions")
    answers = relationship(
        "Answer", backref="submission", cascade="all, delete-orphan"
    )

    @property
    def status_label(self):
        return SUBMISSION_STATUS_LABELS.get(self.status, self.status)


class Answer(Base):
    __tablename__ = "answers"
    __table_args__ = (
        UniqueConstraint(
            "submission_id", "assignment_question_id", name="uq_submission_aq"
        ),
    )

    id = Column(Integer, primary_key=True)
    submission_id = Column(
        Integer, ForeignKey("submissions.id"), nullable=False, index=True
    )
    assignment_question_id = Column(
        Integer, ForeignKey("assignment_questions.id"), nullable=False
    )
    text_answer = Column(Text, nullable=True)
    choice_answer = Column(String(8), nullable=True)
    grader_comment = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    assignment_question = relationship("AssignmentQuestion", backref="answers")
    files = relationship(
        "UploadedFile",
        backref="answer",
        order_by="UploadedFile.uploaded_at",
        cascade="all, delete-orphan",
    )


class UploadedFile(Base):
    __tablename__ = "uploaded_files"

    id = Column(Integer, primary_key=True)
    answer_id = Column(
        Integer, ForeignKey("answers.id"), nullable=False, index=True
    )
    uploader_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=False)
    file_path = Column(String(512), nullable=False)
    original_name = Column(String(255), nullable=False)
    mime_type = Column(String(128), nullable=True)
    file_size = Column(Integer, nullable=False, default=0)
    uploaded_at = Column(DateTime, nullable=False, default=now)


# --------------------------------------------------------------------------
# Grading
# --------------------------------------------------------------------------
class Grade(Base):
    __tablename__ = "grades"

    id = Column(Integer, primary_key=True)
    submission_id = Column(
        Integer, ForeignKey("submissions.id"), unique=True, nullable=False
    )
    grader_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=False)
    score = Column(Float, nullable=True)
    comment = Column(Text, nullable=True)
    status = Column(String(32), nullable=False, default="submitted")
    graded_at = Column(DateTime, nullable=False, default=now)
    updated_at = Column(DateTime, nullable=False, default=now, onupdate=now)

    submission = relationship("Submission", backref="grade")
    grader = relationship("User", backref="grades_given")


# --------------------------------------------------------------------------
# Audit log
# --------------------------------------------------------------------------
class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = {"schema": ACCOUNT_SCHEMA}

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("accounts.users.id"), nullable=True)
    user_email = Column(String(255), nullable=True)
    action = Column(String(128), nullable=False)
    detail = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=now)


# --------------------------------------------------------------------------
# Schema migrations
# --------------------------------------------------------------------------
class SchemaMigration(Base):
    __tablename__ = "schema_migrations"
    __table_args__ = {"schema": ACCOUNT_SCHEMA}

    id = Column(Integer, primary_key=True)
    version = Column(String(64), nullable=False, unique=True)
    applied_at = Column(DateTime, nullable=False, default=now)
