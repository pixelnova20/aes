"""Shared helpers used by the teacher/ta/student views."""
from datetime import datetime

from .database import db_session
from .models import (
    Answer,
    AssignmentQuestion,
    AssignmentQuestionOption,
    Grade,
    Submission,
    UploadedFile,
    UserClassRole,
)


# --------------------------------------------------------------------------
# Multi-class queries
# --------------------------------------------------------------------------
def get_user_classes(user, role_in_class=None):
    """Return the Class objects for a user's membership entries."""
    q = db_session.query(UserClassRole).filter_by(user_id=user.id)
    if role_in_class:
        q = q.filter_by(role_in_class=role_in_class)
    return [ucr.klass for ucr in q.all()]


def user_has_class_access(user, class_id, role_in_class=None):
    q = db_session.query(UserClassRole).filter_by(user_id=user.id, class_id=class_id)
    if role_in_class:
        q = q.filter_by(role_in_class=role_in_class)
    return q.first() is not None


def user_has_course_access(user, course_id):
    """Check whether the user belongs to any class of the given course."""
    from .models import Class

    if user.role == "super_admin":
        return True
    class_ids = {
        ucr.class_id
        for ucr in db_session.query(UserClassRole).filter_by(user_id=user.id).all()
    }
    if not class_ids:
        return False
    count = (
        db_session.query(Class)
        .filter(Class.id.in_(class_ids), Class.course_id == course_id)
        .count()
    )
    return count > 0


# --------------------------------------------------------------------------
# Submission helpers
# --------------------------------------------------------------------------
def get_submission(assignment_id, student_id):
    return (
        db_session.query(Submission)
        .filter_by(assignment_id=assignment_id, student_id=student_id)
        .first()
    )


def get_grade(submission):
    if submission is None:
        return None
    return db_session.query(Grade).filter_by(submission_id=submission.id).first()


def prepare_question_items(assignment, submission):
    """Return ``[{aq, options, answer, files}, ...]`` using snapshot data."""
    answer_map = {}
    if submission is not None:
        for ans in (
            db_session.query(Answer).filter_by(submission_id=submission.id).all()
        ):
            answer_map[ans.assignment_question_id] = ans

    items = []
    for aq in assignment.assignment_questions:
        opts = aq.snapshot_options if aq.snapshot_options else None
        answer = answer_map.get(aq.id)
        files = []
        if answer is not None:
            files = (
                db_session.query(UploadedFile)
                .filter_by(answer_id=answer.id)
                .order_by(UploadedFile.uploaded_at)
                .all()
            )
        items.append(
            {"aq": aq, "question": aq, "options": opts, "answer": answer, "files": files}
        )
    return items


def ensure_submission(assignment, student):
    submission = get_submission(assignment.id, student.id)
    if submission is not None:
        return submission

    submission = Submission(
        assignment_id=assignment.id,
        student_id=student.id,
        status="not_started",
    )
    db_session.add(submission)
    db_session.flush()

    aqs = (
        db_session.query(AssignmentQuestion)
        .filter_by(assignment_id=assignment.id)
        .order_by(AssignmentQuestion.sort_order)
        .all()
    )
    for aq in aqs:
        db_session.add(
            Answer(submission_id=submission.id, assignment_question_id=aq.id)
        )
    db_session.commit()
    return submission


def build_grade_context(assignment, student):
    submission = get_submission(assignment.id, student.id)
    grade = get_grade(submission)
    items = prepare_question_items(assignment, submission)
    return {
        "assignment": assignment,
        "student": student,
        "submission": submission,
        "grade": grade,
        "items": items,
    }


def save_grade(
    submission_id,
    grader_id,
    score,
    comment,
    question_comments=None,
    finalize=True,
):
    submission = db_session.get(Submission, submission_id)
    if submission is None:
        return None

    grade = db_session.query(Grade).filter_by(submission_id=submission_id).first()
    if grade is None:
        grade = Grade(submission_id=submission_id, grader_id=grader_id)
        db_session.add(grade)

    grade.score = score
    grade.comment = (comment or "").strip() or None
    grade.grader_id = grader_id
    grade.status = "submitted" if finalize else "draft"
    if finalize:
        grade.graded_at = datetime.now()
        submission.status = "graded"
    elif submission.status == "graded":
        submission.status = "submitted"
    submission.updated_at = datetime.now()

    if question_comments is not None:
        valid_question_ids = {
            row[0]
            for row in db_session.query(AssignmentQuestion.id)
            .filter_by(assignment_id=submission.assignment_id)
            .all()
        }
        answers = {
            answer.assignment_question_id: answer
            for answer in db_session.query(Answer)
            .filter_by(submission_id=submission.id)
            .all()
        }
        for question_id, raw_comment in question_comments.items():
            if question_id not in valid_question_ids:
                continue
            answer = answers.get(question_id)
            if answer is None:
                answer = Answer(
                    submission_id=submission.id,
                    assignment_question_id=question_id,
                )
                db_session.add(answer)
            answer.grader_comment = (raw_comment or "").strip() or None

    db_session.commit()
    return grade


# --------------------------------------------------------------------------
# Question snapshot (called at publish time)
# --------------------------------------------------------------------------
def snapshot_question_to_aq(aq, question):
    """Copy live question data into an AssignmentQuestion snapshot row."""
    aq.question_number = question.question_number
    aq.type = question.type
    aq.stem_markdown = question.stem_markdown
    aq.stem_html = question.stem_html
    # Copy options for choice questions
    if question.type == "choice":
        for idx, opt in enumerate(question.options):
            db_session.add(
                AssignmentQuestionOption(
                    assignment_question_id=aq.id,
                    label=opt.label,
                    content_markdown=opt.content_markdown,
                    content_html=opt.content_html,
                    sort_order=idx,
                )
            )
