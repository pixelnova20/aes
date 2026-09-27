import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type HomeworksStorageConfig = {
  accountDatabasePath: string;
  courseDatabasePath: string;
  uploadPath: string;
  slideshowDatabasePath?: string;
};

let storageConfig: HomeworksStorageConfig | null = null;

export function configureHomeworksAccountStore(config: HomeworksStorageConfig) {
  storageConfig = { ...config };
}

function getStorageConfig() {
  if (!storageConfig) {
    throw new Error("Homeworks account store has not been configured.");
  }
  return storageConfig;
}

type HomeworksRole = "super_admin" | "teacher" | "ta" | "student";

type SyncUserInput = {
  externalId: string;
  email: string;
  password?: string;
  name?: string | null;
  role: HomeworksRole;
  studentNo?: string | null;
  courseName?: string | null;
  className?: string | null;
  inviteCode?: string | null;
  classInviteCode?: string | null;
  enabled?: boolean;
};

type SyncInviteInput = {
  code: string;
  level: "level_1" | "level_2";
  courseName?: string | null;
  className?: string | null;
  parentCode?: string | null;
  teacherExternalId?: string | null;
  maxUses: number;
  usedCount?: number;
  isActive?: boolean;
  expiresAt?: Date | string | null;
};

const execFileAsync = promisify(execFile);

