"""Super-admin management views."""
import csv
import io
import os
import re
import secrets
from datetime import datetime

from flask import (
    Blueprint,
    Response,
    current_app,
    flash,
    redirect,
    render_template,
    request,
    send_file,
    url_for,
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash

from ..audit import log
from ..database import db_session
from ..decorators import role_required
from ..models import (
    Assignment,
    AuditLog,
    Chapter,
    Class,
    Course,
    Grade,
    InviteCode,
    Question,
    Submission,
    User,
    UserClassRole,
)
from ..question_parser import (
    import_chapter_questions,
    ingest_referenced_images,
)
from ..storage import chapter_resource_dir

bp = Blueprint("admin", __name__, url_prefix="/admin")

_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_code(length=8):
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
@bp.route("/")
@role_required("super_admin")
def dashboard():
    counts = {
        "users": db_session.query(User).count(),
        "courses": db_session.query(Course).count(),
        "classes": db_session.query(Class).count(),
        "chapters": db_session.query(Chapter).count(),
        "questions": db_session.query(Question).count(),
        "assignments": db_session.query(Assignment).count(),
        "submissions": db_session.query(Submission).count(),
    }
    return render_template("admin/dashboard.html", counts=counts)


# --------------------------------------------------------------------------
# Users
# --------------------------------------------------------------------------
@bp.route("/users")
@role_required("super_admin")
def users():
    users = db_session.query(User).order_by(User.created_at.desc()).all()
    classes = db_session.query(Class).order_by(Class.name).all()
    return render_template("admin/users.html", users=users, classes=classes)


@bp.route("/users/create", methods=["POST"])
@role_required("super_admin")
def create_user():
    email = (request.form.get("email") or "").strip()
    password = (request.form.get("password") or "").strip()
    name = (request.form.get("name") or "").strip()
    role = request.form.get("role", "student")
    student_no = (request.form.get("student_no") or "").strip()

    if not email or not password or not name:
        flash("邮箱、密码、姓名不能为空", "error")
        return redirect(url_for("admin.users"))
    if email.lower() == current_app.config["SUPERUSER_EMAIL"]:
        flash("该邮箱已由根目录 superuser.toml 保留给超级用户", "error")
        return redirect(url_for("admin.users"))
    if role not in ("teacher", "ta", "student"):
        flash("无效的角色", "error")
        return redirect(url_for("admin.users"))
    if db_session.query(User).filter_by(email=email).first():
        flash("邮箱已被注册", "error")
        return redirect(url_for("admin.users"))
    if student_no:
        if not re.match(r"^[A-Za-z0-9]+$", student_no):
            flash("学号只能包含数字和英文字母", "error")
            return redirect(url_for("admin.users"))
        if db_session.query(User).filter_by(student_no=student_no).first():
            flash("学号已被使用", "error")
            return redirect(url_for("admin.users"))

    user = User(
        email=email,
        password_hash=generate_password_hash(password),
        name=name,
        role=role,
        student_no=student_no or None,
        enabled=True,
    )
    db_session.add(user)
    db_session.flush()

    # Create class roles from form
    enabled_class_ids = request.form.getlist("enabled_class_ids")
    for cid_str in enabled_class_ids:
        cid = int(cid_str) if cid_str else None
        if cid is None:
            continue
        r = request.form.get(f"role_{cid}")
        if r in ("teacher", "ta", "student"):
            db_session.add(UserClassRole(user_id=user.id, class_id=cid, role_in_class=r))

    # Create upload directory for students
    if role == "student" and student_no:
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            dirname = f"{today}-{student_no}"
            path = os.path.join(current_app.config["UPLOAD_DIR"], dirname)
            os.makedirs(path, exist_ok=True)
            user.upload_dir = dirname
        except OSError:
            pass  # warning shown below

    db_session.commit()
    log("admin.create_user", f"user_id={user.id} role={user.role}")
    flash("账号已创建", "success")
    return redirect(url_for("admin.users"))


@bp.route("/users/<int:user_id>", methods=["GET", "POST"])
@role_required("super_admin")
def edit_user(user_id):
    user = db_session.get(User, user_id)
    if user is None:
        flash("用户不存在", "error")
        return redirect(url_for("admin.users"))

    classes = db_session.query(Class).order_by(Class.name).all()

    if request.method == "POST":
        action = request.form.get("action", "update")
        if action == "delete":
            flash("请在统一系统的超级管理员账号管理页面删除账号，以确保数据先归档。", "error")
            return redirect(url_for("admin.users"))

        if user.role == "super_admin":
            flash("超级用户由根目录 superuser.toml 管理，不能在此修改", "error")
            return redirect(url_for("admin.users"))

        old_role = user.role
        role = request.form.get("role")
        if role not in ("teacher", "ta", "student"):
            role = "student"
        user.role = role
        user.name = (request.form.get("name") or user.name).strip() or user.name
        user.enabled = request.form.get("enabled") == "on"
        user.class_id = request.form.get("class_id", type=int) or None

        # Update student_no
        student_no = (request.form.get("student_no") or "").strip()
        if student_no:
            import re
            if not re.match(r"^[A-Za-z0-9]+$", student_no):
                flash("学号只能包含数字和英文字母", "error")
                return redirect(url_for("admin.edit_user", user_id=user.id))
            existing = db_session.query(User).filter(
                User.student_no == student_no, User.id != user.id
            ).first()
            if existing:
                flash("学号已被其他用户使用", "error")
                return redirect(url_for("admin.edit_user", user_id=user.id))
            user.student_no = student_no

        # Update class roles — checkbox + per-class select
        enabled_class_ids = {
            int(cid) for cid in request.form.getlist("enabled_class_ids") if cid
        }
        db_session.query(UserClassRole).filter_by(user_id=user.id).delete()
        for cid in enabled_class_ids:
            r = request.form.get(f"role_{cid}")
            if r in ("teacher", "ta", "student"):
                db_session.add(
                    UserClassRole(
                        user_id=user.id, class_id=cid, role_in_class=r
                    )
                )

        if role != old_role and not enabled_class_ids:
            user.class_id = None

        db_session.commit()
        log("admin.edit_user", f"user_id={user.id} role={user.role}")
        flash("账号已更新", "success")
        return redirect(url_for("admin.users"))

    user_class_roles = {
        ucr.class_id: ucr.role_in_class
        for ucr in db_session.query(UserClassRole).filter_by(user_id=user.id).all()
    }
    return render_template(
        "admin/edit_user.html",
        user=user,
        classes=classes,
        user_class_roles=user_class_roles,
    )


# --------------------------------------------------------------------------
# Courses
# --------------------------------------------------------------------------
@bp.route("/courses")
@role_required("super_admin")
def courses():
    courses = db_session.query(Course).order_by(Course.created_at.desc()).all()
    return render_template("admin/courses.html", courses=courses)


@bp.route("/courses", methods=["POST"])
@role_required("super_admin")
def create_course():
    name = (request.form.get("name") or "").strip()
    description = (request.form.get("description") or "").strip()
    if not name:
        flash("课程名称不能为空", "error")
        return redirect(url_for("admin.courses"))
    db_session.add(Course(name=name, description=description or None))
    db_session.commit()
    log("admin.create_course", f"name={name}")
    flash("课程已创建", "success")
    return redirect(url_for("admin.courses"))


@bp.route("/courses/<int:course_id>", methods=["POST"])
@role_required("super_admin")
def update_course(course_id):
    course = db_session.get(Course, course_id)
    if course is None:
        flash("课程不存在", "error")
        return redirect(url_for("admin.courses"))
    action = request.form.get("action", "update")
    if action == "delete":
        # Cascade delete all related records
        from ..models import (
            AssignmentQuestion, AssignmentQuestionOption,
            Answer, UploadedFile, Grade, Submission,
            QuestionOption, Question, Chapter, InviteCode, UserClassRole,
        )
        import os as _os
        import shutil
        upload_dir = current_app.config["UPLOAD_DIR"]
        for ch in db_session.query(Chapter).filter_by(course_id=course_id).all():
            for q in db_session.query(Question).filter_by(chapter_id=ch.id).all():
                db_session.query(QuestionOption).filter_by(question_id=q.id).delete()
            db_session.query(Question).filter_by(chapter_id=ch.id).delete()
            # Delete chapter resources
            from ..storage import chapter_resource_dir
            res_dir = chapter_resource_dir(ch.id)
            if _os.path.isdir(res_dir):
                shutil.rmtree(res_dir, ignore_errors=True)
        db_session.query(Chapter).filter_by(course_id=course_id).delete()
        # Delete classes and their related records
        for cls in db_session.query(Class).filter_by(course_id=course_id).all():
            db_session.query(InviteCode).filter_by(class_id=cls.id).update(
                {InviteCode.class_id: None}, synchronize_session=False
            )
            db_session.query(UserClassRole).filter_by(class_id=cls.id).delete()
            for a in db_session.query(Assignment).filter_by(class_id=cls.id).all():
                for aq in db_session.query(AssignmentQuestion).filter_by(assignment_id=a.id).all():
                    db_session.query(AssignmentQuestionOption).filter_by(assignment_question_id=aq.id).delete()
                db_session.query(AssignmentQuestion).filter_by(assignment_id=a.id).delete()
                for sub in db_session.query(Submission).filter_by(assignment_id=a.id).all():
                    for ans in db_session.query(Answer).filter_by(submission_id=sub.id).all():
                        for uf in db_session.query(UploadedFile).filter_by(answer_id=ans.id).all():
                            full_path = _os.path.join(upload_dir, uf.file_path)
                            if _os.path.isfile(full_path):
                                _os.remove(full_path)
                        db_session.query(UploadedFile).filter_by(answer_id=ans.id).delete()
                    db_session.query(Answer).filter_by(submission_id=sub.id).delete()
                    db_session.query(Grade).filter_by(submission_id=sub.id).delete()
                db_session.query(Submission).filter_by(assignment_id=a.id).delete()
            db_session.query(Assignment).filter_by(class_id=cls.id).delete()
        db_session.query(Class).filter_by(course_id=course_id).delete()
        db_session.delete(course)
        db_session.commit()
        log("admin.delete_course", f"course_id={course_id}")
        flash("课程已删除", "success")
        return redirect(url_for("admin.courses"))
    name = (request.form.get("name") or "").strip()
    if name:
        course.name = name
    course.description = (request.form.get("description") or "").strip() or None
    db_session.commit()
    flash("课程已更新", "success")
    return redirect(url_for("admin.courses"))


# --------------------------------------------------------------------------
# Chapters
# --------------------------------------------------------------------------
@bp.route("/courses/<int:course_id>/chapters")
@role_required("super_admin")
def chapters(course_id):
    course = db_session.get(Course, course_id)
    if course is None:
        flash("课程不存在", "error")
        return redirect(url_for("admin.courses"))
    chapters = (
        db_session.query(Chapter)
        .filter_by(course_id=course_id)
        .order_by(Chapter.chapter_number)
        .all()
    )
    question_counts = {
        ch.id: db_session.query(Question).filter_by(chapter_id=ch.id).count()
        for ch in chapters
    }
    return render_template(
        "admin/chapters.html",
        course=course,
        chapters=chapters,
        question_counts=question_counts,
    )


@bp.route("/courses/<int:course_id>/chapters", methods=["POST"])
@role_required("super_admin")
def create_chapter(course_id):
    course = db_session.get(Course, course_id)
    if course is None:
        flash("课程不存在", "error")
        return redirect(url_for("admin.courses"))

    number = request.form.get("chapter_number", type=int)
    title = (request.form.get("title") or "").strip()
    if number is None:
        flash("章节号必须为数字", "error")
        return redirect(url_for("admin.chapters", course_id=course_id))

    exists = (
        db_session.query(Chapter)
        .filter_by(course_id=course_id, chapter_number=number)
        .first()
    )
    if exists:
        flash("该章节号已存在", "error")
        return redirect(url_for("admin.chapters", course_id=course_id))

    db_session.add(
        Chapter(course_id=course_id, chapter_number=number, title=title or None)
    )
    db_session.commit()
    flash("章节已创建", "success")
    return redirect(url_for("admin.chapters", course_id=course_id))


@bp.route("/chapters/<int:chapter_id>", methods=["POST"])
@role_required("super_admin")
def update_chapter(chapter_id):
    chapter = db_session.get(Chapter, chapter_id)
    if chapter is None:
        flash("章节不存在", "error")
        return redirect(url_for("admin.courses"))
    course_id = chapter.course_id
    action = request.form.get("action", "update")

    if action == "delete":
        # Cascade delete questions and their options
        from ..models import QuestionOption
        import shutil
        for q in db_session.query(Question).filter_by(chapter_id=chapter_id).all():
            db_session.query(QuestionOption).filter_by(question_id=q.id).delete()
        db_session.query(Question).filter_by(chapter_id=chapter_id).delete()
        # Delete chapter resource files
        res_dir = chapter_resource_dir(chapter_id)
        if os.path.isdir(res_dir):
            shutil.rmtree(res_dir, ignore_errors=True)
        db_session.delete(chapter)
        db_session.commit()
        flash("章节已删除", "success")
        return redirect(url_for("admin.chapters", course_id=course_id))

    number = request.form.get("chapter_number", type=int)
    if number is not None:
        dup = (
            db_session.query(Chapter)
            .filter(
                Chapter.course_id == course_id,
                Chapter.chapter_number == number,
                Chapter.id != chapter_id,
            )
            .first()
        )
        if dup:
            flash("该章节号已存在", "error")
            return redirect(url_for("admin.chapters", course_id=course_id))
        chapter.chapter_number = number
    title = (request.form.get("title") or "").strip()
    if title:
        chapter.title = title
    db_session.commit()
    flash("章节已更新", "success")
    return redirect(url_for("admin.chapters", course_id=course_id))


@bp.route("/chapters/<int:chapter_id>/markdown", methods=["POST"])
@role_required("super_admin")
def upload_markdown(chapter_id):
    chapter = db_session.get(Chapter, chapter_id)
    if chapter is None:
        flash("章节不存在", "error")
        return redirect(url_for("admin.courses"))

    file = request.files.get("markdown")
    if file is None or not file.filename:
        flash("请选择一个文件", "error")
        return redirect(url_for("admin.chapters", course_id=chapter.course_id))

    name = secure_filename(file.filename)
    ext = os.path.splitext(name)[1].lower()

    if ext not in (".md", ".zip"):
        flash("仅支持 .md 或 .zip 文件", "error")
        return redirect(url_for("admin.chapters", course_id=chapter.course_id))

    dest_dir = chapter_resource_dir(chapter.id)
    os.makedirs(dest_dir, exist_ok=True)

    if ext == ".zip":
        # ZIP 压缩包：解压后提取 MD 和图片
        import shutil
        import tempfile
        import zipfile

        tmpdir = tempfile.mkdtemp()
        try:
            # SpooledTemporaryFile (Flask's file.stream) does not have
            # .seekable() in Python 3.10, which zipfile requires.  Save
            # to a real temp file first.
            tmp_zip_path = os.path.join(tmpdir, "_upload.zip")
            file.save(tmp_zip_path)
            with zipfile.ZipFile(tmp_zip_path) as zf:
                zf.extractall(tmpdir)

            # Find the .md file inside the ZIP (walk the tree)
            md_path = None
            for root, dirs, files in os.walk(tmpdir):
                for fname in files:
                    if fname.lower().endswith(".md"):
                        md_path = os.path.join(root, fname)
                        break
                if md_path:
                    break

            if md_path is None:
                flash("ZIP 文件中未找到 .md 文件", "error")
                return redirect(
                    url_for("admin.chapters", course_id=chapter.course_id)
                )

            # Read the MD content
            with open(md_path, "r", encoding="utf-8") as fh:
                md_text = fh.read()

            # Save the MD file to the chapter resource directory
            md_basename = os.path.basename(md_path)
            dest_md_path = os.path.join(dest_dir, secure_filename(md_basename))
            shutil.copyfile(md_path, dest_md_path)

            # Ingest images from the extracted ZIP tree
            ingested = ingest_referenced_images(
                md_text,
                tmpdir,  # source_root: the ZIP extraction root
                dest_dir,  # dest_root: chapter resource directory
            )

            dest_path = dest_md_path
            original_name = file.filename + " → " + md_basename
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    else:
        # Plain .md file
        if ext != ".md" and file.mimetype not in ("text/markdown", "text/plain"):
            flash("仅支持 .md 或 text/markdown 文件", "error")
            return redirect(url_for("admin.chapters", course_id=chapter.course_id))

        dest_path = os.path.join(dest_dir, name)
        file.save(dest_path)

        with open(dest_path, "r", encoding="utf-8") as fh:
            md_text = fh.read()
        ingested = ingest_referenced_images(
            md_text,
            current_app.config["SOURCE_QUESTION_BANK_DIR"],
            dest_dir,
        )
        original_name = file.filename

    try:
        count, title = import_chapter_questions(chapter.id, md_text)

        chapter.markdown_path = dest_path
        chapter.markdown_original_name = original_name
        chapter.markdown_uploaded_at = datetime.now()
        if title:
            chapter.title = title
        chapter.parse_status = "parsed"
        db_session.commit()
        log(
            "admin.upload_markdown",
            f"chapter_id={chapter_id} questions={count} ingested={ingested}",
        )

        flash(
            f"解析成功：共 {count} 道题"
            + (f"，自动引入 {ingested} 张图片" if ingested else ""),
            "success",
        )
    except Exception as exc:  # noqa: BLE001
        chapter.markdown_path = dest_path
        chapter.markdown_original_name = original_name
        chapter.markdown_uploaded_at = datetime.now()
        chapter.parse_status = "parse_failed"
        db_session.commit()
        flash(f"解析失败：{exc}", "error")

    return redirect(url_for("admin.chapters", course_id=chapter.course_id))


# --------------------------------------------------------------------------
# One-click import of course1-os
# --------------------------------------------------------------------------
@bp.route("/courses/<int:course_id>/import-course1-os", methods=["POST"])
@role_required("super_admin")
def import_course1_os(course_id):
    course = db_session.get(Course, course_id)
    if course is None:
        flash("课程不存在", "error")
        return redirect(url_for("admin.courses"))

    source_dir = current_app.config["SOURCE_QUESTION_BANK_DIR"]
    imported = 0
    for fname in sorted(os.listdir(source_dir)):
        if not fname.endswith(".md"):
            continue
        # Extract chapter number from filename like "按照本书-第3章-xxx.md"
        match = os.path.splitext(fname)[0]
        num = None
        for part in match.split("-"):
            if part.startswith("第") and part.endswith("章"):
                try:
                    num = int(part[1:-1])
                except ValueError:
                    pass
                break
        if num is None:
            continue

        # Create or get chapter
        chapter = (
            db_session.query(Chapter)
            .filter_by(course_id=course_id, chapter_number=num)
            .first()
        )
        if chapter is None:
            chapter = Chapter(
                course_id=course_id, chapter_number=num, title=match
            )
            db_session.add(chapter)
            db_session.flush()

        src_path = os.path.join(source_dir, fname)
        with open(src_path, "r", encoding="utf-8") as fh:
            md_text = fh.read()

        dest_dir = chapter_resource_dir(chapter.id)
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, secure_filename(fname))
        with open(dest_path, "w", encoding="utf-8") as fh:
            fh.write(md_text)

        ingest_referenced_images(md_text, source_dir, dest_dir)
        count, title = import_chapter_questions(chapter.id, md_text)

        chapter.markdown_path = dest_path
        chapter.markdown_original_name = fname
        chapter.markdown_uploaded_at = datetime.now()
        if title:
            chapter.title = title
        chapter.parse_status = "parsed"
        imported += 1

    db_session.commit()
    log(
        "admin.import_course1_os",
        f"course_id={course_id} chapters_imported={imported}",
    )
    flash(f"一键导入完成：{imported} 个章节", "success")
    return redirect(url_for("admin.chapters", course_id=course_id))


