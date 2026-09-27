from datetime import datetime, timezone

from .database import connect, transaction


def _now():
    return datetime.now(timezone.utc).isoformat()


def _can_access(row, user):
    if user["role"] == "teacher":
        return (
            user.get("class_id") is not None
            and row["owner_external_id"] == user["external_id"]
            and row["class_id"] == user["class_id"]
        )
    return user.get("class_id") is not None and row["class_id"] == user["class_id"]


def list_presentations(user):
    connection = connect()
    try:
        if user["role"] == "teacher" and user.get("class_id") is not None:
            rows = connection.execute(
                "SELECT * FROM presentations WHERE owner_external_id = ? AND class_id = ? ORDER BY updated_at DESC",
                (user["external_id"], user["class_id"]),
            ).fetchall()
        elif user.get("class_id") is not None:
            rows = connection.execute(
                "SELECT * FROM presentations WHERE class_id = ? AND status = 'ready' ORDER BY updated_at DESC",
                (user["class_id"],),
            ).fetchall()
        else:
            rows = []
        return [dict(row) for row in rows]
    finally:
        connection.close()


def find_duplicate(owner_external_id, class_id, content_sha256):
    connection = connect()
    try:
        row = connection.execute(
            """
            SELECT * FROM presentations
            WHERE owner_external_id = ? AND class_id = ? AND content_sha256 = ?
              AND status = 'ready'
            ORDER BY updated_at DESC LIMIT 1
            """,
            (owner_external_id, class_id, content_sha256),
        ).fetchone()
        return dict(row) if row else None
    finally:
        connection.close()


def create_presentation(record):
    now = _now()
    with transaction() as connection:
        connection.execute(
            """
            INSERT INTO presentations (
                id, title, original_filename, owner_external_id, class_id,
                class_name, course_name, content_sha256, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
            """,
            (
                record["id"], record["title"], record["original_filename"],
                record["owner_external_id"], record["class_id"],
                record["class_name"], record["course_name"],
                record["content_sha256"], now, now,
            ),
        )


def mark_ready(presentation_id, slides):
    now = _now()
    with transaction() as connection:
        connection.execute("DELETE FROM slides WHERE presentation_id = ?", (presentation_id,))
        connection.executemany(
            """
            INSERT INTO slides (presentation_id, slide_index, image_filename, extracted_text)
            VALUES (?, ?, ?, ?)
            """,
            [
                (presentation_id, slide["index"], slide["image_filename"], slide.get("text", ""))
                for slide in slides
            ],
        )
        connection.execute(
            """
            UPDATE presentations
            SET status = 'ready', slide_count = ?, error_message = NULL, updated_at = ?
            WHERE id = ?
            """,
            (len(slides), now, presentation_id),
        )


def mark_failed(presentation_id, message):
    with transaction() as connection:
        connection.execute(
            "UPDATE presentations SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
            (str(message)[:1000], _now(), presentation_id),
        )


def get_presentation(presentation_id, user, require_ready=False):
    connection = connect()
    try:
        row = connection.execute(
            "SELECT * FROM presentations WHERE id = ?", (presentation_id,)
        ).fetchone()
        if row is None or not _can_access(row, user):
            return None
        result = dict(row)
        if require_ready and result["status"] != "ready":
            return None
        result["slides"] = [
            dict(slide)
            for slide in connection.execute(
                "SELECT * FROM slides WHERE presentation_id = ? ORDER BY slide_index",
                (presentation_id,),
            ).fetchall()
        ]
        return result
    finally:
        connection.close()


def delete_presentation(presentation_id, owner_external_id):
    with transaction() as connection:
        cursor = connection.execute(
            "DELETE FROM presentations WHERE id = ? AND owner_external_id = ?",
            (presentation_id, owner_external_id),
        )
        return cursor.rowcount == 1