const HOMEWORKS_SYNC_SCRIPT = String.raw`
import json
import os
import secrets
import shutil
import sqlite3
import sys
from datetime import datetime
from werkzeug.security import generate_password_hash


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")


def dt(value):
    if not value:
        return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S.%f")
        except ValueError:
            return value
    return value


def ensure_schema(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS courses (
        id INTEGER NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        owner_external_id VARCHAR(191),
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
    )""")
    course_columns = {row[1] for row in cur.execute("PRAGMA table_info(courses)")}
    if "owner_external_id" not in course_columns:
        cur.execute("ALTER TABLE courses ADD COLUMN owner_external_id VARCHAR(191)")
    cur.execute("CREATE INDEX IF NOT EXISTS ix_courses_owner_external_id ON courses (owner_external_id)")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_courses_owner_name ON courses (owner_external_id, name) WHERE owner_external_id IS NOT NULL")
    cur.execute("""CREATE TABLE IF NOT EXISTS classes (
        id INTEGER NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        course_id INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        current_count INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        enabled BOOLEAN NOT NULL,
        FOREIGN KEY(course_id) REFERENCES courses (id)
    )""")
    cur.execute("""CREATE TABLE IF NOT EXISTS accounts.users (
        id INTEGER NOT NULL PRIMARY KEY,
        external_id VARCHAR(191) UNIQUE,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL,
        course_name VARCHAR(255),
        class_id INTEGER,
        enabled BOOLEAN NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        last_login_at DATETIME,
        student_no VARCHAR(64),
        invite_code VARCHAR(64),
        upload_dir VARCHAR(512)
    )""")
    user_columns = {row[1] for row in cur.execute("PRAGMA accounts.table_info(users)")}
    if "external_id" not in user_columns:
        cur.execute("ALTER TABLE accounts.users ADD COLUMN external_id VARCHAR(191)")
    if "invite_code" not in user_columns:
        cur.execute("ALTER TABLE accounts.users ADD COLUMN invite_code VARCHAR(64)")
    cur.execute("DROP INDEX IF EXISTS accounts.ix_accounts_users_email")
    cur.execute("DROP INDEX IF EXISTS accounts.ix_accounts_users_student_no")
    cur.execute("CREATE INDEX IF NOT EXISTS accounts.ix_users_email ON users (email)")
    cur.execute("CREATE INDEX IF NOT EXISTS accounts.ix_users_student_no ON users (student_no)")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS accounts.ux_users_external_id ON users (external_id) WHERE external_id IS NOT NULL")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS accounts.ux_users_email_invite ON users (email, invite_code) WHERE invite_code IS NOT NULL")
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS accounts.ux_users_student_invite ON users (student_no, invite_code) WHERE student_no IS NOT NULL AND invite_code IS NOT NULL")
    cur.execute("""CREATE TABLE IF NOT EXISTS accounts.invite_codes (
        id INTEGER NOT NULL PRIMARY KEY,
        code VARCHAR(64) NOT NULL UNIQUE,
        class_id INTEGER,
        course_name VARCHAR(255),
        class_name VARCHAR(255),
        capacity INTEGER,
        used_count INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL,
        expires_at DATETIME,
        created_at DATETIME NOT NULL
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS accounts.ix_invite_codes_code ON invite_codes (code)")
    columns = {row[1] for row in cur.execute("PRAGMA accounts.table_info(invite_codes)")}
    if "course_name" not in columns:
        cur.execute("ALTER TABLE accounts.invite_codes ADD COLUMN course_name VARCHAR(255)")
    if "level" not in columns:
        cur.execute("ALTER TABLE accounts.invite_codes ADD COLUMN level VARCHAR(16) NOT NULL DEFAULT 'level_1'")
    if "parent_code" not in columns:
        cur.execute("ALTER TABLE accounts.invite_codes ADD COLUMN parent_code VARCHAR(64)")
    if "teacher_external_id" not in columns:
        cur.execute("ALTER TABLE accounts.invite_codes ADD COLUMN teacher_external_id VARCHAR(191)")
    cur.execute("""CREATE TABLE IF NOT EXISTS accounts.user_class_roles (
        id INTEGER NOT NULL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        role_in_class VARCHAR(32) NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE(user_id, class_id)
    )""")


def find_class(cur, class_name, course_name=None):
    if not class_name:
        return None
    if course_name:
        cur.execute(
            """SELECT classes.id FROM classes
               JOIN courses ON courses.id = classes.course_id
               WHERE classes.name = ? AND courses.name = ? AND classes.enabled = 1
               ORDER BY classes.id LIMIT 1""",
            (class_name, course_name),
        )
        row = cur.fetchone()
        return row["id"] if row else None
    cur.execute(
        "SELECT id FROM classes WHERE name = ? AND enabled = 1 ORDER BY id",
        (class_name,),
    )
    rows = cur.fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def ensure_class(cur, class_name, course_name, capacity, teacher_external_id=None):
    # Courseworks invitation codes are authoritative. A new owned invitation
    # always receives its own class instead of claiming a similarly named
    # legacy class from another teacher.
    class_id = None if teacher_external_id else find_class(cur, class_name, course_name)
    if class_id is not None:
        claimed = cur.execute(
            "SELECT 1 FROM accounts.invite_codes WHERE class_id = ? LIMIT 1",
            (class_id,),
        ).fetchone()
        if claimed is not None:
            class_id = None
    if class_id is not None:
        cur.execute(
            "UPDATE classes SET capacity = MAX(capacity, ?), enabled = 1 WHERE id = ?",
            (max(int(capacity or 1), 1), class_id),
        )
        return class_id
    if teacher_external_id:
        cur.execute(
            "SELECT id FROM courses WHERE name = ? AND owner_external_id = ? ORDER BY id LIMIT 1",
            (course_name, teacher_external_id),
        )
    else:
        cur.execute(
            "SELECT id FROM courses WHERE name = ? AND owner_external_id IS NULL ORDER BY id LIMIT 1",
            (course_name,),
        )
    course = cur.fetchone()
    if course is None:
        timestamp = now()
        try:
            cur.execute(
                "INSERT INTO courses (name, description, owner_external_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
                (course_name, teacher_external_id, timestamp, timestamp),
            )
            course_id = cur.lastrowid
        except sqlite3.IntegrityError:
            cur.execute(
                "SELECT id FROM courses WHERE name = ? AND owner_external_id = ? ORDER BY id LIMIT 1",
                (course_name, teacher_external_id),
            )
            course_id = cur.fetchone()["id"]
    else:
        course_id = course["id"]
    cur.execute(
        """INSERT INTO classes
           (name, course_id, capacity, current_count, created_at, enabled)
           VALUES (?, ?, ?, 0, ?, 1)""",
        (class_name, course_id, max(int(capacity or 1), 1), now()),
    )
    return cur.lastrowid


def recalc_class_count(cur, class_id):
    if class_id is None:
        return
    cur.execute(
        "SELECT COUNT(*) AS count FROM accounts.user_class_roles WHERE class_id = ? AND role_in_class = 'student'",
        (class_id,),
    )
    count = cur.fetchone()["count"]
    cur.execute("UPDATE classes SET current_count = ? WHERE id = ?", (count, class_id))


def ensure_upload_dir(payload, role, student_no, existing_upload_dir=None):
    if existing_upload_dir or role != "student" or not student_no:
        return existing_upload_dir
    if not student_no.isascii() or not student_no.isalnum():
        raise ValueError("Student number must contain only letters and digits")
    upload_root = payload.get("uploadRoot")
    if not upload_root:
        raise ValueError("Homeworks upload root is not configured")
    account_suffix = (payload.get("externalId") or secrets.token_hex(4))[-8:]
    dirname = f"{datetime.now().strftime('%Y-%m-%d')}-{student_no}-{account_suffix}"
    os.makedirs(os.path.join(upload_root, dirname), exist_ok=True)
    return dirname


def sync_invite(cur, payload):
    level = payload["level"]
    course_name = payload.get("courseName")
    class_name = payload.get("className")
    cur.execute("SELECT id, class_id FROM accounts.invite_codes WHERE code = ?", (payload["code"],))
    row = cur.fetchone()
    class_id = None
    if level == "level_2" and course_name and class_name:
        class_id = row["class_id"] if row and row["class_id"] is not None else ensure_class(
            cur,
            class_name,
            course_name,
            payload.get("maxUses"),
            payload.get("teacherExternalId"),
        )
        cur.execute(
            "UPDATE classes SET name = ?, capacity = ?, enabled = 1 WHERE id = ?",
            (class_name, max(int(payload.get("maxUses") or 1), 1), class_id),
        )
        cur.execute(
            "UPDATE accounts.users SET course_name = ?, updated_at = ? WHERE class_id = ?",
            (course_name, now(), class_id),
        )
        if slideshow_attached:
            cur.execute(
                "UPDATE slideshow.presentations SET course_name = ?, class_name = ? WHERE class_id = ?",
                (course_name, class_name, class_id),
            )
    values = (
        class_id,
        course_name,
        class_name,
        int(payload.get("maxUses") or 1),
        int(payload.get("usedCount") or 0),
        1 if payload.get("isActive", True) else 0,
        dt(payload.get("expiresAt")),
        level,
        payload.get("parentCode"),
        payload.get("teacherExternalId"),
    )
    if row:
        cur.execute(
            "UPDATE accounts.invite_codes SET class_id = ?, course_name = ?, class_name = ?, capacity = ?, used_count = ?, enabled = ?, expires_at = ?, level = ?, parent_code = ?, teacher_external_id = ? WHERE id = ?",
            (*values, row["id"]),
        )
    else:
        cur.execute(
            "INSERT INTO accounts.invite_codes (code, class_id, course_name, class_name, capacity, used_count, enabled, expires_at, level, parent_code, teacher_external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (payload["code"], *values, now()),
        )


def sync_user(cur, payload):
    role = payload["role"]
    course_name = payload.get("courseName") or "Courseworks"
    class_invite_code = payload.get("classInviteCode")
    if not class_invite_code and role in ("student", "ta"):
        class_invite_code = payload.get("inviteCode")
    matched_class_id = None
    if class_invite_code:
        class_invite = cur.execute(
            "SELECT class_id FROM accounts.invite_codes WHERE code = ?",
            (class_invite_code,),
        ).fetchone()
        matched_class_id = class_invite["class_id"] if class_invite else None
    if matched_class_id is None and role != "super_admin" and payload.get("className"):
        matched_class_id = find_class(cur, payload.get("className"), course_name)
    password = payload.get("password")
    password_hash = generate_password_hash(password) if password else None
    if password_hash is None:
        password_hash = generate_password_hash(secrets.token_urlsafe(24))
    name = payload.get("name") or payload["email"].split("@", 1)[0]
    enabled = 1 if payload.get("enabled", True) else 0
    student_no = payload.get("studentNo") or None

    cur.execute(
        "SELECT id, password_hash, upload_dir, role, class_id FROM accounts.users WHERE external_id = ?",
        (payload["externalId"],),
    )
    row = cur.fetchone()
    if row is None:
        legacy_rows = cur.execute(
            "SELECT id, password_hash, upload_dir, role, class_id FROM accounts.users WHERE email = ? AND external_id IS NULL ORDER BY id",
            (payload["email"],),
        ).fetchall()
        row = legacy_rows[0] if len(legacy_rows) == 1 else None
    if row:
        role_changed = row["role"] != role
        old_class_ids = [r["class_id"] for r in cur.execute(
            "SELECT class_id FROM accounts.user_class_roles WHERE user_id = ?", (row["id"],)
        ).fetchall()]
        if role_changed:
            cur.execute("DELETE FROM accounts.user_class_roles WHERE user_id = ?", (row["id"],))
        class_id = matched_class_id if matched_class_id is not None else (None if role_changed else row["class_id"])
        next_hash = generate_password_hash(password) if password else row["password_hash"]
        upload_dir = ensure_upload_dir(payload, role, student_no, row["upload_dir"])
        cur.execute(
            """UPDATE accounts.users
               SET external_id = ?, email = ?, password_hash = ?, name = ?, role = ?, student_no = ?, course_name = ?,
                   class_id = ?, enabled = ?, upload_dir = ?, invite_code = ?, updated_at = ?
               WHERE id = ?""",
            (
                payload["externalId"],
                payload["email"],
                next_hash,
                name,
                role,
                student_no,
                course_name,
                class_id,
                enabled,
                upload_dir,
                payload.get("inviteCode"),
                now(),
                row["id"],
            ),
        )
        user_id = row["id"]
    else:
        old_class_ids = []
        class_id = matched_class_id
        upload_dir = ensure_upload_dir(payload, role, student_no)
        cur.execute(
            """INSERT INTO accounts.users
               (external_id, email, password_hash, name, role, student_no, course_name, class_id,
                enabled, created_at, updated_at, last_login_at, invite_code, upload_dir)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)""",
            (
                payload["externalId"],
                payload["email"],
                password_hash,
                name,
                role,
                student_no,
                course_name,
                class_id,
                enabled,
                now(),
                now(),
                payload.get("inviteCode"),
                upload_dir,
            ),
        )
        user_id = cur.lastrowid

    if role != "super_admin" and matched_class_id is not None:
        cur.execute(
            """INSERT INTO accounts.user_class_roles (user_id, class_id, role_in_class, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, class_id) DO UPDATE SET role_in_class = excluded.role_in_class""",
            (user_id, matched_class_id, role, now()),
        )
    for affected_class_id in set(old_class_ids + ([matched_class_id] if matched_class_id else [])):
        recalc_class_count(cur, affected_class_id)


def fetch_rows(cur, sql, values=()):
    return [dict(row) for row in cur.execute(sql, values).fetchall()]


def id_list(rows):
    return [row["id"] for row in rows]


def placeholders(values):
    return ",".join("?" for _ in values)


def fetch_by_ids(cur, table, column, values):
    if not values:
        return []
    return fetch_rows(
        cur,
        f"SELECT * FROM {table} WHERE {column} IN ({placeholders(values)}) ORDER BY id",
        values,
    )


def delete_by_ids(cur, table, values):
    if values:
        cur.execute(
            f"DELETE FROM {table} WHERE id IN ({placeholders(values)})",
            values,
        )


def copy_upload_to_archive(upload_root, relative_path, archive_directory, inventory):
    if not relative_path:
        return
    if os.path.isabs(relative_path):
        raise ValueError(f"Upload path must be relative: {relative_path}")
    root = os.path.realpath(upload_root)
    source = os.path.realpath(os.path.join(root, relative_path))
    if os.path.commonpath([root, source]) != root:
        raise ValueError(f"Upload path is outside configured root: {relative_path}")
    destination = os.path.join(archive_directory, "homeworks-uploads", relative_path)
    exists = os.path.exists(source)
    inventory.append({"path": relative_path, "archived": exists})
    if not exists:
        return
    os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
    if os.path.isdir(source):
        shutil.copytree(source, destination, dirs_exist_ok=True)
    else:
        shutil.copy2(source, destination)


def archive_and_delete_users(cur, payload):
    external_ids = sorted(set(payload.get("externalIds") or []))
    archive_directory = payload["archiveDirectory"]
    upload_root = payload["uploadRoot"]
    os.makedirs(archive_directory, mode=0o700, exist_ok=True)

    users = []
    if external_ids:
        users = fetch_rows(
            cur,
            f"SELECT * FROM accounts.users WHERE external_id IN ({placeholders(external_ids)}) ORDER BY id",
            external_ids,
        )
    user_ids = id_list(users)
    invite_codes = sorted(set(payload.get("inviteCodes") or []))
    invite_rows = []
    if invite_codes:
        invite_rows = fetch_rows(
            cur,
            f"SELECT * FROM accounts.invite_codes WHERE code IN ({placeholders(invite_codes)}) ORDER BY id",
            invite_codes,
        )
    deleted_class_ids = sorted({
        row["class_id"] for row in invite_rows if row.get("class_id") is not None
    })
    membership_clauses = []
    membership_values = []
    if user_ids:
        membership_clauses.append(f"user_id IN ({placeholders(user_ids)})")
        membership_values.extend(user_ids)
    if deleted_class_ids:
        membership_clauses.append(f"class_id IN ({placeholders(deleted_class_ids)})")
        membership_values.extend(deleted_class_ids)
    memberships = fetch_rows(
        cur,
        f"SELECT * FROM accounts.user_class_roles WHERE {' OR '.join(membership_clauses)} ORDER BY id",
        membership_values,
    ) if membership_clauses else []
    audit_logs = fetch_by_ids(cur, "accounts.audit_logs", "user_id", user_ids)

    assignment_clauses = []
    assignment_values = []
    if user_ids:
        assignment_clauses.append(f"publisher_id IN ({placeholders(user_ids)})")
        assignment_values.extend(user_ids)
    if deleted_class_ids:
        assignment_clauses.append(f"class_id IN ({placeholders(deleted_class_ids)})")
        assignment_values.extend(deleted_class_ids)
    assignments = fetch_rows(
        cur,
        f"SELECT * FROM assignments WHERE {' OR '.join(assignment_clauses)} ORDER BY id",
        assignment_values,
    ) if assignment_clauses else []
    assignment_ids = id_list(assignments)
    submissions = []
    if user_ids or assignment_ids:
        clauses = []
        values = []
        if user_ids:
            clauses.append(f"student_id IN ({placeholders(user_ids)})")
            values.extend(user_ids)
        if assignment_ids:
            clauses.append(f"assignment_id IN ({placeholders(assignment_ids)})")
            values.extend(assignment_ids)
        submissions = fetch_rows(
            cur,
            f"SELECT * FROM submissions WHERE {' OR '.join(clauses)} ORDER BY id",
            values,
        )
    submission_ids = id_list(submissions)
    answers = fetch_by_ids(cur, "answers", "submission_id", submission_ids)
    answer_ids = id_list(answers)

    uploaded_files = []
    if answer_ids or user_ids:
        clauses = []
        values = []
        if answer_ids:
            clauses.append(f"answer_id IN ({placeholders(answer_ids)})")
            values.extend(answer_ids)
        if user_ids:
            clauses.append(f"uploader_id IN ({placeholders(user_ids)})")
            values.extend(user_ids)
        uploaded_files = fetch_rows(
            cur,
            f"SELECT * FROM uploaded_files WHERE {' OR '.join(clauses)} ORDER BY id",
            values,
        )

    grades = []
    if submission_ids or user_ids:
        clauses = []
        values = []
        if submission_ids:
            clauses.append(f"submission_id IN ({placeholders(submission_ids)})")
            values.extend(submission_ids)
        if user_ids:
            clauses.append(f"grader_id IN ({placeholders(user_ids)})")
            values.extend(user_ids)
        grades = fetch_rows(
            cur,
            f"SELECT * FROM grades WHERE {' OR '.join(clauses)} ORDER BY id",
            values,
        )

    assignment_questions = fetch_by_ids(
        cur, "assignment_questions", "assignment_id", assignment_ids
    )
    assignment_question_ids = id_list(assignment_questions)
    assignment_question_options = fetch_by_ids(
        cur,
        "assignment_question_options",
        "assignment_question_id",
        assignment_question_ids,
    )
    deleted_classes = fetch_by_ids(cur, "classes", "id", deleted_class_ids)

    upload_inventory = []
    upload_paths = {row.get("file_path") for row in uploaded_files if row.get("file_path")}
    upload_paths.update(row.get("upload_dir") for row in users if row.get("upload_dir"))
    for relative_path in sorted(upload_paths):
        copy_upload_to_archive(
            upload_root, relative_path, archive_directory, upload_inventory
        )

    snapshot = {
        "users": users,
        "user_class_roles": memberships,
        "audit_logs": audit_logs,
        "invite_codes": invite_rows,
        "classes": deleted_classes,
        "assignments": assignments,
        "assignment_questions": assignment_questions,
        "assignment_question_options": assignment_question_options,
        "submissions": submissions,
        "answers": answers,
        "uploaded_files": uploaded_files,
        "grades": grades,
        "upload_inventory": upload_inventory,
    }
    snapshot_path = os.path.join(archive_directory, "homeworks.json")
    with open(snapshot_path, "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, indent=2, default=str)
        handle.write("\n")
    os.chmod(snapshot_path, 0o600)

    affected_class_ids = {row["class_id"] for row in memberships} | set(deleted_class_ids)
    delete_by_ids(cur, "grades", id_list(grades))
    delete_by_ids(cur, "uploaded_files", id_list(uploaded_files))
    delete_by_ids(cur, "answers", answer_ids)
    delete_by_ids(cur, "submissions", submission_ids)
    delete_by_ids(cur, "assignment_question_options", id_list(assignment_question_options))
    delete_by_ids(cur, "assignment_questions", assignment_question_ids)
    delete_by_ids(cur, "assignments", assignment_ids)
    delete_by_ids(cur, "accounts.user_class_roles", id_list(memberships))
    delete_by_ids(cur, "accounts.audit_logs", id_list(audit_logs))
    delete_by_ids(cur, "accounts.users", user_ids)
    if invite_codes:
        cur.execute(
            f"DELETE FROM accounts.invite_codes WHERE code IN ({placeholders(invite_codes)})",
            invite_codes,
        )
    delete_by_ids(cur, "classes", deleted_class_ids)
    for class_id in affected_class_ids:
        if class_id not in deleted_class_ids:
            recalc_class_count(cur, class_id)

    return sorted(upload_paths)


payload = json.loads(sys.argv[1])
account_db_path = payload["accountDbPath"]
course_db_path = payload["courseDbPath"]
slideshow_db_path = payload.get("slideshowDatabasePath")
os.makedirs(os.path.dirname(account_db_path), exist_ok=True)
os.makedirs(os.path.dirname(course_db_path), exist_ok=True)
conn = sqlite3.connect(course_db_path)
conn.row_factory = sqlite3.Row
try:
    conn.execute("ATTACH DATABASE ? AS accounts", (account_db_path,))
    slideshow_attached = bool(slideshow_db_path and os.path.isfile(slideshow_db_path))
    if slideshow_attached:
        conn.execute("ATTACH DATABASE ? AS slideshow", (slideshow_db_path,))
    cur = conn.cursor()
    ensure_schema(cur)
    action = payload["action"]
    remove_upload_paths = []
    if action == "sync_user":
        sync_user(cur, payload)
    elif action == "sync_invite":
        sync_invite(cur, payload)
    elif action == "delete_invite":
        cur.execute("DELETE FROM accounts.invite_codes WHERE code = ?", (payload["code"],))
    elif action == "set_invite_status":
        cur.execute(
            "UPDATE accounts.invite_codes SET enabled = ? WHERE code = ?",
            (1 if payload.get("isActive", True) else 0, payload["code"]),
        )
    elif action == "set_invite_usage":
        cur.execute(
            "UPDATE accounts.invite_codes SET used_count = ? WHERE code = ?",
            (int(payload["usedCount"]), payload["code"]),
        )
        if cur.rowcount != 1:
            raise RuntimeError("Homeworks invite code not found")
    elif action == "archive_delete_users":
        remove_upload_paths = archive_and_delete_users(cur, payload)
    else:
        raise RuntimeError(f"Unknown action: {action}")
    conn.commit()
finally:
    conn.close()

if payload.get("action") == "archive_delete_users":
    upload_root = os.path.realpath(payload["uploadRoot"])
    for relative_path in sorted(remove_upload_paths, key=len, reverse=True):
        source = os.path.realpath(os.path.join(upload_root, relative_path))
        if os.path.commonpath([upload_root, source]) != upload_root:
            continue
        if os.path.isdir(source):
            shutil.rmtree(source)
        elif os.path.isfile(source):
            os.remove(source)
`;

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function runHomeworksSync(payload: Record<string, unknown>) {
  const config = getStorageConfig();
  await execFileAsync(
    "python3",
    ["-c", HOMEWORKS_SYNC_SCRIPT, JSON.stringify({
      accountDbPath: config.accountDatabasePath,
      courseDbPath: config.courseDatabasePath,
      uploadRoot: config.uploadPath,
      slideshowDatabasePath: config.slideshowDatabasePath,
      ...payload,
    })],
    { maxBuffer: 1024 * 1024 },
  );
}