# --------------------------------------------------------------------------
# Classes
# --------------------------------------------------------------------------
@bp.route("/classes")
@role_required("super_admin")
def classes():
    classes = db_session.query(Class).order_by(Class.created_at.desc()).all()
    courses = db_session.query(Course).order_by(Course.name).all()
    return render_template("admin/classes.html", classes=classes, courses=courses)


@bp.route("/classes/<int:class_id>", methods=["POST"])
@role_required("super_admin")
def update_class(class_id):
    klass = db_session.get(Class, class_id)
    if klass is None:
        flash("班级不存在", "error")
        return redirect(url_for("admin.classes"))
    action = request.form.get("action", "update")
    if action == "delete":
        # Cascade delete all related records
        from ..models import (
            AssignmentQuestion, AssignmentQuestionOption,
            Answer, UploadedFile, Grade, Submission,
        )
        import os as _os
        upload_dir = current_app.config["UPLOAD_DIR"]
        db_session.query(InviteCode).filter_by(class_id=class_id).update(
            {InviteCode.class_id: None}, synchronize_session=False
        )
        db_session.query(UserClassRole).filter_by(class_id=class_id).delete()
        for a in db_session.query(Assignment).filter_by(class_id=class_id).all():
            for aq in db_session.query(AssignmentQuestion).filter_by(assignment_id=a.id).all():
                db_session.query(AssignmentQuestionOption).filter_by(assignment_question_id=aq.id).delete()
            db_session.query(AssignmentQuestion).filter_by(assignment_id=a.id).delete()
            for sub in db_session.query(Submission).filter_by(assignment_id=a.id).all():
                for ans in db_session.query(Answer).filter_by(submission_id=sub.id).all():
                    # Delete uploaded files from disk
                    for uf in db_session.query(UploadedFile).filter_by(answer_id=ans.id).all():
                        full_path = _os.path.join(upload_dir, uf.file_path)
                        if _os.path.isfile(full_path):
                            _os.remove(full_path)
                    db_session.query(UploadedFile).filter_by(answer_id=ans.id).delete()
                db_session.query(Answer).filter_by(submission_id=sub.id).delete()
                db_session.query(Grade).filter_by(submission_id=sub.id).delete()
            db_session.query(Submission).filter_by(assignment_id=a.id).delete()
        db_session.query(Assignment).filter_by(class_id=class_id).delete()
        db_session.delete(klass)
        db_session.commit()
        log("admin.delete_class", f"class_id={class_id}")
        flash("班级已删除", "success")
        return redirect(url_for("admin.classes"))

    name = (request.form.get("name") or "").strip()
    if name:
        db_session.query(InviteCode).filter_by(class_id=class_id).update(
            {InviteCode.class_name: name}, synchronize_session=False
        )
        klass.name = name
    course_id = request.form.get("course_id", type=int)
    if course_id is not None:
        klass.course_id = course_id
    capacity = request.form.get("capacity", type=int)
    if capacity is not None and capacity > 0:
        klass.capacity = capacity
    klass.enabled = request.form.get("enabled") == "on"
    db_session.commit()
    flash("班级已更新", "success")
    return redirect(url_for("admin.classes"))


