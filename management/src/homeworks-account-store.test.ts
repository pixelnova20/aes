import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-homeworks-sync-"));
const accountDatabasePath = path.join(testRoot, "accounts", "accounts.db");
const courseDatabasePath = path.join(testRoot, "accounts", "courses.db");
const slideshowDatabasePath = path.join(testRoot, "accounts", "slideshow.db");
const uploadRoot = path.join(testRoot, "uploads");

const {
  archiveAndDeleteHomeworksUsers,
  configureHomeworksAccountStore,
  syncHomeworksInviteCode,
  syncHomeworksInviteCodeUsage,
  syncHomeworksUser,
} = await import("./homeworks-account-store.js");

configureHomeworksAccountStore({
  accountDatabasePath,
  courseDatabasePath,
  uploadPath: uploadRoot,
  slideshowDatabasePath,
});

async function queryDatabase(databasePath: string, sql: string) {
  const script = [
    "import json, sqlite3, sys",
    "conn = sqlite3.connect(sys.argv[1])",
    "conn.row_factory = sqlite3.Row",
    "row = conn.execute(sys.argv[2]).fetchone()",
    "print(json.dumps(dict(row) if row else None))",
  ].join("\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("python3", ["-c", script, databasePath, sql]);
  return JSON.parse(stdout) as Record<string, unknown> | null;
}

async function executeDatabase(databasePath: string, sql: string) {
  const script = [
    "import sqlite3, sys",
    "conn = sqlite3.connect(sys.argv[1])",
    "conn.executescript(sys.argv[2])",
    "conn.commit()",
  ].join("\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("python3", ["-c", script, databasePath, sql]);
}

await fs.mkdir(path.dirname(slideshowDatabasePath), { recursive: true });
await executeDatabase(slideshowDatabasePath, `
  CREATE TABLE presentations (
    id TEXT PRIMARY KEY,
    class_id INTEGER NOT NULL,
    course_name TEXT NOT NULL,
    class_name TEXT NOT NULL
  );
`);

after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

test("an invitation creates one class and role promotion keeps that class", async () => {
  await syncHomeworksInviteCode({
    code: "ROLE-CODE",
    level: "level_2",
    courseName: "Operating Systems",
    className: "Class 1",
    maxUses: 50,
  });
  await syncHomeworksUser({
    externalId: "cw-role-user",
    email: "student@example.com",
    password: "password",
    name: "Student",
    role: "student",
    studentNo: "S1001",
    courseName: "Operating Systems",
    className: "Class 1",
    inviteCode: "ROLE-CODE",
  });

  const student = await queryDatabase(
    accountDatabasePath,
    "SELECT role, student_no, upload_dir, class_id FROM users WHERE email = 'student@example.com'",
  );
  assert.equal(student?.role, "student");
  assert.equal(student?.student_no, "S1001");
  assert.equal(student?.class_id, 1);
  assert.match(String(student?.upload_dir), /^\d{4}-\d{2}-\d{2}-S1001-ole-user$/);
  await fs.access(path.join(uploadRoot, String(student?.upload_dir)));
  assert.equal(
    (await queryDatabase(courseDatabasePath, "SELECT COUNT(*) AS count FROM classes"))?.count,
    1,
  );

  await syncHomeworksUser({
    externalId: "cw-role-user",
    email: "student@example.com",
    name: "Student",
    role: "teacher",
    studentNo: "S1001",
    courseName: "Operating Systems",
    className: "Class 1",
    inviteCode: "ROLE-CODE",
  });
  const teacher = await queryDatabase(
    accountDatabasePath,
    "SELECT role, upload_dir, class_id FROM users WHERE email = 'student@example.com'",
  );
  assert.equal(teacher?.role, "teacher");
  assert.equal(teacher?.class_id, 1);
  assert.equal(teacher?.upload_dir, student?.upload_dir);
  assert.deepEqual(
    await queryDatabase(
      accountDatabasePath,
      "SELECT class_id, role_in_class FROM user_class_roles WHERE user_id = (SELECT id FROM users WHERE email = 'student@example.com')",
    ),
    { class_id: 1, role_in_class: "teacher" },
  );
});

test("sync stores course and class invitation data without duplicating its class", async () => {
  await syncHomeworksInviteCode({
    code: "TEST-CODE",
    level: "level_2",
    courseName: "Distributed Systems",
    className: "Class 2",
    maxUses: 2,
  });
  await syncHomeworksInviteCodeUsage("TEST-CODE", 2);

  const invite = await queryDatabase(
    accountDatabasePath,
    "SELECT class_id, course_name, class_name, capacity, used_count FROM invite_codes WHERE code = 'TEST-CODE'",
  );
  assert.deepEqual(invite, {
    class_id: 2,
    course_name: "Distributed Systems",
    class_name: "Class 2",
    capacity: 2,
    used_count: 2,
  });
  await executeDatabase(
    slideshowDatabasePath,
    "INSERT INTO presentations VALUES ('deck-1', 2, 'Distributed Systems', 'Class 2')",
  );
  await syncHomeworksInviteCode({
    code: "TEST-CODE",
    level: "level_2",
    courseName: "Distributed Systems",
    className: "Renamed Class",
    maxUses: 3,
  });
  assert.equal(
    (await queryDatabase(courseDatabasePath, "SELECT COUNT(*) AS count FROM classes"))?.count,
    2,
  );
  assert.deepEqual(
    await queryDatabase(
      courseDatabasePath,
      "SELECT name, capacity FROM classes WHERE id = 2",
    ),
    { name: "Renamed Class", capacity: 3 },
  );
  assert.equal(
    (await queryDatabase(
      accountDatabasePath,
      "SELECT class_name FROM invite_codes WHERE code = 'TEST-CODE'",
    ))?.class_name,
    "Renamed Class",
  );
  assert.deepEqual(
    await queryDatabase(
      slideshowDatabasePath,
      "SELECT course_name, class_name FROM presentations WHERE id = 'deck-1'",
    ),
    { course_name: "Distributed Systems", class_name: "Renamed Class" },
  );
});

test("same-named courses are isolated by teacher while one teacher shares a course", async () => {
  await syncHomeworksInviteCode({
    code: "OWNER-A-001",
    level: "level_2",
    courseName: "Shared Course Name",
    className: "Owner A Class 1",
    teacherExternalId: "teacher-owner-a",
    maxUses: 20,
  });
  await syncHomeworksInviteCode({
    code: "OWNER-A-002",
    level: "level_2",
    courseName: "Shared Course Name",
    className: "Owner A Class 2",
    teacherExternalId: "teacher-owner-a",
    maxUses: 20,
  });
  await syncHomeworksInviteCode({
    code: "OWNER-B-001",
    level: "level_2",
    courseName: "Shared Course Name",
    className: "Owner B Class",
    teacherExternalId: "teacher-owner-b",
    maxUses: 20,
  });

  const ownerA = await queryDatabase(
    courseDatabasePath,
    "SELECT course_id FROM classes WHERE name = 'Owner A Class 1'",
  );
  const ownerASecond = await queryDatabase(
    courseDatabasePath,
    "SELECT course_id FROM classes WHERE name = 'Owner A Class 2'",
  );
  const ownerB = await queryDatabase(
    courseDatabasePath,
    "SELECT course_id FROM classes WHERE name = 'Owner B Class'",
  );
  assert.equal(ownerA?.course_id, ownerASecond?.course_id);
  assert.notEqual(ownerA?.course_id, ownerB?.course_id);
  assert.equal(
    (
      await queryDatabase(
        courseDatabasePath,
        "SELECT COUNT(*) AS count FROM courses WHERE name = 'Shared Course Name'",
      )
    )?.count,
    2,
  );
});

test("sync joins a student to an existing invitation class", async () => {
  await executeDatabase(courseDatabasePath, `
    INSERT INTO courses (id, name, description, created_at, updated_at)
    VALUES (50, 'Computer Networks', NULL, datetime('now'), datetime('now'));
    INSERT INTO classes (id, name, course_id, capacity, current_count, created_at, enabled)
    VALUES (50, 'Class 50', 50, 50, 0, datetime('now'), 1);
  `);

  await syncHomeworksUser({
    externalId: "cw-joined-user",
    email: "joined@example.com",
    password: "password",
    name: "Joined Student",
    role: "student",
    studentNo: "S1002",
    courseName: "Computer Networks",
    className: "Class 50",
    inviteCode: "JOIN-CODE",
  });

  const membership = await queryDatabase(
    accountDatabasePath,
    "SELECT role_in_class, class_id FROM user_class_roles WHERE user_id = (SELECT id FROM users WHERE email = 'joined@example.com')",
  );
  assert.deepEqual(membership, { role_in_class: "student", class_id: 50 });
  assert.equal(
    (await queryDatabase(courseDatabasePath, "SELECT current_count FROM classes WHERE id = 50"))?.current_count,
    1,
  );
});

test("deletion archives and removes Homeworks account, coursework, and uploaded files", async () => {
  await syncHomeworksInviteCode({
    code: "ARCHIVE-CODE",
    level: "level_2",
    courseName: "Archive Course",
    className: "Archive Class",
    maxUses: 5,
  });
  await syncHomeworksUser({
    externalId: "cw-archive-user",
    email: "archive@example.com",
    password: "password",
    name: "Archive Student",
    role: "student",
    studentNo: "ARCHIVE1001",
    courseName: "Archive Course",
    className: "Archive Class",
    inviteCode: "ARCHIVE-CODE",
  });
  const user = await queryDatabase(
    accountDatabasePath,
    "SELECT id, upload_dir FROM users WHERE email = 'archive@example.com'",
  );
  const userId = Number(user?.id);
  const uploadDirectory = String(user?.upload_dir);
  const relativeFile = path.join(uploadDirectory, "answer.txt");
  await fs.writeFile(path.join(uploadRoot, relativeFile), "archived answer\n", "utf8");

  await executeDatabase(accountDatabasePath, `
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER);
    INSERT INTO audit_logs (id, user_id) VALUES (9001, ${userId});
  `);
  await executeDatabase(courseDatabasePath, `
    CREATE TABLE IF NOT EXISTS assignments (id INTEGER PRIMARY KEY, publisher_id INTEGER, class_id INTEGER);
    CREATE TABLE IF NOT EXISTS assignment_questions (id INTEGER PRIMARY KEY, assignment_id INTEGER);
    CREATE TABLE IF NOT EXISTS assignment_question_options (id INTEGER PRIMARY KEY, assignment_question_id INTEGER);
    CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY, assignment_id INTEGER, student_id INTEGER);
    CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY, submission_id INTEGER);
    CREATE TABLE IF NOT EXISTS uploaded_files (id INTEGER PRIMARY KEY, answer_id INTEGER, uploader_id INTEGER, file_path TEXT);
    CREATE TABLE IF NOT EXISTS grades (id INTEGER PRIMARY KEY, submission_id INTEGER, grader_id INTEGER);
    INSERT INTO assignments VALUES (9001, ${userId}, NULL);
    INSERT INTO assignment_questions VALUES (9001, 9001);
    INSERT INTO assignment_question_options VALUES (9001, 9001);
    INSERT INTO submissions VALUES (9001, 9001, ${userId});
    INSERT INTO answers VALUES (9001, 9001);
    INSERT INTO uploaded_files VALUES (9001, 9001, ${userId}, '${relativeFile}');
    INSERT INTO grades VALUES (9001, 9001, ${userId});
  `);

  const archiveDirectory = path.join(testRoot, "archive", "deletion");
  await archiveAndDeleteHomeworksUsers({
    externalIds: ["cw-archive-user"],
    archiveDirectory,
    inviteCodes: ["ARCHIVE-CODE"],
  });

  const snapshot = JSON.parse(await fs.readFile(path.join(archiveDirectory, "homeworks.json"), "utf8"));
  assert.equal(snapshot.users[0].email, "archive@example.com");
  assert.equal(snapshot.assignments[0].id, 9001);
  assert.equal(snapshot.submissions[0].id, 9001);
  assert.equal(snapshot.grades[0].id, 9001);
  assert.equal(
    await fs.readFile(path.join(archiveDirectory, "homeworks-uploads", relativeFile), "utf8"),
    "archived answer\n",
  );
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM users WHERE email = 'archive@example.com'"))?.count,
    0,
  );
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM invite_codes WHERE code = 'ARCHIVE-CODE'"))?.count,
    0,
  );
  assert.equal(
    (await queryDatabase(courseDatabasePath, "SELECT COUNT(*) AS count FROM assignments WHERE id = 9001"))?.count,
    0,
  );
  await assert.rejects(fs.access(path.join(uploadRoot, uploadDirectory)));
});

