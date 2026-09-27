"""Student views: answer, save, submit, upload files, and view grades."""
import os
import re
from datetime import datetime
from io import BytesIO

from flask import (
    Blueprint,
    abort,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    Response,
    stream_with_context,
    url_for,
)
from PIL import Image

from ..ai_tutor import (
    AiTutorError,
    ask_ai_tutor,
    build_review_context,
    open_ai_tutor_stream,
)
from ..audit import log
from ..auth_utils import current_user
from ..database import db_session
from ..decorators import login_required, role_required
from ..helpers import (
    ensure_submission,
    get_grade,
    get_submission,
    get_user_classes,
    prepare_question_items,
    user_has_class_access,
)
from ..models import (
    Answer,
    Assignment,
    AssignmentQuestion,
    Submission,
    UploadedFile,
    UserClassRole,
)

bp = Blueprint("student", __name__, url_prefix="/student")

_ALLOWED_EXT = {"jpg", "jpeg", "png", "webp"}


def _student_classes():
    """Return all classes where the current user is a student."""
    return get_user_classes(current_user(), role_in_class="student")


def _student_class_ids():
    return [c.id for c in _student_classes()]


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
@bp.route("/")
@role_required("student")
def dashboard():
    user = current_user()
    cids = _student_class_ids()
    if not cids:
        return render_template(
            "student/dashboard.html",
            todo=[],
            completed=[],
            graded=[],
            classes=[],
        )

    all_assignments = (
        db_session.query(Assignment)
        .filter(Assignment.class_id.in_(cids))
        .order_by(Assignment.created_at.desc())
        .all()
    )

    todo = []
    completed = []
    graded = []
    for a in all_assignments:
        sub = get_submission(a.id, user.id)
        grade = get_grade(sub)
        has_completed_submission = (
            sub is not None and sub.status in ("submitted", "graded")
        )
        if a.status != "published" and not has_completed_submission:
            continue
        if (
            sub is not None
            and sub.status == "graded"
            and grade is not None
            and grade.status == "submitted"
        ):
            graded.append((a, sub, grade))
        elif has_completed_submission:
            completed.append((a, sub))
        else:
            status = sub.status if sub else "not_started"
            todo.append((a, sub, status))
    return render_template(
        "student/dashboard.html",
        todo=todo,
        completed=completed,
        graded=graded,
        classes=_student_classes(),
    )


# --------------------------------------------------------------------------
# Answer page
# --------------------------------------------------------------------------
@bp.route("/assignments/<int:assignment_id>")
@role_required("student")
def answer_page(assignment_id):
    user = current_user()
    assignment = db_session.get(Assignment, assignment_id)
    if assignment is None or not user_has_class_access(
        user, assignment.class_id, "student"
    ):
        abort(403)

    submission = get_submission(assignment.id, user.id)
    has_completed_submission = (
        submission is not None and submission.status in ("submitted", "graded")
    )
    if assignment.status != "published" and not has_completed_submission:
        abort(403)
    if submission is None:
        submission = ensure_submission(assignment, user)
    items = prepare_question_items(assignment, submission)
    grade = get_grade(submission)
    ai_review_mode = (
        submission.status == "graded"
        and grade is not None
        and grade.status == "submitted"
    )
    can_edit = (
        assignment.status == "published"
        and submission.status in ("not_started", "saved")
    )
    is_past_due = assignment.due_at is not None and datetime.now() > assignment.due_at

    return render_template(
        "student/answer.html",
        assignment=assignment,
        submission=submission,
        grade=grade,
        items=items,
        can_edit=can_edit,
        can_ask_ai=assignment.status == "published",
        ai_review_mode=ai_review_mode,
        is_historical=assignment.status != "published",
        is_past_due=is_past_due,
    )


@bp.route(
    "/assignments/<int:assignment_id>/questions/<int:question_id>/ai-chat",
    methods=["POST"],
)
@role_required("student")
def ai_chat(assignment_id, question_id):
    try:
        user, assignment, question, prompt, history, review_context = _ai_chat_request(
            assignment_id, question_id
        )
        answer = ask_ai_tutor(
            current_app.config,
            user,
            assignment,
            question,
            prompt,
            history,
            review_context=review_context,
        )
    except AiTutorError as error:
        status = error.status if 400 <= error.status < 500 else 502
        return jsonify({"error": str(error)}), status

    return jsonify({"answer": answer})