# --------------------------------------------------------------------------
# Invite codes
# --------------------------------------------------------------------------
@bp.route("/invite-codes")
@role_required("super_admin")
def invite_codes():
    codes = db_session.query(InviteCode).order_by(InviteCode.created_at.desc()).all()
    classes = db_session.query(Class).order_by(Class.name).all()
    return render_template("admin/invite_codes.html", codes=codes, classes=classes)


@bp.route("/invite-codes", methods=["POST"])
@role_required("super_admin")
def create_invite_code():
    class_id = request.form.get("class_id", type=int)
    if class_id is None:
        flash("请选择班级", "error")
        return redirect(url_for("admin.invite_codes"))
    capacity = request.form.get("capacity", type=int)
    expires_at_str = (request.form.get("expires_at") or "").strip()

    expires_at = None
    if expires_at_str:
        try:
            expires_at = datetime.strptime(expires_at_str, "%Y-%m-%dT%H:%M")
        except ValueError:
            flash("过期时间格式无效", "error")
            return redirect(url_for("admin.invite_codes"))

    code = _generate_code()
    while db_session.query(InviteCode).filter_by(code=code).first():
        code = _generate_code()

    klass = db_session.get(Class, class_id)
    if klass is None:
        flash("班级不存在", "error")
        return redirect(url_for("admin.invite_codes"))

    db_session.add(
        InviteCode(
            code=code,
            class_id=class_id,
            course_name=klass.course.name,
            class_name=klass.name,
            capacity=capacity if capacity is not None and capacity > 0 else None,
            expires_at=expires_at,
        )
    )
    db_session.commit()
    log("admin.create_invite_code", f"code={code} class_id={class_id}")
    flash(f"邀请码 {code} 已生成", "success")
    return redirect(url_for("admin.invite_codes"))


