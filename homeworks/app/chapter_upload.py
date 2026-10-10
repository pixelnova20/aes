"""Shared chapter question-bank upload and import handling."""
import os
import re
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from datetime import datetime

from flask import current_app

from .database import db_session
from .question_parser import (
    extract_image_relpaths,
    import_chapter_questions,
    ingest_referenced_images,
)
from .storage import chapter_resource_dir

_ALLOWED_EXTENSIONS = {".md", ".zip"}
_GENERIC_TITLES = {"作业", "作业题", "习题", "练习题", "题库"}
_MAX_ARCHIVE_ENTRIES = 256
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
_MAX_ARCHIVE_MEMBER_BYTES = 32 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200


def _upload_extension(filename):
    basename = os.path.basename((filename or "").replace("\\", "/"))
    return os.path.splitext(basename)[1].lower()


def _decode_zip_member_name(member):
    name = member.filename
    if not member.flag_bits & 0x800:
        try:
            raw_name = name.encode("cp437")
        except UnicodeEncodeError:
            pass
        else:
            for encoding in ("utf-8", "gb18030"):
                try:
                    name = raw_name.decode(encoding)
                    break
                except UnicodeDecodeError:
                    continue
    return unicodedata.normalize("NFC", name).replace("\\", "/")


def _safe_member_target(destination, member_name):
    if not member_name or "\x00" in member_name:
        raise ValueError("ZIP 文件包含无效文件名")
    if member_name.startswith("/") or re.match(r"^[A-Za-z]:", member_name):
        raise ValueError("ZIP 文件包含不安全的路径")
    destination = os.path.realpath(destination)
    target = os.path.realpath(os.path.join(destination, member_name))
    if os.path.commonpath([destination, target]) != destination:
        raise ValueError("ZIP 文件包含不安全的路径")
    return target


def _safe_extract(archive, destination):
    members = archive.infolist()
    if len(members) > _MAX_ARCHIVE_ENTRIES:
        raise ValueError("ZIP 文件包含的文件数量过多")
    total_size = sum(member.file_size for member in members)
    if total_size > _MAX_ARCHIVE_UNCOMPRESSED_BYTES:
        raise ValueError("ZIP 文件解压后的总大小超过限制")

    seen_targets = set()
    for member in members:
        if member.flag_bits & 0x1:
            raise ValueError("不支持加密的 ZIP 文件")
        if member.file_size > _MAX_ARCHIVE_MEMBER_BYTES:
            raise ValueError("ZIP 文件中存在过大的单个文件")
        if (
            member.file_size > 1024 * 1024
            and member.file_size > max(member.compress_size, 1) * _MAX_COMPRESSION_RATIO
        ):
            raise ValueError("ZIP 文件的压缩比异常")
        mode = member.external_attr >> 16
        if mode and stat.S_ISLNK(mode):
            raise ValueError("ZIP 文件不能包含符号链接")

        member_name = _decode_zip_member_name(member)
        target = _safe_member_target(destination, member_name)
        target_key = os.path.normcase(target)
        if target_key in seen_targets:
            raise ValueError("ZIP 文件包含重复路径")
        seen_targets.add(target_key)

        if member.is_dir() or member_name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(member) as source, open(target, "wb") as output:
            shutil.copyfileobj(source, output)


