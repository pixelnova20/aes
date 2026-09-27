"""Teacher views: publish assignments, list them, and grade submissions."""
import csv
import io
import os
import shutil
from datetime import datetime

from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    flash,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from ..audit import log
from ..chapter_upload import import_question_bank
from ..auth_utils import current_user
from ..database import db_session
from ..decorators import role_required
from ..helpers import (
    build_grade_context,
    get_grade,
    get_submission,
    get_user_classes,
    save_grade,
    snapshot_question_to_aq,
    user_has_class_access,
)
from ..models import (
    Answer,
    Assignment,
    AssignmentQuestion,
    Chapter,
    Class,
    Course,
    Grade,
    InviteCode,
    Question,
    QuestionOption,
    Submission,
    UploadedFile,
    User,
    UserClassRole,
)
from ..storage import chapter_resource_dir

bp = Blueprint("teacher", __name__, url_prefix="/teacher")


def _teacher_classes():
    """Return all classes where the current user is a teacher."""
    return get_user_classes(current_user(), role_in_class="teacher")


def _class_ids():
    return [c.id for c in _teacher_classes()]


def _current_teacher_class():
    user = current_user()
    classes = _teacher_classes()
    class_by_id = {klass.id: klass for klass in classes}
    # SSO writes the portal-selected class to the session. The account field is
    # retained as a compatibility fallback for sessions created before SSO.
    for current_class_id in (session.get("current_class_id"), user.class_id):
        if current_class_id in class_by_id:
            session["current_class_id"] = current_class_id
            return class_by_id[current_class_id]
    # Compatibility for a teacher with one class whose session predates the
    # current-class SSO claim.
    if len(classes) == 1:
        session["current_class_id"] = classes[0].id
        return classes[0]
    return None


def _teacher_courses():
    current_class = _current_teacher_class()
    return [current_class.course] if current_class is not None else []


def _teacher_course(course_id):
    if course_id not in {course.id for course in _teacher_courses()}:
        abort(403)
    course = db_session.get(Course, course_id)
    if course is None:
        abort(404)
    return course


def _teacher_chapter(chapter_id):
    chapter = db_session.get(Chapter, chapter_id)
    if chapter is None:
        abort(404)
    _teacher_course(chapter.course_id)
    return chapter


def _question_sections(questions):
    """Keep Markdown section order while grouping each section's questions."""
    sections = []
    for question in questions:
        if not sections or sections[-1]["type"] != question.type:
            sections.append({
                "type": question.type,
                "label": question.type_label,
                "questions": [],
            })
        sections[-1]["questions"].append(question)
    return sections


# --------------------------------------------------------------------------
# Dashboard / lists
# --------------------------------------------------------------------------
@bp.route("/")
@role_required("teacher")
def dashboard():
    user = current_user()
    current_class = _current_teacher_class()
    assignments = (
        db_session.query(Assignment)
        .filter_by(publisher_id=user.id, class_id=current_class.id)
        .order_by(Assignment.created_at.desc())
        .all()
        if current_class is not None
        else []
    )
    classes = [current_class] if current_class is not None else []
    courses = _teacher_courses()
    return render_template(
        "teacher/dashboard.html",
        assignments=assignments,
        classes=classes,
        courses=courses,
    )


@bp.route("/classes", methods=["POST"])
@role_required("teacher")
def create_class():
    abort(403)


# --------------------------------------------------------------------------
# Chapters and question banks
# --------------------------------------------------------------------------
@bp.route("/chapters")
@role_required("teacher")
def chapters():
    current_class = _current_teacher_class()
    courses = _teacher_courses()
    selected_course = current_class.course if current_class is not None else None
    chapter_rows = (
        db_session.query(Chapter)
        .filter_by(course_id=selected_course.id)
        .order_by(Chapter.chapter_number)
        .all()
        if selected_course
        else []
    )
    question_counts = {
        chapter.id: db_session.query(Question).filter_by(chapter_id=chapter.id).count()
        for chapter in chapter_rows
    }
    return render_template(
        "teacher/chapters.html",
        current_class=current_class,
        courses=courses,
        selected_course=selected_course,
        chapters=chapter_rows,
        question_counts=question_counts,
    )


