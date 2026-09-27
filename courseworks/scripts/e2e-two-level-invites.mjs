import assert from "node:assert/strict";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:10002/api";
const suffix = Date.now().toString(36);
const level1Code = `E2E-${suffix}`;
const teacherEmail = `teacher-${suffix}@example.com`;
const sharedStudentEmail = `student-${suffix}@example.com`;
const courseName = process.env.E2E_COURSE_NAME ?? "操作系统原理实验";
const serviceOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

if (!adminEmail || !adminPassword) {
  throw new Error("E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required.");
}

async function request(path, { token, expected = 200, ...init } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${init.method ?? "GET"} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function openHomeworksSession(ssoPath) {
  const response = await fetch(new URL(ssoPath, serviceOrigin), { redirect: "manual" });
  assert.equal(response.status, 302);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const location = response.headers.get("location");
  assert(cookie && location);
  const dashboard = await fetch(new URL(location, serviceOrigin), { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  return { cookie, html: await dashboard.text() };
}

async function testDirectHomeworksLogin(email, password, expectedClassName) {
  const loginUrl = new URL("/homeworks/login", serviceOrigin);
  const landing = await fetch(loginUrl);
  assert.equal(landing.status, 200);
  let cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  const landingHtml = await landing.text();
  const csrf = landingHtml.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert(cookie && csrf);
  assert.doesNotMatch(landingHtml, /name="invite_code"/);

  const attempt = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
  });
  assert.equal(attempt.status, 302);
  assert.match(attempt.headers.get("location") ?? "", /student/);
  cookie = attempt.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
  const dashboard = await fetch(new URL(attempt.headers.get("location"), serviceOrigin), {
    headers: { Cookie: cookie },
  });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), new RegExp(expectedClassName));
}

const admin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
});

await request("/admin/invite-codes", {
  method: "POST",
  token: admin.token,
  expected: 201,
  body: JSON.stringify({ code: level1Code, description: "Two-level E2E" }),
});

const missingEmployeeNumber = await request("/auth/register", {
  method: "POST",
  expected: 400,
  body: JSON.stringify({
    email: teacherEmail,
    password: "teacher123",
    confirmPassword: "teacher123",
    name: "E2E Teacher",
    studentNo: "",
    inviteCode: level1Code,
  }),
});
assert.equal(missingEmployeeNumber.message, "请输入教师工号。");

const teacher = await request("/auth/register", {
  method: "POST",
  expected: 201,
  body: JSON.stringify({
    email: teacherEmail,
    password: "teacher123",
    confirmPassword: "teacher123",
    name: "E2E Teacher",
    studentNo: `T${suffix}`,
    inviteCode: level1Code,
  }),
});
assert.equal(teacher.user.role, "teacher");
const teacherProfiles = await request("/ai/profiles", { token: teacher.token });
assert.equal(teacherProfiles.profiles.length, 1);
assert.equal(teacherProfiles.profiles[0].selected, true);
const usersAfterTeacherRegistration = await request("/admin/users", { token: admin.token });
assert.equal(
  usersAfterTeacherRegistration.users.find((user) => user.id === teacher.user.id)?.studentNo,
  `T${suffix}`,
);

await request("/auth/register", {
  method: "POST",
  expected: 400,
  body: JSON.stringify({
    email: `other-${teacherEmail}`,
    password: "teacher123",
    confirmPassword: "teacher123",
    name: "Other Teacher",
    studentNo: `T${suffix}B`,
    inviteCode: level1Code,
  }),
});

const classOne = (await request("/teacher/classes", {
  method: "POST",
  token: teacher.token,
  expected: 201,
  body: JSON.stringify({ courseName, className: `E2E Class One ${suffix}`, capacity: 20 }),
})).class;
const classTwo = (await request("/teacher/classes", {
  method: "POST",
  token: teacher.token,
  expected: 201,
  body: JSON.stringify({ courseName, className: `E2E Class Two ${suffix}`, capacity: 20 }),
})).class;
assert.equal(classOne.code, `${level1Code}-001`);
assert.equal(classTwo.code, `${level1Code}-002`);

