"""Data migration helpers — run on startup to evolve the schema gracefully."""
import os
import re
import fcntl
from datetime import datetime

from flask import current_app

from .database import db_session, engine
from .models import Chapter, Class, Course, SchemaMigration, User, UserClassRole

_STUDENT_NO_RE = re.compile(r"^[A-Za-z0-9]+$")


def migrate_user_class_roles():
    """For any existing user who has a class_id but no UserClassRole row,
    create one with role_in_class = user.role (if the user's role is
    teacher/ta/student)."""
    users = (
        db_session.query(User)
        .filter(User.class_id.isnot(None))
        .all()
    )
    created = 0
    for u in users:
        if u.role == "super_admin":
            continue
        existing = (
            db_session.query(UserClassRole)
            .filter_by(user_id=u.id, class_id=u.class_id)
            .first()
        )
        if existing is None:
            db_session.add(
                UserClassRole(
                    user_id=u.id,
                    class_id=u.class_id,
                    role_in_class=u.role,
                )
            )
            created += 1
    if created:
        db_session.commit()
    return created


def _column_exists(table_name, column_name, schema=None):
    """Check whether a column exists in the table."""
    from sqlalchemy import inspect
    insp = inspect(engine)
    if table_name not in insp.get_table_names(schema=schema):
        return False
    cols = {c["name"] for c in insp.get_columns(table_name, schema=schema)}
    return column_name in cols


def _table_exists(table_name, schema=None):
    from sqlalchemy import inspect
    insp = inspect(engine)
    return table_name in insp.get_table_names(schema=schema)


def _ensure_schema_migrations_table():
    if not _table_exists("schema_migrations", schema="accounts"):
        SchemaMigration.__table__.create(engine, checkfirst=True)


def _migration_applied(version):
    return (
        db_session.query(SchemaMigration)
        .filter_by(version=version)
        .first()
        is not None
    )


def _record_migration(version):
    db_session.add(SchemaMigration(version=version))
    db_session.commit()


def migrate_add_student_no():
    """Add student_no and upload_dir columns to users table."""
    if not _migration_applied("add_student_no"):
        if not _column_exists("users", "student_no", schema="accounts"):
            with engine.connect() as conn:
                from sqlalchemy import text
                conn.execute(text("ALTER TABLE accounts.users ADD COLUMN student_no VARCHAR(64)"))
                conn.commit()
        if not _column_exists("users", "upload_dir", schema="accounts"):
            with engine.connect() as conn:
                from sqlalchemy import text
                conn.execute(text("ALTER TABLE accounts.users ADD COLUMN upload_dir VARCHAR(512)"))
                conn.commit()
        _record_migration("add_student_no")


def migrate_create_upload_dirs():
    """Create upload directories for existing students who have student_no
    but no upload_dir set."""
    if not _migration_applied("create_upload_dirs"):
        students = (
            db_session.query(User)
            .filter(
                User.role == "student",
                User.student_no.isnot(None),
                User.upload_dir.is_(None),
            )
            .all()
        )
        for u in students:
            today = datetime.now().strftime("%Y-%m-%d")
            dirname = f"{today}-{u.student_no}"
            path = os.path.join(current_app.config["UPLOAD_DIR"], dirname)
            try:
                os.makedirs(path, exist_ok=True)
                u.upload_dir = dirname
            except OSError:
                continue
        db_session.commit()
        _record_migration("create_upload_dirs")


def migrate_invite_class_name():
    """Retain the requested course and class while an invitation is unassigned."""
    if not _migration_applied("invite_course_and_class_name"):
        if not _column_exists("invite_codes", "class_name", schema="accounts"):
            with engine.connect() as conn:
                from sqlalchemy import text
                conn.execute(text(
                    "ALTER TABLE accounts.invite_codes ADD COLUMN class_name VARCHAR(255)"
                ))
                conn.commit()
        if not _column_exists("invite_codes", "course_name", schema="accounts"):
            with engine.connect() as conn:
                from sqlalchemy import text
                conn.execute(text(
                    "ALTER TABLE accounts.invite_codes ADD COLUMN course_name VARCHAR(255)"
                ))
                conn.commit()
        _record_migration("invite_course_and_class_name")