def _read_markdown(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as file_handle:
            return file_handle.read()
    except UnicodeDecodeError as exc:
        raise ValueError("Markdown 文件必须使用 UTF-8 编码") from exc


def _replace_resource_directory(staged_dir, destination_dir):
    backup_dir = None
    if os.path.exists(destination_dir):
        backup_dir = tempfile.mkdtemp(
            prefix=f".{os.path.basename(destination_dir)}-backup-",
            dir=os.path.dirname(destination_dir),
        )
        os.rmdir(backup_dir)
        os.replace(destination_dir, backup_dir)
    try:
        os.replace(staged_dir, destination_dir)
    except Exception:
        if backup_dir and os.path.exists(backup_dir):
            os.replace(backup_dir, destination_dir)
        raise
    return backup_dir


def _restore_resource_directory(destination_dir, backup_dir):
    if os.path.isdir(destination_dir):
        shutil.rmtree(destination_dir, ignore_errors=True)
    if backup_dir and os.path.exists(backup_dir):
        os.replace(backup_dir, destination_dir)


def _missing_referenced_images(markdown, resource_dir):
    resource_dir = os.path.realpath(resource_dir)
    missing = []
    for rel in extract_image_relpaths(markdown):
        normalized_rel = unicodedata.normalize("NFC", rel).replace("\\", "/")
        target = os.path.realpath(os.path.join(resource_dir, normalized_rel))
        if (
            os.path.commonpath([resource_dir, target]) != resource_dir
            or not os.path.isfile(target)
        ):
            missing.append(rel)
    return missing


def import_question_bank(chapter, upload):
    """Persist one Markdown/ZIP upload, replace live questions, and return a message."""
    if upload is None or not upload.filename:
        raise ValueError("请选择一个题库文件")

    extension = _upload_extension(upload.filename)
    if extension not in _ALLOWED_EXTENSIONS:
        raise ValueError("仅支持 .md 或 .zip 文件")

    destination_dir = chapter_resource_dir(chapter.id)
    destination_parent = os.path.dirname(destination_dir)
    os.makedirs(destination_parent, exist_ok=True)
    staged_resource_dir = tempfile.mkdtemp(
        prefix=f".{chapter.id}-upload-", dir=destination_parent
    )
    ingested = 0
    original_name = upload.filename
    temporary_dir = None

    try:
        if extension == ".zip":
            temporary_dir = tempfile.mkdtemp()
            archive_path = os.path.join(temporary_dir, "_upload.zip")
            upload.save(archive_path)
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    _safe_extract(archive, temporary_dir)
            except zipfile.BadZipFile as exc:
                raise ValueError("ZIP 文件无法读取") from exc

            markdown_paths = []
            for root, _directories, files in os.walk(temporary_dir):
                for item in files:
                    if item.lower().endswith(".md"):
                        markdown_paths.append(os.path.join(root, item))
            if not markdown_paths:
                raise ValueError("ZIP 文件中未找到 .md 文件")
            if len(markdown_paths) > 1:
                raise ValueError("ZIP 文件中只能包含一个 .md 文件")
            markdown_path = markdown_paths[0]

            markdown = _read_markdown(markdown_path)
            staged_markdown_path = os.path.join(
                staged_resource_dir, "question-bank.md"
            )
            shutil.copyfile(markdown_path, staged_markdown_path)
            markdown_dir = os.path.dirname(markdown_path)
            ingested = ingest_referenced_images(
                markdown, markdown_dir, staged_resource_dir
            )
            if os.path.realpath(markdown_dir) != os.path.realpath(temporary_dir):
                ingested += ingest_referenced_images(
                    markdown, temporary_dir, staged_resource_dir
                )
            original_name = f"{upload.filename} -> {os.path.basename(markdown_path)}"
        else:
            staged_markdown_path = os.path.join(
                staged_resource_dir, "question-bank.md"
            )
            upload.save(staged_markdown_path)
            markdown = _read_markdown(staged_markdown_path)
            ingested = ingest_referenced_images(
                markdown,
                current_app.config["SOURCE_QUESTION_BANK_DIR"],
                staged_resource_dir,
            )

        missing_images = _missing_referenced_images(markdown, staged_resource_dir)
        if missing_images:
            preview = "、".join(missing_images[:3])
            suffix = " 等" if len(missing_images) > 3 else ""
            raise ValueError(f"Markdown 引用的图片不存在：{preview}{suffix}")

        count, title = import_chapter_questions(chapter.id, markdown)
        if title and title.strip() not in _GENERIC_TITLES:
            chapter.title = title
        chapter.markdown_path = os.path.join(destination_dir, "question-bank.md")
        chapter.markdown_original_name = original_name
        chapter.markdown_uploaded_at = datetime.now()
        chapter.parse_status = "parsed"
        backup_dir = _replace_resource_directory(
            staged_resource_dir, destination_dir
        )
        try:
            db_session.commit()
        except Exception:
            db_session.rollback()
            _restore_resource_directory(destination_dir, backup_dir)
            raise
        if backup_dir:
            shutil.rmtree(backup_dir, ignore_errors=True)
    except Exception as exc:
        db_session.rollback()
        if os.path.isdir(staged_resource_dir):
            shutil.rmtree(staged_resource_dir, ignore_errors=True)
        if isinstance(exc, ValueError):
            raise
        raise ValueError(f"题库解析失败：{exc}") from exc
    finally:
        if temporary_dir:
            shutil.rmtree(temporary_dir, ignore_errors=True)

    image_message = f"，自动引入 {ingested} 张图片" if ingested else ""
    return f"解析成功：共 {count} 道题{image_message}"