test("same email can be synchronized as separate class accounts", async () => {
  await syncHomeworksInviteCode({
    code: "MULTI-001",
    level: "level_2",
    courseName: "Operating Systems",
    className: "Class Multi 1",
    maxUses: 20,
  });
  await syncHomeworksInviteCode({
    code: "MULTI-002",
    level: "level_2",
    courseName: "Operating Systems",
    className: "Class Multi 2",
    maxUses: 20,
  });
  await syncHomeworksUser({
    externalId: "cw-multi-one",
    email: "multi@example.com",
    password: "password",
    name: "Multi One",
    role: "student",
    studentNo: "MULTI1001",
    courseName: "Operating Systems",
    className: "Class Multi 1",
    inviteCode: "MULTI-001",
  });
  await syncHomeworksUser({
    externalId: "cw-multi-two",
    email: "multi@example.com",
    password: "password",
    name: "Multi Two",
    role: "student",
    studentNo: "MULTI1001",
    courseName: "Operating Systems",
    className: "Class Multi 2",
    inviteCode: "MULTI-002",
  });
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM users WHERE email = 'multi@example.com'"))?.count,
    2,
  );

  const archiveDirectory = path.join(testRoot, "archive", "multi-class-deletion");
  await archiveAndDeleteHomeworksUsers({
    externalIds: ["cw-multi-one"],
    archiveDirectory,
    inviteCodes: ["MULTI-001"],
  });
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM users WHERE external_id = 'cw-multi-one'"))?.count,
    0,
  );
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM users WHERE external_id = 'cw-multi-two'"))?.count,
    1,
  );
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM invite_codes WHERE code = 'MULTI-002'"))?.count,
    1,
  );
  const snapshot = JSON.parse(await fs.readFile(path.join(archiveDirectory, "homeworks.json"), "utf8"));
  assert.deepEqual(snapshot.users.map((user: { external_id: string }) => user.external_id), ["cw-multi-one"]);
});

