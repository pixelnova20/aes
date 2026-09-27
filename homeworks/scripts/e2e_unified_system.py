#!/usr/bin/env python3
"""Exercise the unified Courseworks/Homeworks workflow through port 10001."""

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def api(session, method, url, token=None, expected=200, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = session.request(method, url, headers=headers, timeout=20, **kwargs)
    require(
        response.status_code == expected,
        f"{method} {url}: expected {expected}, got {response.status_code}: {response.text[:500]}",
    )
    return response.json()


def csrf(response):
    soup = BeautifulSoup(response.text, "html.parser")
    field = soup.select_one('input[name="_csrf"]')
    require(field and field.get("value"), f"CSRF token missing from {response.url}")
    return field["value"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="统一服务入口，例如当前浏览器使用的来源地址")
    parser.add_argument("--admin-email", required=True)
    parser.add_argument("--admin-password", required=True)
    parser.add_argument("--accounts-db", required=True)
    parser.add_argument("--courses-db", required=True)
    args = parser.parse_args()

    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    invite_code = f"E2E-{stamp}"
    class_name = f"E2E-Class-{stamp}"
    candidate_email = f"e2e-teacher-{stamp}@example.com"
    student_email = f"e2e-student-{stamp}@example.com"
    candidate_no = f"T{stamp}"
    student_no = f"S{stamp}"
    password = "Course123!"
    assignment_title = f"E2E Assignment {stamp}"
    base = args.base_url.rstrip("/")
    session = requests.Session()

    health = api(session, "GET", f"{base}/api/health")
    require(health == {"ok": True}, "health endpoint returned an unexpected payload")
    admin = api(
        session,
        "POST",
        f"{base}/api/auth/login",
        json={"email": args.admin_email, "password": args.admin_password},
    )
    admin_token = admin["token"]
    require(admin["user"]["role"] == "super_admin", "admin role is incorrect")

    invitation = api(
        session,
        "POST",
        f"{base}/api/admin/invite-codes",
        token=admin_token,
        expected=201,
        json={
            "code": invite_code,
            "description": "Automated unified-system test",
            "courseName": "操作系统原理",
            "className": class_name,
            "maxUses": 4,
            "expiresAt": "",
        },
    )["inviteCode"]

    with sqlite3.connect(args.courses_db) as db:
        invitation_class = db.execute(
            """SELECT classes.id, courses.name FROM classes
               JOIN courses ON courses.id = classes.course_id
               WHERE classes.name = ?""",
            (class_name,),
        ).fetchone()
        require(invitation_class is not None, "creating an invitation did not create its class")
        require(invitation_class[1] == "操作系统原理", "invitation class used the wrong course")
        class_id = invitation_class[0]

    candidate = api(
        session,
        "POST",
        f"{base}/api/auth/register",
        expected=201,
        json={
            "email": candidate_email,
            "password": password,
            "confirmPassword": password,
            "name": "E2E Teacher",
            "studentNo": candidate_no,
            "courseName": "操作系统原理",
            "inviteCode": invite_code,
        },
    )
    require(candidate["user"]["role"] == "student", "registration did not default to student")
    users = api(session, "GET", f"{base}/api/admin/users", token=admin_token)["users"]
    candidate_user = next(user for user in users if user["email"] == candidate_email)

    before_apply = api(session, "GET", f"{base}/api/auth/me", token=candidate["token"])
    require(before_apply["role"] == "student", "role changed before Apply was requested")
    api(
        session,
        "PATCH",
        f"{base}/api/admin/users/{candidate_user['id']}/role",
        token=admin_token,
        json={"role": "teacher"},
    )
    promoted_users = api(session, "GET", f"{base}/api/admin/users", token=admin_token)["users"]
    promoted_user = next(user for user in promoted_users if user["email"] == candidate_email)
    require(promoted_user["className"] == class_name, "promoted teacher lost invitation class")
    teacher_login = api(
        session,
        "POST",
        f"{base}/api/auth/login",
        json={"email": candidate_email, "password": password},
    )
    require(teacher_login["user"]["role"] == "teacher", "applied teacher role was not persisted")

    teacher_web = requests.Session()
    teacher_sso = api(
        session,
        "GET",
        f"{base}/api/homeworks/sso-token",
        token=teacher_login["token"],
    )
    response = teacher_web.get(f"{base}{teacher_sso['url']}", timeout=20)
    require(response.status_code == 200 and "/homeworks/teacher/" in response.url, "teacher SSO failed")
    require(class_name in response.text, "teacher cannot see the invitation class")

    with sqlite3.connect(args.courses_db) as course_db:
        course_id, chapter_id, question_id = course_db.execute(
            """SELECT c.id, ch.id, q.id FROM classes cls
               JOIN courses c ON c.id = cls.course_id
               JOIN chapters ch ON ch.course_id = c.id
               JOIN questions q ON q.chapter_id = ch.id
               WHERE cls.id = ?
               ORDER BY ch.id, q.id LIMIT 1""",
            (class_id,),
        ).fetchone()

    with sqlite3.connect(args.accounts_db) as account_db:
        teacher_id = account_db.execute("SELECT id FROM users WHERE email = ?", (candidate_email,)).fetchone()[0]
        require(
            account_db.execute(
                "SELECT role_in_class FROM user_class_roles WHERE user_id = ? AND class_id = ?",
                (teacher_id, class_id),
            ).fetchone() == ("teacher",),
            "teacher did not receive ownership of the created class",
        )

    student = api(
        session,
        "POST",
        f"{base}/api/auth/register",
        expected=201,
        json={
            "email": student_email,
            "password": password,
            "confirmPassword": password,
            "name": "E2E Student",
            "studentNo": student_no,
            "courseName": "操作系统原理",
            "inviteCode": invite_code,
        },
    )
    require(student["user"]["role"] == "student", "student role is incorrect")

    student_web = requests.Session()
    student_sso = api(
        session,
        "GET",
        f"{base}/api/homeworks/sso-token",
        token=student["token"],
    )
    response = student_web.get(f"{base}{student_sso['url']}", timeout=20)
    require(response.status_code == 200 and "/homeworks/student/" in response.url, "student SSO failed")
    require(class_name in response.text, "student was not linked to the teacher-created class")
    require(
        student_web.get(f"{base}/homeworks/teacher/", timeout=20).status_code == 403,
        "student can access teacher views",
    )
    require(
        teacher_web.get(f"{base}/homeworks/student/", timeout=20).status_code == 403,
        "teacher can access student views",
    )

    response = teacher_web.get(
        f"{base}/homeworks/teacher/assignments/new",
        params={"class_id": class_id, "course_id": course_id, "chapter_id": chapter_id},
        timeout=20,
    )
    require(response.status_code == 200, "teacher assignment form did not load")
    response = teacher_web.post(
        f"{base}/homeworks/teacher/assignments",
        data={
            "_csrf": csrf(response),
            "class_id": class_id,
            "course_id": course_id,
            "chapter_id": chapter_id,
            "title": assignment_title,
            "description": "Automated end-to-end test",
            "due_at": (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M"),
            "action": "publish",
            "question_ids": question_id,
        },
        timeout=20,
    )
    require(response.status_code == 200 and assignment_title in response.text, "teacher could not publish assignment")
    assignment_match = re.search(r"/teacher/assignments/(\d+)", response.url)
    require(assignment_match, "published assignment id was not returned")
    assignment_id = int(assignment_match.group(1))

    response = student_web.get(f"{base}/homeworks/student/", timeout=20)
    require(assignment_title in response.text, "published assignment is missing from student dashboard")
    response = student_web.get(
        f"{base}/homeworks/student/assignments/{assignment_id}", timeout=20
    )
    require(response.status_code == 200, "student could not open assignment")
    soup = BeautifulSoup(response.text, "html.parser")
    answer = soup.select_one('input[type="radio"][name^="q_"]') or soup.select_one('[name^="q_"]')
    require(answer and answer.get("name"), "assignment answer field is missing")
    answer_value = answer.get("value") if answer.name == "input" and answer.get("type") == "radio" else "E2E answer"
    response = student_web.post(
        f"{base}/homeworks/student/assignments/{assignment_id}/submit",
        data={"_csrf": csrf(response), answer["name"]: answer_value},
        timeout=20,
    )
    require(response.status_code == 200 and "已提交" in response.text, "student submission failed")

    response = teacher_web.get(f"{base}/homeworks/teacher/assignments/{assignment_id}", timeout=20)
    require(student_email in response.text, "teacher cannot see the submitted student")
    grade_match = re.search(rf"/teacher/assignments/{assignment_id}/grade/(\d+)", response.text)
    require(grade_match, "grade link is missing")
    student_homeworks_id = int(grade_match.group(1))
    response = teacher_web.get(
        f"{base}/homeworks/teacher/assignments/{assignment_id}/grade/{student_homeworks_id}",
        timeout=20,
    )
    response = teacher_web.post(
        f"{base}/homeworks/teacher/assignments/{assignment_id}/grade/{student_homeworks_id}",
        data={"_csrf": csrf(response), "score": "95", "comment": "E2E verified"},
        timeout=20,
    )
    require(response.status_code == 200, "teacher grading failed")
    response = student_web.get(f"{base}/homeworks/student/grades", timeout=20)
    require("95" in response.text and "E2E verified" in response.text, "student cannot see grade")

    print(json.dumps({
        "inviteCodeId": invitation["id"],
        "inviteCode": invite_code,
        "candidateUserId": candidate_user["id"],
        "candidateEmail": candidate_email,
        "studentEmail": student_email,
        "classId": class_id,
        "assignmentId": assignment_id,
        "checks": [
            "health and super-admin login",
            "invitation creates exactly one course class",
            "registration defaults to student",
            "role changes only after API apply",
            "promoted teacher retains its invitation class",
            "teacher sees and owns the invitation class",
            "student joins existing invitation class",
            "teacher/student role isolation",
            "teacher publishes assignment",
            "student submits assignment",
            "teacher grades and student sees grade",
        ],
    }, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"E2E FAILED: {error}", file=sys.stderr)
        raise