@bp.route(
    "/assignments/<int:assignment_id>/questions/<int:question_id>/ai-chat/stream",
    methods=["POST"],
)
@role_required("student")
def ai_chat_stream(assignment_id, question_id):
    try:
        user, assignment, question, prompt, history, review_context = _ai_chat_request(
            assignment_id, question_id
        )
        upstream = open_ai_tutor_stream(
            current_app.config,
            user,
            assignment,
            question,
            prompt,
            history,
            review_context=review_context,
        )
    except AiTutorError as error:
        status = error.status if 400 <= error.status < 500 else 502
        return jsonify({"error": str(error)}), status

    @stream_with_context
    def relay():
        try:
            while True:
                line = upstream.readline()
                if not line:
                    break
                yield line
        finally:
            upstream.close()

    return Response(
        relay(),
        content_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _ai_chat_request(assignment_id, question_id):
    user = current_user()
    assignment = db_session.get(Assignment, assignment_id)
    if (
        assignment is None
        or assignment.status != "published"
        or not user_has_class_access(user, assignment.class_id, "student")
    ):
        raise AiTutorError("无权访问该作业", 403)

    submission = get_submission(assignment.id, user.id)
    grade = get_grade(submission)
    review_mode = (
        submission is not None
        and submission.status == "graded"
        and grade is not None
        and grade.status == "submitted"
    )
    question = (
        db_session.query(AssignmentQuestion)
        .filter_by(id=question_id, assignment_id=assignment.id)
        .first()
    )
    if question is None:
        raise AiTutorError("题目不存在", 404)

    payload = request.get_json(silent=True) or {}
    prompt = payload.get("prompt")
    history = payload.get("history", [])
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.strip()) > 4000:
        raise AiTutorError("请输入不超过 4000 字的提问", 400)
    if not isinstance(history, list) or len(history) > 12:
        raise AiTutorError("对话记录无效", 400)

    clean_history = []
    for turn in history:
        if not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant"):
            raise AiTutorError("对话记录无效", 400)
        content = turn.get("content")
        if not isinstance(content, str) or not content.strip() or len(content.strip()) > 4000:
            raise AiTutorError("对话记录无效", 400)
        clean_history.append({"role": turn["role"], "content": content.strip()})

    review_context = None
    if review_mode:
        answer = (
            db_session.query(Answer)
            .filter_by(
                submission_id=submission.id,
                assignment_question_id=question.id,
            )
            .first()
        )
        review_context = build_review_context(question, answer, grade)

    return user, assignment, question, prompt.strip(), clean_history, review_context


# --------------------------------------------------------------------------
# Save / Submit
# --------------------------------------------------------------------------
@bp.route("/assignments/<int:assignment_id>/save", methods=["POST"])
@role_required("student")
def save(assignment_id):
    return _save_or_submit(assignment_id, "saved")


@bp.route("/assignments/<int:assignment_id>/submit", methods=["POST"])
@role_required("student")
def submit(assignment_id):
    return _save_or_submit(assignment_id, "submitted")


def _save_or_submit(assignment_id, target_status):
    user = current_user()
    assignment = db_session.get(Assignment, assignment_id)
    if assignment is None:
        abort(404)

    # Validate class membership
    if not user_has_class_access(user, assignment.class_id, "student"):
        abort(403)
    if assignment.status != "published":
        flash("该作业尚未发布", "error")
        return redirect(url_for("student.answer_page", assignment_id=assignment_id))

    # Due time enforcement for submit
    if target_status == "submitted":
        if assignment.due_at is not None and datetime.now() > assignment.due_at:
            flash("作业已截止，无法提交", "error")
            return redirect(
                url_for("student.answer_page", assignment_id=assignment_id)
            )

    submission = get_submission(assignment.id, user.id)
    if submission is None:
        submission = ensure_submission(assignment, user)
    if submission.status not in ("not_started", "saved"):
        flash("作业已提交，无法修改", "error")
        return redirect(url_for("student.answer_page", assignment_id=assignment_id))

    aqs = (
        db_session.query(AssignmentQuestion)
        .filter_by(assignment_id=assignment.id)
        .order_by(AssignmentQuestion.sort_order)
        .all()
    )
    for aq in aqs:
        value = (request.form.get(f"q_{aq.id}") or "").strip()
        answer = (
            db_session.query(Answer)
            .filter_by(submission_id=submission.id, assignment_question_id=aq.id)
            .first()
        )
        if answer is None:
            answer = Answer(
                submission_id=submission.id, assignment_question_id=aq.id
            )
            db_session.add(answer)
            db_session.flush()

        # Use snapshot type from aq, not from live question
        if aq.type == "choice":
            answer.choice_answer = value if value in ("A", "B", "C", "D") else None
            answer.text_answer = None
        else:
            answer.text_answer = value or None
            answer.choice_answer = None
        answer.updated_at = datetime.now()

    submission.status = target_status
    submission.updated_at = datetime.now()
    if target_status == "submitted":
        submission.submitted_at = datetime.now()
        # Mark late if past due
        if assignment.due_at is not None and submission.submitted_at > assignment.due_at:
            submission.is_late = True
    if target_status == "saved" and submission.first_saved_at is None:
        submission.first_saved_at = datetime.now()

    db_session.commit()
    log(
        f"student.{target_status}",
        f"assignment_id={assignment_id} is_late={submission.is_late}",
    )

    label = "暂存" if target_status == "saved" else "提交"
    flash(f"作业已{label}成功", "success")
    return redirect(url_for("student.answer_page", assignment_id=assignment_id))


