"""TA (teaching assistant) views: list gradable assignments and grade."""
from flask import Blueprint, abort, flash, redirect, render_template, request, url_for

from ..audit import log
from ..auth_utils import current_user
from ..database import db_session
from ..decorators import role_required
from ..helpers import (
    build_grade_context,
    get_grade,
    get_submission,
    get_user_classes,
    save_grade,
    user_has_class_access,
)
from ..models import Assignment, User, UserClassRole

bp = Blueprint("ta", __name__, url_prefix="/ta")


def _ta_classes():
    """Return all classes where the current user is a TA."""
    return get_user_classes(current_user(), role_in_class="ta")


def _ta_class_ids():
    return [c.id for c in _ta_classes()]


@bp.route("/")
@role_required("ta")
def dashboard():
    classes = _ta_classes()
    cids = _ta_class_ids()
    if not cids:
        return render_template("ta/dashboard.html", assignments=[], classes=classes)
    assignments = (
        db_session.query(Assignment)
        .filter(Assignment.class_id.in_(cids))
        .filter(Assignment.status.in_(["published", "closed"]))
        .order_by(Assignment.created_at.desc())
        .all()
    )
    return render_template(
        "ta/dashboard.html", assignments=assignments, classes=classes
    )


@bp.route("/assignments")
@role_required("ta")
def assignments():
    cids = _ta_class_ids()
    if not cids:
        return render_template("ta/assignments.html", assignments=[])
    assignments = (
        db_session.query(Assignment)
        .filter(Assignment.class_id.in_(cids))
        .filter(Assignment.status.in_(["published", "closed"]))
        .order_by(Assignment.created_at.desc())
        .all()
    )
    return render_template("ta/assignments.html", assignments=assignments)


@bp.route("/assignments/<int:assignment_id>")
@role_required("ta")
def assignment_detail(assignment_id):
    assignment = db_session.get(Assignment, assignment_id)
    if assignment is None or not user_has_class_access(
        current_user(), assignment.class_id, "ta"
    ):
        abort(403)

    # Get students from the class's user_roles
    student_ids = [
        ucr.user_id
        for ucr in db_session.query(UserClassRole)
        .filter_by(class_id=assignment.class_id, role_in_class="student")
        .all()
    ]
    students = (
        db_session.query(User)
        .filter(User.id.in_(student_ids), User.enabled.is_(True))
        .order_by(User.name)
        .all()
    ) if student_ids else []

    rows = []
    for student in students:
        submission = get_submission(assignment.id, student.id)
        grade = get_grade(submission)
        rows.append((student, submission, grade))
    return render_template(
        "ta/assignment_detail.html", assignment=assignment, rows=rows
    )


@bp.route(
    "/assignments/<int:assignment_id>/grade/<int:student_id>",
    methods=["GET", "POST"],
)
@role_required("ta")
def grade_student(assignment_id, student_id):
    assignment = db_session.get(Assignment, assignment_id)
    if assignment is None or not user_has_class_access(
        current_user(), assignment.class_id, "ta"
    ):
        abort(403)
    if assignment.status not in ("published", "closed"):
        flash("草稿状态的作业不能批改", "error")
        return redirect(url_for("ta.assignment_detail", assignment_id=assignment_id))
    student = db_session.get(User, student_id)
    if student is None:
        abort(404)
    # Verify student belongs to the assignment's class
    if not user_has_class_access(student, assignment.class_id, "student"):
        abort(403)
    submission = get_submission(assignment.id, student.id)
    if submission is None or submission.status not in ("submitted", "graded"):
        flash("该学生尚未提交作业，不能批改", "error")
        return redirect(url_for("ta.assignment_detail", assignment_id=assignment_id))

    if request.method == "POST":
        ctx = build_grade_context(assignment, student)
        if ctx["submission"] is None:
            flash("该学生尚未作答，无法批改", "error")
            return redirect(
                url_for("ta.assignment_detail", assignment_id=assignment_id)
            )
        action = request.form.get("action", "submit")
        finalize = action != "draft"
        raw_score = (request.form.get("score") or "").strip()
        score = _parse_score(raw_score)
        if raw_score and score is None:
            flash("分数格式无效", "error")
            return redirect(
                url_for(
                    "ta.grade_student",
                    assignment_id=assignment_id,
                    student_id=student_id,
                )
            )
        if finalize and score is None:
            flash("提交批改时必须填写分数", "error")
            return redirect(
                url_for(
                    "ta.grade_student",
                    assignment_id=assignment_id,
                    student_id=student_id,
                )
            )
        comment = (request.form.get("comment") or "").strip()
        question_comments = {
            item["aq"].id: request.form.get(
                f"question_comment_{item['aq'].id}", ""
            )
            for item in ctx["items"]
        }
        save_grade(
            ctx["submission"].id,
            current_user().id,
            score,
            comment,
            question_comments,
            finalize=finalize,
        )
        log(
            "ta.grade.submit" if finalize else "ta.grade.save_draft",
            f"assignment_id={assignment_id} student_id={student_id} score={score}",
        )
        flash("批改已提交" if finalize else "批改已暂存", "success")
        return redirect(
            url_for(
                "ta.grade_student",
                assignment_id=assignment_id,
                student_id=student_id,
            )
        )

    ctx = build_grade_context(assignment, student)
    return render_template("grading/grade.html", **ctx)


def _parse_score(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None
