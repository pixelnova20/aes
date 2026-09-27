"""Filesystem helpers for uploaded resources."""
import os

from flask import current_app


def chapter_resource_dir(chapter_id):
    return os.path.join(current_app.config["CHAPTER_UPLOAD_DIR"], str(chapter_id))


def answer_resource_dir(answer_id):
    return os.path.join(current_app.config["ANSWER_UPLOAD_DIR"], str(answer_id))
