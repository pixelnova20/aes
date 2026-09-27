import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

import jwt
from flask import (
    Blueprint,
    Response,
    abort,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    stream_with_context,
    url_for,
)
from .ai_chat import SlideAiError, open_slide_chat_stream
from .auth import (
    api_login_required,
    current_user,
    establish_sso_session,
    login_required,
    roles_required,
)
from .class_access import teacher_owns_class
from .converter import PresentationConverter, PresentationConversionError
from .presentation_store import (
    create_presentation,
    delete_presentation,
    find_duplicate,
    get_presentation,
    list_presentations,
    mark_failed,
    mark_ready,
)


bp = Blueprint("slideshow", __name__)
ALLOWED_EXTENSIONS = {".ppt", ".pptx"}


def _presentation_directory(presentation_id):
    return Path(current_app.config["UPLOAD_DIR"]) / "presentations" / presentation_id


def _presentation_summary(item):
    return {
        "id": item["id"],
        "title": item["title"],
        "originalFilename": item["original_filename"],
        "slideCount": item["slide_count"],
        "status": item["status"],
        "errorMessage": item["error_message"],
        "className": item["class_name"],
        "courseName": item["course_name"],
        "updatedAt": item["updated_at"],
        "viewerUrl": url_for("slideshow.viewer", presentation_id=item["id"]),
    }


def _presentation_detail(item):
    result = _presentation_summary(item)
    result["chatUrl"] = url_for(
        "slideshow.chat_stream", presentation_id=item["id"]
    )
    result["slides"] = [
        {
            "index": slide["slide_index"],
            "imageUrl": url_for(
                "slideshow.slide_image",
                presentation_id=item["id"],
                slide_index=slide["slide_index"],
            ),
        }
        for slide in item["slides"]
    ]
    return result


@bp.get("/sso")
def sso():
    token = (request.args.get("token") or "").strip()
    if not token:
        return redirect(current_app.config["SERVICE_PORTAL_URL"])
    try:
        establish_sso_session(token)
    except jwt.PyJWTError:
        session.clear()
        return redirect(current_app.config["SERVICE_PORTAL_URL"])
    return redirect(url_for("slideshow.index"))


@bp.get("/")
@login_required
def index():
    user = current_user()
    classes = (
        [teacher_owns_class(user["external_id"], user["class_id"])]
        if user["role"] == "teacher" and user.get("class_id") is not None
        else []
    )
    classes = [item for item in classes if item is not None]
    return render_template(
        "index.html",
        presentations=list_presentations(user),
        classes=classes,
    )