export async function syncHomeworksUser(input: SyncUserInput) {
  await runHomeworksSync({
    action: "sync_user",
    externalId: input.externalId,
    email: input.email,
    password: input.password,
    name: input.name,
    role: input.role,
    studentNo: input.studentNo,
    courseName: input.courseName,
    className: input.className,
    inviteCode: input.inviteCode,
    classInviteCode: input.classInviteCode,
    enabled: input.enabled,
  });
}

export async function syncHomeworksInviteCode(input: SyncInviteInput) {
  await runHomeworksSync({
    action: "sync_invite",
    code: input.code,
    level: input.level,
    courseName: input.courseName,
    className: input.className,
    parentCode: input.parentCode,
    teacherExternalId: input.teacherExternalId,
    maxUses: input.maxUses,
    usedCount: input.usedCount ?? 0,
    isActive: input.isActive ?? true,
    expiresAt: normalizeDate(input.expiresAt),
  });
}

export async function syncHomeworksInviteCodeStatus(code: string, isActive: boolean) {
  await runHomeworksSync({ action: "set_invite_status", code, isActive });
}

export async function syncHomeworksInviteCodeUsage(code: string, usedCount: number) {
  await runHomeworksSync({ action: "set_invite_usage", code, usedCount });
}

export async function deleteHomeworksInviteCode(code: string) {
  await runHomeworksSync({ action: "delete_invite", code });
}

export async function archiveAndDeleteHomeworksUsers(input: {
  externalIds: string[];
  archiveDirectory: string;
  inviteCodes?: string[];
}) {
  await runHomeworksSync({
    action: "archive_delete_users",
    externalIds: input.externalIds,
    archiveDirectory: input.archiveDirectory,
    inviteCodes: input.inviteCodes,
  });
}