@bp.route("/courses/<int:course_id>/chapters", methods=["POST"])
@role_required("teacher")
def create_chapter(course_id):
    course = _teacher_course(course_id)
    number = request.form.get("chapter_number", type=int)
    title = (request.form.get("title") or "").strip()
    if number is None or number < 1:
        flash("章节号必须是大于零的整数", "error")
        return redirect(url_for("teacher.chapters", course_id=course.id))
    if db_session.query(Chapter).filter_by(
        course_id=course.id, chapter_number=number
    ).first():
        flash("该章节号已存在", "error")
        return redirect(url_for("teacher.chapters", course_id=course.id))

    chapter = Chapter(
        course_id=course.id,
        chapter_number=number,
        title=title or None,
    )
    db_session.add(chapter)
    db_session.commit()
    log("teacher.create_chapter", f"course_id={course.id} chapter_id={chapter.id}")
    flash("章节已创建，现在可以进入习题管理上传题库", "success")
    return redirect(url_for("teacher.chapter_questions", chapter_id=chapter.id))


@bp.route("/chapters/<int:chapter_id>", methods=["POST"])
@role_required("teacher")
def update_chapter(chapter_id):
    chapter = _teacher_chapter(chapter_id)
    course_id = chapter.course_id
    if request.form.get("action") == "delete":
        if db_session.query(Assignment).filter_by(chapter_id=chapter.id).count():
            flash("该章节已有作业，不能删除", "error")
            return redirect(url_for("teacher.chapters", course_id=course_id))
        for question in db_session.query(Question).filter_by(chapter_id=chapter.id).all():
            db_session.query(QuestionOption).filter_by(question_id=question.id).delete()
        db_session.query(Question).filter_by(chapter_id=chapter.id).delete()
        resource_directory = chapter_resource_dir(chapter.id)
        if os.path.isdir(resource_directory):
            shutil.rmtree(resource_directory, ignore_errors=True)
        db_session.delete(chapter)
        db_session.commit()
        log("teacher.delete_chapter", f"chapter_id={chapter_id}")
        flash("章节及其未发布习题已删除", "success")
        return redirect(url_for("teacher.chapters", course_id=course_id))

    number = request.form.get("chapter_number", type=int)
    title = (request.form.get("title") or "").strip()
    if number is None or number < 1:
        flash("章节号必须是大于零的整数", "error")
        return redirect(url_for("teacher.chapters", course_id=course_id))
    duplicate = db_session.query(Chapter).filter(
        Chapter.course_id == course_id,
        Chapter.chapter_number == number,
        Chapter.id != chapter.id,
    ).first()
    if duplicate:
        flash("该章节号已存在", "error")
        return redirect(url_for("teacher.chapters", course_id=course_id))
    chapter.chapter_number = number
    chapter.title = title or None
    db_session.commit()
    log("teacher.update_chapter", f"chapter_id={chapter_id}")
    flash("章节信息已更新", "success")
    return redirect(url_for("teacher.chapters", course_id=course_id))


@bp.route("/chapters/<int:chapter_id>/questions")
@role_required("teacher")
def chapter_questions(chapter_id):
    chapter = _teacher_chapter(chapter_id)
    questions = (
        db_session.query(Question)
        .filter_by(chapter_id=chapter.id)
        .order_by(Question.id)
        .all()
    )
    return render_template(
        "teacher/chapter_questions.html",
        chapter=chapter,
        questions=questions,
        question_sections=_question_sections(questions),
    )


@bp.route("/chapters/<int:chapter_id>/questions", methods=["POST"])
@role_required("teacher")
def upload_chapter_questions(chapter_id):
    chapter = _teacher_chapter(chapter_id)
    try:
        message = import_question_bank(chapter, request.files.get("question_bank"))
    except (OSError, UnicodeError, ValueError) as error:
        flash(str(error), "error")
    else:
        log("teacher.upload_question_bank", f"chapter_id={chapter.id}")
        flash(message, "success")
    return redirect(url_for("teacher.chapter_questions", chapter_id=chapter.id))


@bp.route("/assignments")
@role_required("teacher")
def assignments():
    return redirect(url_for("teacher.dashboard"))


