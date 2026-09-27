import os
import sqlite3
from contextlib import contextmanager

from flask import current_app


SCHEMA = """
CREATE TABLE IF NOT EXISTS presentations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    owner_external_id TEXT NOT NULL,
    class_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    course_name TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    slide_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'processing',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_presentations_owner
    ON presentations(owner_external_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_presentations_class
    ON presentations(class_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_presentations_hash
    ON presentations(owner_external_id, class_id, content_sha256, status);

CREATE TABLE IF NOT EXISTS slides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    presentation_id TEXT NOT NULL,
    slide_index INTEGER NOT NULL,
    image_filename TEXT NOT NULL,
    extracted_text TEXT,
    FOREIGN KEY(presentation_id) REFERENCES presentations(id) ON DELETE CASCADE,
    UNIQUE(presentation_id, slide_index)
);
"""


def connect(path=None):
    database_path = path or current_app.config["DATABASE"]
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def transaction(path=None):
    connection = connect(path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db(app):
    database_path = app.config["DATABASE"]
    os.makedirs(os.path.dirname(database_path), exist_ok=True)
    with sqlite3.connect(database_path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