async function registerStudent(inviteCode, name, studentNo, email = sharedStudentEmail) {
  return request("/auth/register", {
    method: "POST",
    expected: 201,
    body: JSON.stringify({
      email,
      password: "student123",
      confirmPassword: "student123",
      name,
      studentNo,
      inviteCode,
    }),
  });
}

const studentOne = await registerStudent(classOne.code, "Student One", "E2E1001");
const removableStudent = await registerStudent(
  classOne.code,
  "Removable Student",
  "E2E1002",
  `removable-${suffix}@example.com`,
);

const classOneLogin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: sharedStudentEmail, password: "student123" }),
});
assert.equal(classOneLogin.user.id, studentOne.user.id);
const initialStudentClasses = await request("/student/classes", { token: classOneLogin.token });
assert.deepEqual(initialStudentClasses.classes.map((item) => item.inviteCode), [classOne.code]);
assert.equal(initialStudentClasses.classes[0].isCurrent, true);
await request("/student/classes", {
  method: "POST",
  token: classOneLogin.token,
  expected: 400,
  body: JSON.stringify({ inviteCode: level1Code }),
});
const firstJoin = await request("/student/classes", {
  method: "POST",
  token: classOneLogin.token,
  expected: 201,
  body: JSON.stringify({ inviteCode: classTwo.code }),
});
await request("/student/classes", {
  method: "POST",
  token: classOneLogin.token,
  expected: 409,
  body: JSON.stringify({ inviteCode: classTwo.code }),
});
let joinedClasses = await request("/student/classes", { token: classOneLogin.token });
assert.deepEqual(joinedClasses.classes.map((item) => item.inviteCode), [classOne.code, classTwo.code]);
await request(`/student/classes/${firstJoin.class.accountId}`, {
  method: "DELETE",
  token: classOneLogin.token,
});
joinedClasses = await request("/student/classes", { token: classOneLogin.token });
assert.deepEqual(joinedClasses.classes.map((item) => item.inviteCode), [classOne.code]);
const secondJoin = await request("/student/classes", {
  method: "POST",
  token: classOneLogin.token,
  expected: 201,
  body: JSON.stringify({ inviteCode: classTwo.code }),
});
const classOneWorkspace = await request("/workspace/initialize", {
  method: "POST",
  token: classOneLogin.token,
  expected: 201,
});
const switchedClass = await request(`/student/classes/${secondJoin.class.accountId}/select`, {
  method: "POST",
  token: classOneLogin.token,
});
assert.equal(switchedClass.user.id, secondJoin.class.accountId);
await request(`/student/classes/${removableStudent.user.id}/select`, {
  method: "POST",
  token: classOneLogin.token,
  expected: 404,
});
const switchedClasses = await request("/student/classes", { token: switchedClass.token });
assert.equal(
  switchedClasses.classes.find((item) => item.accountId === secondJoin.class.accountId)?.isCurrent,
  true,
);
const classTwoBeforeInitialize = await request("/workspace/status", { token: switchedClass.token });
assert.equal(classTwoBeforeInitialize.workspace.status, "not_created");
const classTwoWorkspace = await request("/workspace/initialize", {
  method: "POST",
  token: switchedClass.token,
  expected: 201,
});
assert.notEqual(classOneWorkspace.workspace.id, classTwoWorkspace.workspace.id);
const originalWorkspace = await request("/workspace/status", { token: classOneLogin.token });
assert.equal(originalWorkspace.workspace.id, classOneWorkspace.workspace.id);
const studentTwo = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({
    email: sharedStudentEmail,
    password: "student123",
    accountId: secondJoin.class.accountId,
  }),
});
assert.notEqual(studentOne.user.id, studentTwo.user.id);