test("class deletion archives class assignments without deleting its teacher", async () => {
  await syncHomeworksInviteCode({
    code: "CLASS-DELETE-001",
    level: "level_2",
    courseName: "Class Delete Course",
    className: "Class Delete Group",
    maxUses: 20,
  });
  await syncHomeworksUser({
    externalId: "cw-class-delete-teacher",
    email: "class-delete-teacher@example.com",
    password: "password",
    name: "Class Delete Teacher",
    role: "teacher",
    courseName: "Class Delete Course",
    className: "Class Delete Group",
    inviteCode: "CLASS-DELETE-L1",
    classInviteCode: "CLASS-DELETE-001",
  });
  const klass = await queryDatabase(
    accountDatabasePath,
    "SELECT class_id FROM invite_codes WHERE code = 'CLASS-DELETE-001'",
  );
  const teacher = await queryDatabase(
    accountDatabasePath,
    "SELECT id FROM users WHERE external_id = 'cw-class-delete-teacher'",
  );
  await executeDatabase(courseDatabasePath, `
    INSERT INTO assignments (id, publisher_id, class_id)
    VALUES (9002, ${Number(teacher?.id)}, ${Number(klass?.class_id)});
  `);

  const archiveDirectory = path.join(testRoot, "archive", "class-deletion");
  await archiveAndDeleteHomeworksUsers({
    externalIds: [],
    archiveDirectory,
    inviteCodes: ["CLASS-DELETE-001"],
  });
  const snapshot = JSON.parse(await fs.readFile(path.join(archiveDirectory, "homeworks.json"), "utf8"));
  assert.equal(snapshot.assignments[0].id, 9002);
  assert.equal(snapshot.classes[0].id, klass?.class_id);
  assert.equal(
    (await queryDatabase(accountDatabasePath, "SELECT COUNT(*) AS count FROM users WHERE external_id = 'cw-class-delete-teacher'"))?.count,
    1,
  );
  assert.equal(
    (await queryDatabase(courseDatabasePath, `SELECT COUNT(*) AS count FROM classes WHERE id = ${Number(klass?.class_id)}`))?.count,
    0,
  );
  assert.equal(
    (await queryDatabase(courseDatabasePath, "SELECT COUNT(*) AS count FROM assignments WHERE id = 9002"))?.count,
    0,
  );
});