# --------------------------------------------------------------------------
# Publish
# --------------------------------------------------------------------------
@bp.route("/assignments/new")
@role_required("teacher")
def new_assignment():
    current_class = _current_teacher_class()
    if current_class is None:
        return render_template(
            "teacher/new_assignment.html",
            current_class=None,
            course=None,
            chapters=[],
            questions=[],
            selected_chapter_id=None,
        )

    chapter_id = request.args.get("chapter_id", type=int)
    chapters = (
        db_session.query(Chapter)
        .filter_by(course_id=current_class.course_id)
        .order_by(Chapter.chapter_number)
        .all()
    )
    accessible_chapter_ids = {chapter.id for chapter in chapters}
    if chapter_id not in accessible_chapter_ids:
        chapter_id = None
    questions = (
        db_session.query(Question)
        .filter_by(chapter_id=chapter_id)
        .order_by(Question.id)
        .all()
        if chapter_id
        else []
    )
    return render_template(
        "teacher/new_assignment.html",
        current_class=current_class,
        course=current_class.course,
        chapters=chapters,
        questions=questions,
        question_sections=_question_sections(questions),
        selected_chapter_id=chapter_id,
    )


@bp.route("/assignments", methods=["POST"])
@role_required("teacher")
def create_assignment():
    user = current_user()
    klass = _current_teacher_class()
    if klass is None:
        flash("请先在服务门户选择当前工作班级", "error")
        return redirect(url_for("teacher.new_assignment"))
    course_id = klass.course_id
    chapter_id = request.form.get("chapter_id", type=int)
    title = (request.form.get("title") or "").strip()
    description = (request.form.get("description") or "").strip()
    due_str = (request.form.get("due_at") or "").strip()
    action = request.form.get("action", "publish")
    question_ids = request.form.getlist("question_ids", type=int)

    if not title:
        flash("作业标题不能为空", "error")
        return redirect(url_for("teacher.new_assignment"))
    if not question_ids:
        flash("请至少勾选一道题目", "error")
        return redirect(url_for("teacher.new_assignment"))

    chapter = db_session.get(Chapter, chapter_id) if chapter_id else None
    if chapter is None or chapter.course_id != course_id or course_id != klass.course_id:
        flash("所选课程或章节无效", "error")
        return redirect(url_for("teacher.new_assignment"))

    due_at = None
    if due_str:
        try:
            due_at = datetime.strptime(due_str, "%Y-%m-%dT%H:%M")
        except ValueError:
            flash("截止时间格式无效", "error")
            return redirect(url_for("teacher.new_assignment"))

    is_publish = action == "publish"
    if is_publish and due_at is None:
        flash("发布作业时必须设置截止时间", "error")
        return redirect(url_for("teacher.new_assignment"))
    if is_publish and due_at is not None and due_at <= datetime.now():
        flash("截止时间必须在未来", "error")
        return redirect(url_for("teacher.new_assignment"))

    assignment = Assignment(
        title=title,
        course_id=course_id,
        chapter_id=chapter_id,
        class_id=klass.id,
        publisher_id=user.id,
        description=description or None,
        due_at=due_at,
        status="published" if is_publish else "draft",
        published_at=datetime.now() if is_publish else None,
    )
    db_session.add(assignment)
    db_session.flush()

    valid_question_ids = {
        q.id for q in db_session.query(Question).filter_by(chapter_id=chapter_id).all()
    }
    for idx, qid in enumerate(question_ids):
        if qid not in valid_question_ids:
            continue
        question = db_session.get(Question, qid)
        if question is None:
            continue
        aq = AssignmentQuestion(
            assignment_id=assignment.id,
            question_id=qid,
            sort_order=idx,
            question_number=question.question_number,
            type=question.type,
            stem_markdown=question.stem_markdown,
            stem_html=question.stem_html,
        )
        db_session.add(aq)
        db_session.flush()
        # Snapshot options for choice questions
        snapshot_question_to_aq(aq, question)

    db_session.commit()
    log(
        "teacher.create_assignment",
        f"assignment_id={assignment.id} class_id={klass.id} "
        f"status={assignment.status} questions={len(question_ids)}",
    )

    flash("作业已发布" if is_publish else "草稿已保存", "success")
    return redirect(url_for("teacher.assignment_detail", assignment_id=assignment.id))


def _owned_assignment(assignment_id):
    assignment = db_session.get(Assignment, assignment_id)
    current_class = _current_teacher_class()
    if (
        assignment is None
        or current_class is None
        or assignment.publisher_id != current_user().id
        or assignment.class_id != current_class.id
    ):
        abort(403)
    return assignment