@bp.route("/invite-codes/<int:code_id>", methods=["POST"])
@role_required("super_admin")
def update_invite_code(code_id):
    code = db_session.get(InviteCode, code_id)
    if code is None:
        flash("邀请码不存在", "error")
        return redirect(url_for("admin.invite_codes"))
    action = request.form.get("action", "toggle")
    if action == "delete":
        flash("请在统一系统的邀请码管理页面删除邀请码，以确保关联账号先归档。", "error")
    else:
        code.enabled = not code.enabled
        db_session.commit()
        flash("邀请码状态已更新", "success")
    return redirect(url_for("admin.invite_codes"))


# --------------------------------------------------------------------------
# Assignments & grades
# --------------------------------------------------------------------------
@bp.route("/assignments")
@role_required("super_admin")
def assignments():
    assignments = (
        db_session.query(Assignment).order_by(Assignment.created_at.desc()).all()
    )
    return render_template("admin/assignments.html", assignments=assignments)


@bp.route("/assignments/<int:assignment_id>", methods=["POST"])
@role_required("super_admin")
def update_assignment(assignment_id):
    assignment = db_session.get(Assignment, assignment_id)
    if assignment is None:
        flash("作业不存在", "error")
        return redirect(url_for("admin.assignments"))
    action = request.form.get("action", "update")
    if action == "close":
        assignment.status = "closed"
        db_session.commit()
        log("admin.close_assignment", f"assignment_id={assignment_id}")
        flash("作业已关闭", "success")
    elif action == "delete":
        from ..models import (
            AssignmentQuestion, AssignmentQuestionOption,
            Answer, UploadedFile, Grade, Submission,
        )
        for aq in db_session.query(AssignmentQuestion).filter_by(assignment_id=assignment_id).all():
            db_session.query(AssignmentQuestionOption).filter_by(assignment_question_id=aq.id).delete()
        db_session.query(AssignmentQuestion).filter_by(assignment_id=assignment_id).delete()
        for sub in db_session.query(Submission).filter_by(assignment_id=assignment_id).all():
            for ans in db_session.query(Answer).filter_by(submission_id=sub.id).all():
                db_session.query(UploadedFile).filter_by(answer_id=ans.id).delete()
            db_session.query(Answer).filter_by(submission_id=sub.id).delete()
            db_session.query(Grade).filter_by(submission_id=sub.id).delete()
        db_session.query(Submission).filter_by(assignment_id=assignment_id).delete()
        db_session.delete(assignment)
        db_session.commit()
        log("admin.delete_assignment", f"assignment_id={assignment_id}")
        flash("作业已删除", "success")
    return redirect(url_for("admin.assignments"))


# --------------------------------------------------------------------------
# CSV export
# --------------------------------------------------------------------------
@bp.route("/export-grades")
@role_required("super_admin")
def export_grades():
    rows = (
        db_session.query(
            Class.name,
            Course.name,
            Assignment.title,
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
        .join(Course, Assignment.course_id == Course.id)
        .join(User, Submission.student_id == User.id)
        .outerjoin(
            Grade,
            (Grade.submission_id == Submission.id)
            & (Grade.status == "submitted"),
        )
        .order_by(Assignment.title, User.name)
        .all()
    )

    buf = io.StringIO()
    # UTF-8 BOM for MS Excel compatibility
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow(
        [
            "班级", "课程", "作业", "学生姓名", "邮箱",
            "提交状态", "提交时间", "是否迟交", "分数", "评价",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r[0], r[1], r[2], r[3], r[4],
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
            "Content-Disposition": f"attachment; filename=grades-{today}.csv",
        },
    )


# --------------------------------------------------------------------------
# Audit log
# --------------------------------------------------------------------------
@bp.route("/audit")
@role_required("super_admin")
def audit():
    logs = db_session.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(200).all()
    return render_template("admin/audit.html", logs=logs)