await request("/ai/profiles", { token: admin.token, expected: 403 });
const initialProfiles = await request("/ai/profiles", { token: classOneLogin.token });
assert.equal(initialProfiles.profiles.length, 1);
assert.equal(initialProfiles.profiles[0].selected, true);
const customProfile = (await request("/ai/profiles", {
  method: "POST",
  token: classOneLogin.token,
  expected: 201,
  body: JSON.stringify({
    name: "E2E Provider",
    baseUrl: "https://provider.example.com/v1",
    apiKey: "e2e-secret-key",
    model: "e2e-model-v1",
    level: "high",
  }),
})).profile;
assert.equal(customProfile.selected, false);
await request(`/ai/profiles/${customProfile.id}/select`, {
  method: "POST",
  token: teacher.token,
  expected: 404,
});
const profilesFromSecondClass = await request("/ai/profiles", { token: studentTwo.token });
assert.equal(profilesFromSecondClass.profiles.some((profile) => profile.id === customProfile.id), true);
await request(`/ai/profiles/${customProfile.id}/select`, { method: "POST", token: studentTwo.token });
const selectedSettingsFromFirstClass = await request("/ai/settings", { token: classOneLogin.token });
assert.equal(selectedSettingsFromFirstClass.settings.model, "e2e-model-v1");
await request(`/ai/profiles/${customProfile.id}`, {
  method: "PUT",
  token: classOneLogin.token,
  body: JSON.stringify({
    name: "E2E Provider Updated",
    baseUrl: "https://provider.example.com/v1",
    model: "e2e-model-v2",
    level: "low",
  }),
});
const updatedProfilesFromSecondClass = await request("/ai/profiles", { token: studentTwo.token });
assert.equal(
  updatedProfilesFromSecondClass.profiles.find((profile) => profile.id === customProfile.id)?.model,
  "e2e-model-v2",
);
const selfLeavingStudent = await registerStudent(
  classOne.code,
  "Self Leaving Student",
  "E2E1003",
  `self-leaving-${suffix}@example.com`,
);
const selfLeave = await request(`/student/classes/${selfLeavingStudent.user.id}`, {
  method: "DELETE",
  token: selfLeavingStudent.token,
});
assert.equal(selfLeave.currentAccountDeleted, true);
await request("/student/classes", { token: selfLeavingStudent.token, expected: 404 });

const automaticClassLogin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: sharedStudentEmail, password: "student123" }),
});
assert.equal(automaticClassLogin.user.id, studentTwo.user.id);
assert.equal(automaticClassLogin.user.className, classTwo.className);
await request("/auth/logout", { method: "POST", token: automaticClassLogin.token, expected: 204 });
const loginAfterLogout = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: sharedStudentEmail, password: "student123" }),
});
assert.equal(loginAfterLogout.user.id, studentTwo.user.id);

await request("/teacher/classes", { token: classOneLogin.token, expected: 403 });
await request("/student/classes", { token: teacher.token, expected: 403 });
const teacherClasses = await request("/teacher/classes", { token: teacher.token });
assert.deepEqual(teacherClasses.classes.map((item) => item.code), [classOne.code, classTwo.code]);

await request(`/teacher/classes/${classOne.id}/members/${studentOne.user.id}/role`, {
  method: "PATCH",
  token: teacher.token,
  body: JSON.stringify({ role: "ta" }),
});
const ta = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: sharedStudentEmail, password: "student123", accountId: studentOne.user.id }),
});
assert.equal(ta.user.role, "ta");
const taProfiles = await request("/ai/profiles", { token: ta.token });
assert.equal(taProfiles.profiles.some((profile) => profile.id === customProfile.id), true);
await request("/teacher/class-progress", { token: ta.token });
await request(`/teacher/classes/${classOne.id}/members`, { token: ta.token });
await request(`/teacher/classes/${classOne.id}/members/${removableStudent.user.id}/role`, {
  method: "PATCH",
  token: ta.token,
  expected: 403,
  body: JSON.stringify({ role: "ta" }),
});
await request(`/teacher/classes/${classOne.id}/members/${removableStudent.user.id}`, {
  method: "DELETE",
  token: ta.token,
});