def _parse_due_at(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        return False


@bp.route("/assignments/<int:assignment_id>/edit")
@role_required("teacher")
def edit_assignment(assignment_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "draft":
        flash("只有草稿可以编辑", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment.id)
        )

    has_submissions = (
        db_session.query(Submission).filter_by(assignment_id=assignment.id).count() > 0
    )
    questions = (
        db_session.query(Question)
        .filter_by(chapter_id=assignment.chapter_id)
        .order_by(Question.id)
        .all()
    )
    selected_question_ids = {
        aq.question_id
        for aq in assignment.assignment_questions
        if aq.question_id is not None
    }
    return render_template(
        "teacher/edit_assignment.html",
        assignment=assignment,
        has_submissions=has_submissions,
        question_sections=_question_sections(questions),
        selected_question_ids=selected_question_ids,
    )


@bp.route("/assignments/<int:assignment_id>/edit", methods=["POST"])
@role_required("teacher")
def update_assignment(assignment_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "draft":
        flash("只有草稿可以编辑", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment.id)
        )

    title = (request.form.get("title") or "").strip()
    description = (request.form.get("description") or "").strip()
    due_at = _parse_due_at((request.form.get("due_at") or "").strip())
    is_publish = request.form.get("action") == "publish"
    has_submissions = (
        db_session.query(Submission).filter_by(assignment_id=assignment.id).count() > 0
    )

    if not title:
        flash("作业标题不能为空", "error")
        return redirect(url_for("teacher.edit_assignment", assignment_id=assignment.id))
    if due_at is False:
        flash("截止时间格式无效", "error")
        return redirect(url_for("teacher.edit_assignment", assignment_id=assignment.id))
    if is_publish and due_at is None:
        flash("发布作业时必须设置截止时间", "error")
        return redirect(url_for("teacher.edit_assignment", assignment_id=assignment.id))
    if is_publish and due_at <= datetime.now():
        flash("截止时间必须在未来", "error")
        return redirect(url_for("teacher.edit_assignment", assignment_id=assignment.id))

    if not has_submissions:
        question_ids = request.form.getlist("question_ids", type=int)
        if not question_ids:
            flash("请至少勾选一道题目", "error")
            return redirect(
                url_for("teacher.edit_assignment", assignment_id=assignment.id)
            )
        questions = (
            db_session.query(Question)
            .filter(
                Question.chapter_id == assignment.chapter_id,
                Question.id.in_(question_ids),
            )
            .all()
        )
        question_by_id = {question.id: question for question in questions}
        if len(question_by_id) != len(set(question_ids)):
            flash("所选题目无效，请重新选择", "error")
            return redirect(
                url_for("teacher.edit_assignment", assignment_id=assignment.id)
            )

        assignment.assignment_questions.clear()
        db_session.flush()
        for sort_order, question_id in enumerate(question_ids):
            question = question_by_id[question_id]
            assignment_question = AssignmentQuestion(
                assignment_id=assignment.id,
                question_id=question.id,
                sort_order=sort_order,
                question_number=question.question_number,
                type=question.type,
                stem_markdown=question.stem_markdown,
                stem_html=question.stem_html,
            )
            db_session.add(assignment_question)
            db_session.flush()
            snapshot_question_to_aq(assignment_question, question)

    assignment.title = title
    assignment.description = description or None
    assignment.due_at = due_at
    if is_publish:
        assignment.status = "published"
        assignment.published_at = datetime.now()
    db_session.commit()
    log(
        "teacher.update_assignment",
        f"assignment_id={assignment.id} status={assignment.status} "
        f"questions_locked={has_submissions}",
    )
    flash("作业已发布" if is_publish else "草稿修改已保存", "success")
    return redirect(url_for("teacher.dashboard"))


@bp.route("/assignments/<int:assignment_id>/delete", methods=["POST"])
@role_required("teacher")
def delete_assignment(assignment_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "draft":
        flash("只有草稿可以删除", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment.id)
        )
    title = assignment.title
    submission_ids = [
        row[0]
        for row in db_session.query(Submission.id)
        .filter_by(assignment_id=assignment.id)
        .all()
    ]
    answer_ids = (
        [
            row[0]
            for row in db_session.query(Answer.id)
            .filter(Answer.submission_id.in_(submission_ids))
            .all()
        ]
        if submission_ids
        else []
    )
    attachment_paths = (
        [
            row[0]
            for row in db_session.query(UploadedFile.file_path)
            .filter(UploadedFile.answer_id.in_(answer_ids))
            .all()
        ]
        if answer_ids
        else []
    )

    if answer_ids:
        db_session.query(UploadedFile).filter(
            UploadedFile.answer_id.in_(answer_ids)
        ).delete(synchronize_session=False)
        db_session.query(Answer).filter(Answer.id.in_(answer_ids)).delete(
            synchronize_session=False
        )
    if submission_ids:
        db_session.query(Grade).filter(
            Grade.submission_id.in_(submission_ids)
        ).delete(synchronize_session=False)
        db_session.query(Submission).filter(
            Submission.id.in_(submission_ids)
        ).delete(synchronize_session=False)
    db_session.delete(assignment)
    db_session.commit()

    upload_root = os.path.realpath(current_app.config["UPLOAD_DIR"])
    attachment_failures = 0
    for relative_path in attachment_paths:
        full_path = os.path.realpath(os.path.join(upload_root, relative_path))
        try:
            if os.path.commonpath([upload_root, full_path]) != upload_root:
                attachment_failures += 1
            elif os.path.isfile(full_path):
                os.remove(full_path)
        except (OSError, ValueError):
            attachment_failures += 1

    log(
        "teacher.delete_assignment",
        f"assignment_id={assignment_id} title={title} "
        f"submissions={len(submission_ids)} answers={len(answer_ids)} "
        f"attachments={len(attachment_paths)} attachment_failures={attachment_failures}",
    )
    if attachment_failures:
        flash("作业及学生答案已删除，但部分磁盘附件清理失败", "error")
    else:
        flash("作业及其学生答案已删除", "success")
    return redirect(url_for("teacher.dashboard"))


@bp.route("/assignments/<int:assignment_id>/publish", methods=["POST"])
@role_required("teacher")
def publish_draft(assignment_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "draft":
        flash("只有草稿可以发布", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )
    if assignment.due_at is None:
        flash("发布作业前请设置截止时间", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )
    if assignment.due_at <= datetime.now():
        flash("截止时间必须在未来", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )
    assignment.status = "published"
    assignment.published_at = datetime.now()
    db_session.commit()
    log("teacher.publish_draft", f"assignment_id={assignment_id}")
    flash("作业已发布", "success")
    return redirect(
        url_for("teacher.assignment_detail", assignment_id=assignment_id)
    )


@bp.route("/assignments/<int:assignment_id>/withdraw", methods=["POST"])
@role_required("teacher")
def withdraw_assignment(assignment_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "published":
        flash("只有已发布的作业可以撤回", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )

    assignment.status = "draft"
    assignment.published_at = None
    db_session.commit()
    log("teacher.withdraw_assignment", f"assignment_id={assignment_id}")
    flash("作业已撤回并转为草稿，学生提交记录已保留", "success")
    return redirect(
        url_for("teacher.assignment_detail", assignment_id=assignment_id)
    )


# --------------------------------------------------------------------------
# Detail / grading
# --------------------------------------------------------------------------
@bp.route("/assignments/<int:assignment_id>")
@role_required("teacher")
def assignment_detail(assignment_id):
    assignment = _owned_assignment(assignment_id)

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
        "teacher/assignment_detail.html",
        assignment=assignment,
        rows=rows,
        has_submissions=(
            db_session.query(Submission)
            .filter_by(assignment_id=assignment.id)
            .count()
            > 0
        ),
    )


@bp.route(
    "/assignments/<int:assignment_id>/grade/<int:student_id>",
    methods=["GET", "POST"],
)
@role_required("teacher")
def grade_student(assignment_id, student_id):
    user = current_user()
    assignment = _owned_assignment(assignment_id)
    if assignment.status not in ("published", "closed"):
        flash("草稿状态的作业不能批改", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )
    student = db_session.get(User, student_id)
    if student is None:
        abort(404)
    # Verify student belongs to the assignment's class
    if not user_has_class_access(student, assignment.class_id, "student"):
        abort(403)
    submission = get_submission(assignment.id, student.id)
    if submission is None or submission.status not in ("submitted", "graded"):
        flash("该学生尚未提交作业，不能批改", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )

    if request.method == "POST":
        ctx = build_grade_context(assignment, student)
        if ctx["submission"] is None:
            flash("该学生尚未作答，无法批改", "error")
            return redirect(
                url_for("teacher.assignment_detail", assignment_id=assignment_id)
            )
        action = request.form.get("action", "submit")
        finalize = action != "draft"
        raw_score = (request.form.get("score") or "").strip()
        score = _parse_score(raw_score)
        if raw_score and score is None:
            flash("分数格式无效", "error")
            return redirect(
                url_for(
                    "teacher.grade_student",
                    assignment_id=assignment_id,
                    student_id=student_id,
                )
            )
        if finalize and score is None:
            flash("提交批改时必须填写分数", "error")
            return redirect(
                url_for(
                    "teacher.grade_student",
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
            user.id,
            score,
            comment,
            question_comments,
            finalize=finalize,
        )
        log(
            "teacher.grade.submit" if finalize else "teacher.grade.save_draft",
            f"assignment_id={assignment_id} student_id={student_id} score={score}",
        )
        flash("批改已提交" if finalize else "批改已暂存", "success")
        return redirect(
            url_for(
                "teacher.grade_student",
                assignment_id=assignment_id,
                student_id=student_id,
            )
        )

    ctx = build_grade_context(assignment, student)
    return render_template("grading/grade.html", **ctx)


@bp.route(
    "/assignments/<int:assignment_id>/reopen/<int:student_id>", methods=["POST"]
)
@role_required("teacher")
def reopen_submission(assignment_id, student_id):
    assignment = _owned_assignment(assignment_id)
    if assignment.status != "published":
        flash("只有已发布的作业可以开放重交", "error")
        return redirect(
            url_for("teacher.assignment_detail", assignment_id=assignment_id)
        )
    # Verify student belongs to the assignment's class
    if not user_has_class_access(
        db_session.get(User, student_id), assignment.class_id, "student"
    ):
        abort(403)

    submission = get_submission(assignment_id, student_id)
    if submission is not None and submission.status in ("submitted", "graded"):
        submission.status = "saved"
        db_session.commit()
        log(
            "teacher.reopen_submission",
            f"assignment_id={assignment_id} student_id={student_id}",
        )
        flash("已开放重交", "success")
    return redirect(
        url_for("teacher.assignment_detail", assignment_id=assignment_id)
    )


def _parse_score(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Grade report CSV export
# --------------------------------------------------------------------------
@bp.route("/export-grades")
@role_required("teacher")
def export_grades():
    current_class = _current_teacher_class()
    if current_class is None:
        flash("你尚未关联任何班级", "error")
        return redirect(url_for("teacher.dashboard"))
    cids = [current_class.id]

    class_id = request.args.get("class_id", type=int)
    if class_id is not None and class_id not in cids:
        abort(403)

    # If no class_id specified, show the class selector page
    if class_id is None:
        classes = [current_class]
        return render_template(
            "teacher/export_grades.html",
            classes=classes,
        )

    target_cids = [class_id]

    rows = (
        db_session.query(
            Class.name,
            Assignment.title,
            User.student_no,
            User.name,
            User.email,
            Submission.status,
            Submission.submitted_at,
            Submission.is_late,
            Grade.score,
            Grade.comment,
        )
        .select_from(Submission)
        .join(Assignment)
        .join(Class, Assignment.class_id == Class.id)
        .join(User, Submission.student_id == User.id)
        .outerjoin(
            Grade,
            (Grade.submission_id == Submission.id)
            & (Grade.status == "submitted"),
        )
        .filter(Class.id.in_(target_cids))
        .order_by(Class.name, Assignment.title, User.student_no)
        .all()
    )

    buf = io.StringIO()
    # UTF-8 BOM for MS Excel compatibility
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow(
        [
            "班级", "作业", "学号", "学生姓名", "邮箱",
            "提交状态", "提交时间", "是否迟交", "分数", "评价",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r[0], r[1], r[2] or "", r[3], r[4],
                r[5], r[6].strftime("%Y-%m-%d %H:%M") if r[6] else "",
                "是" if r[7] else "否",
                r[8], r[9] or "",
            ]
        )

    buf.seek(0)
    today = datetime.now().strftime("%Y-%m-%d")
    return Response(
        buf.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=teacher-grades-{today}.csv",
        },
    )
