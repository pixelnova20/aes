#!/usr/bin/env python3
"""Split the legacy Homeworks database into account and course databases."""

import argparse
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


ACCOUNT_TABLES = ("audit_logs", "invite_codes", "user_class_roles", "users")
COURSE_TABLES = ("courses", "chapters", "questions", "question_options")


def columns(connection, table):
    return [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]


def copy_common_rows(source, target, table, overrides=None):
    overrides = overrides or {}
    source_columns = set(columns(source, table))
    target_columns = columns(target, table)
    selected = [name for name in target_columns if name in source_columns or name in overrides]
    expressions = [overrides.get(name, name) for name in selected]
    placeholders = ", ".join("?" for _ in selected)
    column_sql = ", ".join(selected)
    rows = source.execute(f"SELECT {', '.join(expressions)} FROM {table}").fetchall()
    if rows:
        target.executemany(
            f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders})",
            rows,
        )


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy", required=True, type=Path)
    parser.add_argument("--accounts", required=True, type=Path)
    parser.add_argument("--courses", required=True, type=Path)
    parser.add_argument("--backup-dir", required=True, type=Path)
    return parser.parse_args()


def main():
    args = parse_args()
    legacy = args.legacy.resolve()
    accounts = args.accounts.resolve()
    courses = args.courses.resolve()
    backup_dir = args.backup_dir.resolve()

    if not legacy.is_file():
        raise SystemExit(f"Legacy database not found: {legacy}")
    for output in (accounts, courses):
        if output.exists():
            raise SystemExit(f"Refusing to overwrite existing database: {output}")

    accounts.parent.mkdir(parents=True, exist_ok=True)
    courses.parent.mkdir(parents=True, exist_ok=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = backup_dir / f"homework-combined-{timestamp}.db"
    shutil.copy2(legacy, backup)

    os.environ["HOMEWORKS_ACCOUNT_DATABASE_PATH"] = str(accounts)
    os.environ["HOMEWORKS_COURSE_DATABASE_PATH"] = str(courses)
    project_root = str(Path(__file__).resolve().parent.parent)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    from app import create_app
    from app import database

    app = create_app()
    with app.app_context():
        database.db_session.remove()
    database.engine.dispose()

    source = sqlite3.connect(legacy)
    account_db = sqlite3.connect(accounts)
    course_db = sqlite3.connect(courses)
    try:
        with account_db:
            for table in ACCOUNT_TABLES:
                account_db.execute(f"DELETE FROM {table}")
            copy_common_rows(source, account_db, "users", {"class_id": "NULL"})
            copy_common_rows(source, account_db, "audit_logs")

            invitations = source.execute(
                """SELECT i.id, i.code, NULL,
                          COALESCE(
                            (SELECT u.course_name FROM users u
                             JOIN classes user_class ON user_class.id = u.class_id
                             WHERE user_class.name = c.name AND u.course_name IS NOT NULL
                             ORDER BY u.id LIMIT 1),
                            course.name
                          ),
                          c.name, i.capacity, i.used_count,
                          i.enabled, i.expires_at, i.created_at
                   FROM invite_codes i
                   LEFT JOIN classes c ON c.id = i.class_id
                   LEFT JOIN courses course ON course.id = c.course_id"""
            ).fetchall()
            if invitations:
                account_db.executemany(
                    """INSERT INTO invite_codes
                       (id, code, class_id, course_name, class_name, capacity,
                        used_count, enabled, expires_at, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    invitations,
                )

        with course_db:
            for table in reversed(COURSE_TABLES):
                course_db.execute(f"DELETE FROM {table}")
            for table in COURSE_TABLES:
                copy_common_rows(source, course_db, table)

        account_counts = {
            table: account_db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("users", "invite_codes", "user_class_roles")
        }
        course_counts = {
            table: course_db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("courses", "chapters", "questions", "classes", "assignments")
        }
    except Exception:
        account_db.close()
        course_db.close()
        source.close()
        accounts.unlink(missing_ok=True)
        courses.unlink(missing_ok=True)
        raise
    else:
        account_db.close()
        course_db.close()
        source.close()

    print(f"backup={backup}")
    print(f"accounts={account_counts}")
    print(f"courses={course_counts}")


if __name__ == "__main__":
    main()