# --------------------------------------------------------------------------
# File upload (AJAX)
# --------------------------------------------------------------------------
@bp.route("/answers/<int:answer_id>/files", methods=["POST"])
@role_required("student")
def upload_file(answer_id):
    user = current_user()
    answer = db_session.get(Answer, answer_id)
    if answer is None:
        return jsonify({"error": "答案不存在"}), 404

    submission = db_session.get(Submission, answer.submission_id)
    if submission is None or submission.student_id != user.id:
        return jsonify({"error": "无权操作"}), 403
    if submission.status not in ("not_started", "saved"):
        return jsonify({"error": "作业已提交，无法上传"}), 400

    aq = answer.assignment_question
    if aq is None or aq.type != "comprehensive":
        return jsonify({"error": "仅综合题支持上传图片"}), 400

    # Check per-answer file limit
    existing_files = (
        db_session.query(UploadedFile).filter_by(answer_id=answer.id).all()
    )
    if len(existing_files) >= current_app.config["MAX_FILES_PER_ANSWER"]:
        return jsonify({"error": "已达到上传数量上限"}), 400

    # Check student has upload_dir
    if not user.upload_dir or not user.student_no:
        return jsonify({"error": "未设置学生上传目录，请联系管理员"}), 400

    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "请选择文件"}), 400

    ext = os.path.splitext(f.filename)[1].lower().lstrip(".")
    if ext not in _ALLOWED_EXT:
        return jsonify({"error": "仅支持 JPG、JPEG、PNG、WEBP 格式"}), 400

    # Derive new filename: YYYY-MM-DD-problem{k}-{l}.png
    today = datetime.now().strftime("%Y-%m-%d")
    problem_no = aq.question_number
    # Find the next available l: use max existing l + 1, or 1 if none
    _L_RE = re.compile(rf"-problem{problem_no}-(\d+)\.png$")
    max_l = 0
    for uf in existing_files:
        m = _L_RE.search(uf.file_path)
        if m:
            max_l = max(max_l, int(m.group(1)))
    l = max_l + 1
    new_name = f"{today}-problem{problem_no}-{l}.png"

    # Destination directory: uploads/<upload_dir>/
    dest_dir = os.path.join(current_app.config["UPLOAD_DIR"], user.upload_dir)
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, new_name)

    # Convert to PNG and save
    try:
        img = Image.open(f.stream)
        img = img.convert("RGB")  # ensure no RGBA palette issues
        img.save(dest_path, "PNG")
        file_size = os.path.getsize(dest_path)
    except Exception:
        return jsonify({"error": "图片处理失败，请确认文件为有效图片"}), 400

    if file_size > current_app.config["MAX_ANSWER_FILE_SIZE"]:
        os.remove(dest_path)
        return jsonify({"error": "文件大小超过上限"}), 400

    uf = UploadedFile(
        answer_id=answer.id,
        uploader_id=user.id,
        file_path=os.path.join(user.upload_dir, new_name),
        original_name=f.filename,
        mime_type="image/png",
        file_size=file_size,
    )
    db_session.add(uf)
    db_session.commit()

    return jsonify(
        {
            "ok": True,
            "file": {
                "id": uf.id,
                "name": uf.original_name,
                "size": uf.file_size,
                "url": url_for("files.serve", file_id=uf.id),
            },
        }
    )


@bp.route("/files/<int:file_id>/delete", methods=["POST"])
@role_required("student")
def delete_file(file_id):
    user = current_user()
    uf = db_session.get(UploadedFile, file_id)
    if uf is None:
        return jsonify({"error": "文件不存在"}), 404
    if uf.uploader_id != user.id:
        return jsonify({"error": "无权操作"}), 403
    answer = db_session.get(Answer, uf.answer_id)
    if answer is None:
        return jsonify({"error": "答案不存在"}), 404
    submission = db_session.get(Submission, answer.submission_id)
    if submission is None or submission.student_id != user.id:
        return jsonify({"error": "无权操作"}), 403
    if submission.status not in ("not_started", "saved"):
        return jsonify({"error": "作业已提交，无法删除"}), 400

    # Remove file from disk (file_path is relative to UPLOAD_DIR)
    full_path = os.path.join(
        current_app.config["UPLOAD_DIR"], uf.file_path
    )
    if os.path.isfile(full_path):
        os.remove(full_path)

    db_session.delete(uf)
    db_session.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# Grades
# --------------------------------------------------------------------------
@bp.route("/grades")
@role_required("student")
def grades():
    user = current_user()
    subs = (
        db_session.query(Submission)
        .filter_by(student_id=user.id)
        .order_by(Submission.updated_at.desc())
        .all()
    )
    rows = []
    for sub in subs:
        grade = get_grade(sub)
        if (
            grade is not None
            and grade.status == "submitted"
            and sub.status == "graded"
        ):
            rows.append((sub.assignment, grade))
    return render_template("student/grades.html", rows=rows)