def migrate_course_ownership():
    """Separate legacy course content from newly synchronized teacher classes."""
    version = "teacher_owned_courses"
    if _migration_applied(version):
        return

    from sqlalchemy import text

    if not _column_exists("courses", "owner_external_id"):
        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE courses ADD COLUMN owner_external_id VARCHAR(191)"
            ))
            conn.commit()
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_courses_owner_external_id "
            "ON courses (owner_external_id)"
        ))
        conn.commit()

    ownership_rows = db_session.execute(text("""
        SELECT classes.course_id,
               invite_codes.teacher_external_id,
               GROUP_CONCAT(DISTINCT classes.id) AS class_ids
          FROM accounts.invite_codes AS invite_codes
          JOIN classes ON classes.id = invite_codes.class_id
         WHERE invite_codes.level = 'level_2'
           AND invite_codes.teacher_external_id IS NOT NULL
         GROUP BY classes.course_id, invite_codes.teacher_external_id
    """)).mappings().all()

    for row in ownership_rows:
        course = db_session.get(Course, row["course_id"])
        if course is None or course.owner_external_id == row["teacher_external_id"]:
            continue
        class_ids = [int(value) for value in (row["class_ids"] or "").split(",") if value]
        if not class_ids:
            continue

        target = (
            db_session.query(Course)
            .filter_by(
                name=course.name,
                owner_external_id=row["teacher_external_id"],
            )
            .first()
        )
        chapter_count = db_session.query(Chapter).filter_by(course_id=course.id).count()

        # Before this migration teachers could not create chapters. Existing
        # chapters therefore belong to the legacy/admin course and must not be
        # exposed merely because a new class reused the same course name.
        if target is None and chapter_count:
            target = Course(
                name=course.name,
                description=course.description,
                owner_external_id=row["teacher_external_id"],
            )
            db_session.add(target)
            db_session.flush()
        elif target is None:
            course.owner_external_id = row["teacher_external_id"]
            target = course

        if target.id != course.id:
            db_session.query(Class).filter(Class.id.in_(class_ids)).update(
                {Class.course_id: target.id}, synchronize_session=False
            )

    db_session.commit()
    _record_migration(version)


def migrate_deduplicate_owned_courses():
    """Merge empty duplicate owned courses left by concurrent legacy migration."""
    version = "deduplicate_teacher_owned_courses"
    if _migration_applied(version):
        return

    from sqlalchemy import text

    duplicate_groups = db_session.execute(text("""
        SELECT owner_external_id, name
          FROM courses
         WHERE owner_external_id IS NOT NULL
         GROUP BY owner_external_id, name
        HAVING COUNT(*) > 1
    """)).mappings().all()
    for group in duplicate_groups:
        candidates = db_session.execute(text("""
            SELECT courses.id,
                   (SELECT COUNT(*) FROM classes WHERE classes.course_id = courses.id) AS class_count,
                   (SELECT COUNT(*) FROM chapters WHERE chapters.course_id = courses.id) AS chapter_count,
                   (SELECT COUNT(*) FROM assignments WHERE assignments.course_id = courses.id) AS assignment_count
              FROM courses
             WHERE owner_external_id = :owner_external_id AND name = :name
             ORDER BY class_count DESC, chapter_count DESC, assignment_count DESC, courses.id
        """), group).mappings().all()
        target = candidates[0]
        for duplicate in candidates[1:]:
            if duplicate["chapter_count"] or duplicate["assignment_count"]:
                continue
            db_session.query(Class).filter_by(course_id=duplicate["id"]).update(
                {Class.course_id: target["id"]}, synchronize_session=False
            )
            duplicate_course = db_session.get(Course, duplicate["id"])
            if duplicate_course is not None:
                db_session.delete(duplicate_course)

    db_session.flush()
    db_session.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_owner_name "
        "ON courses (owner_external_id, name) WHERE owner_external_id IS NOT NULL"
    ))
    db_session.add(SchemaMigration(version=version))
    db_session.commit()


def migrate_answer_grader_comments():
    """Add per-question grader comments to existing course databases."""
    version = "answer_grader_comments"
    if _migration_applied(version):
        return

    if not _column_exists("answers", "grader_comment"):
        from sqlalchemy import text

        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE answers ADD COLUMN grader_comment TEXT"))
            conn.commit()
    _record_migration(version)


def migrate_grading_status():
    """Distinguish saved grading drafts from results visible to students."""
    version = "grading_status"
    if _migration_applied(version):
        return

    if not _column_exists("grades", "status"):
        from sqlalchemy import text

        with engine.connect() as conn:
            conn.execute(text(
                "ALTER TABLE grades ADD COLUMN status VARCHAR(32) "
                "NOT NULL DEFAULT 'submitted'"
            ))
            conn.commit()
    _record_migration(version)


def run_migrations():
    """Run all pending migrations."""
    lock_path = current_app.config["COURSE_DATABASE"] + ".migration.lock"
    with open(lock_path, "a", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            _ensure_schema_migrations_table()
            migrate_add_student_no()
            migrate_invite_class_name()
            migrate_course_ownership()
            migrate_deduplicate_owned_courses()
            migrate_answer_grader_comments()
            migrate_grading_status()
            migrate_user_class_roles()
            migrate_create_upload_dirs()
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
