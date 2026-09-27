"""Protected file-serving routes: chapter images and uploaded answer files."""
import os

from flask import (
    Blueprint,
    abort,
    current_app,
    send_file,
)

from ..auth_utils import current_user
from ..database import db_session
from ..decorators import login_required
from ..helpers import user_has_class_access, user_has_course_access
from ..models import Answer, Chapter, Submission, UploadedFile

bp = Blueprint("files", __name__)


@bp.route("/chapter-images/<int:chapter_id>/<path:relpath>")
@login_required
def chapter_image(chapter_id, relpath):
    """Serve chapter images.

    Only users who have access to the chapter's course (via any class
    enrollment) may view the images.  Super-admins are always allowed.
    """
    chapter = db_session.get(Chapter, chapter_id)
    if chapter is None:
        abort(404)

    user = current_user()
    if user.role != "super_admin":
        if not user_has_course_access(user, chapter.course_id):
            abort(403)

    base = os.path.join(
        current_app.config["CHAPTER_UPLOAD_DIR"], str(chapter_id)
    )
    safe = _safe_path(base, relpath)
    if safe is None:
        abort(404)
    return send_file(safe, conditional=True)


@bp.route("/files/<int:file_id>")
@login_required
def serve(file_id):
    """Serve a student-uploaded answer file.

    Only the file's owner, the teacher/TA of the relevant class, or the
    super-admin may download the file.
    """
    uf = db_session.get(UploadedFile, file_id)
    if uf is None:
        abort(404)

    user = current_user()
    if user.role == "super_admin":
        pass  # always allowed
    else:
        answer = db_session.get(Answer, uf.answer_id)
        if answer is None:
            abort(404)
        submission = db_session.get(Submission, answer.submission_id)
        if submission is None:
            abort(404)
        assignment = submission.assignment
        if assignment is None:
            abort(404)
        # owner
        if submission.student_id == user.id:
            pass
        elif user.role in ("teacher", "ta"):
            if not user_has_class_access(user, assignment.class_id, user.role):
                abort(403)
        else:
            abort(403)

    base = current_app.config["UPLOAD_DIR"]
    safe = _safe_path(base, uf.file_path)
    if safe is None:
        abort(404)
    return send_file(safe, conditional=True)


def _safe_path(base, relpath):
    """Resolve ``relpath`` under ``base``, preventing directory traversal."""
    resolved = os.path.normpath(os.path.join(base, relpath))
    if (
        resolved != os.path.normpath(base)
        and not resolved.startswith(os.path.normpath(base) + os.sep)
    ):
        return None
    if not os.path.isfile(resolved):
        return None
    return resolved