const studentSso = await request("/homeworks/sso-token", { token: studentTwo.token });
const teacherSso = await request("/homeworks/sso-token", { token: teacher.token });
const taSso = await request("/homeworks/sso-token", { token: ta.token });
assert.match(studentSso.url, /\/homeworks\/sso\?token=/);
assert.match(teacherSso.url, /\/homeworks\/sso\?token=/);
const studentHomeworks = await openHomeworksSession(studentSso.url);
const teacherHomeworks = await openHomeworksSession(teacherSso.url);
assert.match(studentHomeworks.html, /学生首页/);
assert.equal(studentHomeworks.html.includes(classTwo.className), true);
await testDirectHomeworksLogin(sharedStudentEmail, "student123", classTwo.className);
const taHomeworks = await openHomeworksSession(taSso.url);
assert.match(teacherHomeworks.html, /教师控制台/);
assert.match(taHomeworks.html, /助教/);
const teacherAssignmentPage = await fetch(new URL("/homeworks/teacher/assignments/new", serviceOrigin), {
  headers: { Cookie: teacherHomeworks.cookie },
});
const studentAssignmentPage = await fetch(new URL("/homeworks/teacher/assignments/new", serviceOrigin), {
  headers: { Cookie: studentHomeworks.cookie },
});
assert.equal(teacherAssignmentPage.status, 200);
assert.equal(studentAssignmentPage.status, 403);

const classTwoDeletion = await request(`/admin/invite-codes/${classTwo.id}`, {
  method: "DELETE",
  token: admin.token,
});
assert.equal(classTwoDeletion.deletedUsers, 1);
assert.match(classTwoDeletion.archiveDirectory, /archive-data/);
const survivingStudent = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: sharedStudentEmail, password: "student123" }),
});
assert.equal(survivingStudent.user.id, studentOne.user.id);
const profilesAfterClassDeletion = await request("/ai/profiles", { token: survivingStudent.token });
assert.equal(profilesAfterClassDeletion.profiles.some((profile) => profile.id === customProfile.id), true);
await request(`/ai/profiles/${customProfile.id}`, { method: "DELETE", token: survivingStudent.token });
const profilesAfterSelectedDeletion = await request("/ai/profiles", { token: survivingStudent.token });
assert.equal(profilesAfterSelectedDeletion.profiles.length, 1);
assert.equal(profilesAfterSelectedDeletion.profiles[0].selected, true);
const survivingTeacher = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: teacherEmail, password: "teacher123" }),
});
assert.equal(survivingTeacher.user.id, teacher.user.id);

const invites = await request("/admin/invite-codes", { token: admin.token });
const parent = invites.inviteCodes.find((item) => item.code === level1Code);
assert(parent);
assert.equal(parent.level, "level_1");
assert.equal(parent.relatedUserCount, 2);

const deletion = await request(`/admin/invite-codes/${parent.id}`, {
  method: "DELETE",
  token: admin.token,
});
assert.equal(deletion.deletedUsers, 2);
assert.match(deletion.archiveDirectory, /archive-data/);

const after = await request("/admin/invite-codes", { token: admin.token });
assert.equal(after.inviteCodes.some((item) => item.code.startsWith(level1Code)), false);

console.log(JSON.stringify({
  ok: true,
  level1Code,
  classCodes: [classOne.code, classTwo.code],
  tested: [
    "single-use teacher invitation",
    "required teacher employee number and persistence",
    "automatic sequential class invitations",
    "same-email multi-class student accounts",
    "global AI Provider Profile CRUD and cross-class selection",
    "teacher and TA access to global AI Provider Profiles",
    "cross-user AI Provider Profile access denial",
    "super administrator exclusion from personal AI Provider Profiles",
    "student class listing, joining, duplicate rejection, leaving, and rejoining",
    "current-class switching across Homeworks and independent Courseworks workspaces",
    "current-class departure invalidates the deleted account token",
    "automatic restoration of the most recently used class after logout",
    "Homeworks direct login restoration without invitation codes",
    "teacher promotion to TA",
    "TA read/delete permissions and promotion denial",
    "Homeworks SSO",
    "Homeworks teacher/student/TA route permissions",
    "single-class deletion preserves the teacher and the student's other class account",
    "recursive invitation archive and deletion",
  ],
}, null, 2));
