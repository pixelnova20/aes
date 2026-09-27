import sqlite3

from flask import current_app


def _connect_course_data():
    connection = sqlite3.connect(current_app.config["COURSE_DATABASE"], timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute(
        "ATTACH DATABASE ? AS accounts",
        (current_app.config["ACCOUNT_DATABASE"],),
    )
    return connection


def current_class_for_account(external_id):
    with _connect_course_data() as connection:
        row = connection.execute(
            """
            SELECT u.class_id, c.name AS class_name, co.name AS course_name
            FROM accounts.users AS u
            LEFT JOIN classes AS c ON c.id = u.class_id
            LEFT JOIN courses AS co ON co.id = c.course_id
            WHERE u.external_id = ? AND u.enabled = 1
            LIMIT 1
            """,
            (external_id,),
        ).fetchone()
    if row is None or row["class_id"] is None:
        return None
    return dict(row)


def teacher_classes(external_id):
    with _connect_course_data() as connection:
        rows = connection.execute(
            """
            SELECT c.id AS class_id, c.name AS class_name, co.name AS course_name
            FROM classes AS c
            JOIN courses AS co ON co.id = c.course_id
            WHERE co.owner_external_id = ? AND c.enabled = 1
            ORDER BY co.name, c.name
            """,
            (external_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def teacher_owns_class(external_id, class_id):
    return next(
        (item for item in teacher_classes(external_id) if item["class_id"] == class_id),
        None,
    )
