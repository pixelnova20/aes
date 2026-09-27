"""Shared chapter question-bank upload and import handling."""
import os
import shutil
import tempfile
import zipfile
from datetime import datetime

from flask import current_app
from werkzeug.utils import secure_filename

from .database import db_session
from .question_parser import import_chapter_questions, ingest_referenced_images
from .storage import chapter_resource_dir


def _safe_extract(archive, destination):
    destination = os.path.realpath(destination)
    for member in archive.infolist():
        target = os.path.realpath(os.path.join(destination, member.filename))
        if os.path.commonpath([destination, target]) != destination:
            raise ValueError("ZIP 文件包含不安全的路径")
    archive.extractall(destination)


def import_question_bank(chapter, upload):
    """Persist one Markdown/ZIP upload, replace live questions, and return a message."""
    if upload is None or not upload.filename:
        raise ValueError("请选择一个题库文件")

    filename = secure_filename(upload.filename)
    extension = os.path.splitext(filename)[1].lower()
    if extension not in (".md", ".zip"):
        raise ValueError("仅支持 .md 或 .zip 文件")

    destination_dir = chapter_resource_dir(chapter.id)
    os.makedirs(destination_dir, exist_ok=True)
    ingested = 0

    if extension == ".zip":
        temporary_dir = tempfile.mkdtemp()
        try:
            archive_path = os.path.join(temporary_dir, "_upload.zip")
            upload.save(archive_path)
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    _safe_extract(archive, temporary_dir)
            except zipfile.BadZipFile as exc:
                raise ValueError("ZIP 文件无法读取") from exc

            markdown_path = None
            for root, _directories, files in os.walk(temporary_dir):
                for item in files:
                    if item.lower().endswith(".md"):
                        markdown_path = os.path.join(root, item)
                        break
                if markdown_path:
                    break
            if markdown_path is None:
                raise ValueError("ZIP 文件中未找到 .md 文件")

            with open(markdown_path, "r", encoding="utf-8") as file_handle:
                markdown = file_handle.read()
            markdown_name = secure_filename(os.path.basename(markdown_path))
            destination_path = os.path.join(destination_dir, markdown_name)
            shutil.copyfile(markdown_path, destination_path)
            markdown_dir = os.path.dirname(markdown_path)
            ingested = ingest_referenced_images(
                markdown, markdown_dir, destination_dir
            )
            if os.path.realpath(markdown_dir) != os.path.realpath(temporary_dir):
                ingested += ingest_referenced_images(
                    markdown, temporary_dir, destination_dir
                )
            original_name = f"{upload.filename} -> {os.path.basename(markdown_path)}"
        finally:
            shutil.rmtree(temporary_dir, ignore_errors=True)
    else:
        destination_path = os.path.join(destination_dir, filename)
        upload.save(destination_path)
        with open(destination_path, "r", encoding="utf-8") as file_handle:
            markdown = file_handle.read()
        ingested = ingest_referenced_images(
            markdown,
            current_app.config["SOURCE_QUESTION_BANK_DIR"],
            destination_dir,
        )
        original_name = upload.filename

    chapter.markdown_path = destination_path
    chapter.markdown_original_name = original_name
    chapter.markdown_uploaded_at = datetime.now()
    try:
        count, title = import_chapter_questions(chapter.id, markdown)
        if title:
            chapter.title = title
        chapter.parse_status = "parsed"
        db_session.commit()
    except Exception as exc:
        db_session.rollback()
        chapter.markdown_path = destination_path
        chapter.markdown_original_name = original_name
        chapter.markdown_uploaded_at = datetime.now()
        chapter.parse_status = "parse_failed"
        db_session.commit()
        raise ValueError(f"题库解析失败：{exc}") from exc

    image_message = f"，自动引入 {ingested} 张图片" if ingested else ""
    return f"解析成功：共 {count} 道题{image_message}"