@bp.post("/presentations")
@roles_required("teacher")
def upload_presentation():
    user = current_user()
    title = (request.form.get("title") or "").strip()
    class_id = request.form.get("class_id", type=int)
    upload = request.files.get("presentation")
    class_context = (
        teacher_owns_class(user["external_id"], class_id)
        if class_id is not None and class_id == user.get("class_id")
        else None
    )

    if not title:
        flash("请输入演示文稿标题。", "error")
        return redirect(url_for("slideshow.index"))


    if class_context is None:
        flash("请选择你管理的班级。", "error")
        return redirect(url_for("slideshow.index"))
    if upload is None or not upload.filename:
        flash("请选择 PPT 或 PPTX 文件。", "error")
        return redirect(url_for("slideshow.index"))

    extension = Path(upload.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        flash("只支持 .ppt 和 .pptx 文件。", "error")
        return redirect(url_for("slideshow.index"))

    presentation_id = str(uuid.uuid4())
    staging_dir = Path(current_app.config["UPLOAD_DIR"]) / ".staging"
    staging_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging_path = staging_dir / f"{presentation_id}{extension}"
    upload.save(staging_path)
    digest = hashlib.sha256()
    with staging_path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    content_sha256 = digest.hexdigest()
    duplicate = find_duplicate(user["external_id"], class_id, content_sha256)
    if duplicate:
        staging_path.unlink(missing_ok=True)
        flash("相同文件已经转换完成，已打开现有演示文稿。", "info")
        return redirect(url_for("slideshow.viewer", presentation_id=duplicate["id"]))

    presentation_dir = _presentation_directory(presentation_id)
    presentation_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    source_path = presentation_dir / f"original{extension}"
    os.replace(staging_path, source_path)
    create_presentation({
        "id": presentation_id,
        "title": title,
        "original_filename": upload.filename,
        "owner_external_id": user["external_id"],
        "class_id": class_id,
        "class_name": class_context["class_name"],
        "course_name": class_context["course_name"],
        "content_sha256": content_sha256,
    })

    converter = PresentationConverter(
        current_app.config["LIBREOFFICE_BIN"],
        current_app.config["PDFTOPPM_BIN"],
        current_app.config["CONVERSION_TIMEOUT_SECONDS"],
    )
    try:
        slides = converter.convert(source_path, presentation_dir)
        mark_ready(presentation_id, slides)
        flash(f"上传成功，已转换 {len(slides)} 页。", "success")
        return redirect(url_for("slideshow.viewer", presentation_id=presentation_id))
    except PresentationConversionError as error:
        mark_failed(presentation_id, error)
        shutil.rmtree(presentation_dir / "slides", ignore_errors=True)
        current_app.logger.exception("Presentation conversion failed: %s", presentation_id)
        flash(str(error), "error")
        return redirect(url_for("slideshow.index"))


@bp.post("/presentations/<presentation_id>/delete")
@roles_required("teacher")
def remove_presentation(presentation_id):
    user = current_user()
    presentation = get_presentation(presentation_id, user)
    if presentation is None:
        abort(404)

    presentation_dir = _presentation_directory(presentation_id)
    staged_dir = None
    if presentation_dir.exists():
        deletion_root = Path(current_app.config["UPLOAD_DIR"]) / ".deleting"
        deletion_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        staged_dir = deletion_root / f"{presentation_id}-{uuid.uuid4().hex}"
        os.replace(presentation_dir, staged_dir)

    try:
        deleted = delete_presentation(presentation_id, user["external_id"])
    except Exception:
        if staged_dir is not None and staged_dir.exists():
            os.replace(staged_dir, presentation_dir)
        raise

    if not deleted:
        if staged_dir is not None and staged_dir.exists():
            os.replace(staged_dir, presentation_dir)
        abort(404)

    if staged_dir is not None:
        try:
            shutil.rmtree(staged_dir)
        except OSError:
            current_app.logger.exception(
                "Deleted presentation record but could not remove files: %s",
                presentation_id,
            )

    flash(f"课件《{presentation['title']}》已删除。", "success")
    return redirect(url_for("slideshow.index"))


@bp.get("/presentations/<presentation_id>")
@login_required
def viewer(presentation_id):
    presentation = get_presentation(presentation_id, current_user(), require_ready=True)
    if presentation is None:
        abort(404)
    return render_template(
        "viewer.html",
        presentation=presentation,
        presentation_json=_presentation_detail(presentation),
    )


@bp.get("/api/presentations")
@api_login_required
def api_presentations():
    return jsonify({
        "presentations": [_presentation_summary(item) for item in list_presentations(current_user())]
    })


@bp.get("/api/presentations/<presentation_id>")
@api_login_required
def api_presentation(presentation_id):
    presentation = get_presentation(presentation_id, current_user(), require_ready=True)
    if presentation is None:
        return jsonify({"message": "演示文稿不存在或无权查看。"}), 404
    return jsonify(_presentation_detail(presentation))


@bp.get("/api/presentations/<presentation_id>/slides/<int:slide_index>/image")
@api_login_required
def slide_image(presentation_id, slide_index):
    presentation = get_presentation(presentation_id, current_user(), require_ready=True)
    if presentation is None:
        abort(404)
    slide = next(
        (item for item in presentation["slides"] if item["slide_index"] == slide_index),
        None,
    )
    if slide is None:
        abort(404)
    slides_root = (_presentation_directory(presentation_id) / "slides").resolve()
    image_path = (slides_root / slide["image_filename"]).resolve()
    if image_path.parent != slides_root or not image_path.is_file():
        abort(404)
    return send_file(image_path, mimetype="image/jpeg", conditional=True, max_age=3600)


@bp.post("/api/presentations/<presentation_id>/chat/stream")
@api_login_required
def chat_stream(presentation_id):
    presentation = get_presentation(presentation_id, current_user(), require_ready=True)
    if presentation is None:
        return jsonify({"message": "演示文稿不存在或无权查看。"}), 404
    data = request.get_json(silent=True) or {}
    prompt = str(data.get("message") or "").strip()
    slide_index = data.get("slideIndex")
    history = data.get("history") or []
    if not prompt or len(prompt) > 4000 or not isinstance(slide_index, int):
        return jsonify({"message": "聊天请求无效。"}), 400
    if not isinstance(history, list) or len(history) > 12:
        return jsonify({"message": "对话记录无效。"}), 400
    clean_history = []
    for turn in history:
        if not isinstance(turn, dict) or turn.get("role") not in {"user", "assistant"}:
            return jsonify({"message": "对话记录无效。"}), 400
        content = str(turn.get("content") or "").strip()
        if not content or len(content) > 4000:
            return jsonify({"message": "对话记录无效。"}), 400
        clean_history.append({"role": turn["role"], "content": content})
    slide = next(
        (item for item in presentation["slides"] if item["slide_index"] == slide_index),
        None,
    )
    if slide is None:
        return jsonify({"message": "幻灯片页码无效。"}), 400

    try:
        upstream = open_slide_chat_stream(
            current_app.config,
            current_user(),
            presentation,
            slide,
            prompt,
            clean_history,
        )
    except SlideAiError as error:
        return jsonify({"message": str(error)}), error.status

    @stream_with_context
    def generate():
        try:
            for chunk in upstream:
                if isinstance(chunk, bytes):
                    yield chunk
                else:
                    yield chunk.encode("utf-8")
        finally:
            close = getattr(upstream, "close", None)
            if close:
                close()

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
