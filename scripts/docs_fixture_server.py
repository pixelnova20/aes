#!/usr/bin/env python3
"""Run an AES subsystem with isolated, synthetic documentation data."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_homeworks(data_root: Path, port: int) -> None:
    sys.path.insert(0, str(ROOT / "homeworks"))

    from config import Config
    from app import create_app
    from app.database import db_session
    from app.models import (
        Answer,
        Assignment,
        AssignmentQuestion,
        AssignmentQuestionOption,
        Chapter,
        Class,
        Course,
        Grade,
        Question,
        QuestionOption,
        Submission,
        User,
        UserClassRole,
    )
    from flask import redirect, session

    class DocsConfig(Config):
        TESTING = False
        SECRET_KEY = "docs-homeworks-session-only"
        APPLICATION_ROOT = "/"
        SESSION_COOKIE_PATH = "/"
        ACCOUNT_DATABASE = str(data_root / "homeworks-accounts.db")
        COURSE_DATABASE = str(data_root / "homeworks-courses.db")
        UPLOAD_DIR = str(data_root / "homeworks-uploads")
        CHAPTER_UPLOAD_DIR = str(data_root / "homeworks-uploads" / "chapters")
        ANSWER_UPLOAD_DIR = str(data_root / "homeworks-uploads" / "answers")
        SERVICE_PORTAL_URL = "/portal"

    app = create_app(DocsConfig)

    def add_choice(chapter, number, stem, options):
        question = Question(
            chapter_id=chapter.id,
            question_number=number,
            type="choice",
            stem_markdown=stem,
            stem_html=f"<p>{stem}</p>",
            score=10,
        )
        db_session.add(question)
        db_session.flush()
        for index, (label, content) in enumerate(options):
            db_session.add(QuestionOption(
                question_id=question.id,
                label=label,
                content_markdown=content,
                content_html=f"<p>{content}</p>",
                sort_order=index,
            ))
        return question

    def snapshot(assignment, question, sort_order):
        item = AssignmentQuestion(
            assignment_id=assignment.id,
            question_id=question.id,
            sort_order=sort_order,
            score=question.score,
            question_number=question.question_number,
            type=question.type,
            stem_markdown=question.stem_markdown,
            stem_html=question.stem_html,
        )
        db_session.add(item)
        db_session.flush()
        for option in question.options:
            db_session.add(AssignmentQuestionOption(
                assignment_question_id=item.id,
                label=option.label,
                content_markdown=option.content_markdown,
                content_html=option.content_html,
                sort_order=option.sort_order,
            ))
        return item

    with app.app_context():
        course = Course(
            name="操作系统原理",
            description="文档截图使用的虚构课程",
            owner_external_id="docs-teacher",
        )
        db_session.add(course)
        db_session.flush()
        klass = Class(
            name="操作系统实验班",
            course_id=course.id,
            capacity=40,
            current_count=3,
            enabled=True,
        )
        chapter = Chapter(
            course_id=course.id,
            chapter_number=2,
            title="进程与线程",
            parse_status="parsed",
        )
        db_session.add_all([klass, chapter])
        db_session.flush()

        teacher = User(
            external_id="docs-teacher",
            email="teacher@example.edu",
            password_hash="not-used",
            name="陈老师",
            role="teacher",
            student_no="T2026001",
            course_name=course.name,
            class_id=klass.id,
            enabled=True,
        )
        student = User(
            external_id="docs-student",
            email="student@example.edu",
            password_hash="not-used",
            name="林同学",
            role="student",
            student_no="S20260001",
            course_name=course.name,
            class_id=klass.id,
            enabled=True,
        )
        db_session.add_all([teacher, student])
        db_session.flush()
        db_session.add_all([
            UserClassRole(user_id=teacher.id, class_id=klass.id, role_in_class="teacher"),
            UserClassRole(user_id=student.id, class_id=klass.id, role_in_class="student"),
        ])

        q1 = add_choice(chapter, 1, "时间片轮转调度中，一个进程的时间片用完后通常会进入哪个队列？", [
            ("A", "等待队列"),
            ("B", "就绪队列末尾"),
            ("C", "空闲队列"),
            ("D", "挂起队列"),
        ])
        q2 = add_choice(chapter, 2, "用于实现进程互斥、且操作具有原子性的同步机制是（ ）。", [
            ("A", "缓存"),
            ("B", "信号量"),
            ("C", "页表"),
            ("D", "目录项"),
        ])
        db_session.flush()

        grading_assignment = Assignment(
            title="进程与线程练习",
            course_id=course.id,
            chapter_id=chapter.id,
            class_id=klass.id,
            publisher_id=teacher.id,
            description="理解调度与同步的基本概念。",
            due_at=datetime.now() + timedelta(days=5),
            status="published",
            published_at=datetime.now() - timedelta(days=2),
        )
        graded_assignment = Assignment(
            title="操作系统概述",
            course_id=course.id,
            chapter_id=chapter.id,
            class_id=klass.id,
            publisher_id=teacher.id,
            due_at=datetime.now() + timedelta(days=3),
            status="published",
            published_at=datetime.now() - timedelta(days=7),
        )
        todo_assignment = Assignment(
            title="同步与互斥预习",
            course_id=course.id,
            chapter_id=chapter.id,
            class_id=klass.id,
            publisher_id=teacher.id,
            due_at=datetime.now() + timedelta(days=9),
            status="published",
            published_at=datetime.now() - timedelta(hours=4),
        )
        db_session.add_all([grading_assignment, graded_assignment, todo_assignment])
        db_session.flush()

        aq1 = snapshot(grading_assignment, q1, 0)
        aq2 = snapshot(grading_assignment, q2, 1)
        snapshot(graded_assignment, q1, 0)
        snapshot(todo_assignment, q2, 0)
        db_session.flush()

        submitted = Submission(
            assignment_id=grading_assignment.id,
            student_id=student.id,
            status="submitted",
            first_saved_at=datetime.now() - timedelta(days=1),
            submitted_at=datetime.now() - timedelta(hours=6),
        )
        graded = Submission(
            assignment_id=graded_assignment.id,
            student_id=student.id,
            status="graded",
            first_saved_at=datetime.now() - timedelta(days=6),
            submitted_at=datetime.now() - timedelta(days=5),
        )
        db_session.add_all([submitted, graded])
        db_session.flush()
        db_session.add_all([
            Answer(
                submission_id=submitted.id,
                assignment_question_id=aq1.id,
                choice_answer="D",
                grader_comment="请注意：时间片结束后，进程会回到就绪队列末尾。",
            ),
            Answer(
                submission_id=submitted.id,
                assignment_question_id=aq2.id,
                choice_answer="B",
                grader_comment="同步原语的操作必须具有原子性。",
            ),
            Grade(
                submission_id=graded.id,
                grader_id=teacher.id,
                score=92,
                comment="概念掌握扎实，继续保持。",
                status="submitted",
                graded_at=datetime.now() - timedelta(days=4),
            ),
        ])
        db_session.commit()
        teacher_id = teacher.id
        student_id = student.id
        grading_assignment_id = grading_assignment.id
        todo_assignment_id = todo_assignment.id

    @app.get("/__docs/login/<role>")
    def docs_login(role):
        session.clear()
        session["_csrf_token"] = "docs-only-csrf"
        session["user_id"] = teacher_id if role == "teacher" else student_id
        if role == "teacher":
            return redirect(f"/teacher/assignments/{grading_assignment_id}/grade/{student_id}")
        if role == "student-ai":
            return redirect(f"/student/assignments/{todo_assignment_id}")
        return redirect("/student/")

    app.run(host="127.0.0.1", port=port, use_reloader=False)


def run_slideshow(data_root: Path, port: int) -> None:
    sys.path.insert(0, str(ROOT / "slideshow"))

    from PIL import Image, ImageDraw, ImageFont
    from config import Config
    from slideshow_app import create_app
    from flask import redirect, session

    accounts_db = data_root / "slideshow-accounts.db"
    courses_db = data_root / "slideshow-courses.db"
    presentation_db = data_root / "slideshow.db"
    upload_dir = data_root / "slideshow-uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(accounts_db) as database:
        database.executescript("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, external_id TEXT, email TEXT,
                class_id INTEGER, enabled INTEGER
            );
            INSERT INTO users VALUES (1, 'docs-teacher', 'teacher@example.edu', 10, 1);
            INSERT INTO users VALUES (2, 'docs-student', 'student@example.edu', 10, 1);
        """)
    with sqlite3.connect(courses_db) as database:
        database.executescript("""
            CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT, owner_external_id TEXT);
            CREATE TABLE classes (id INTEGER PRIMARY KEY, name TEXT, course_id INTEGER, enabled INTEGER);
            INSERT INTO courses VALUES (1, '操作系统原理', 'docs-teacher');
            INSERT INTO classes VALUES (10, '操作系统实验班', 1, 1);
        """)

    class DocsConfig(Config):
        TESTING = False
        SECRET_KEY = "docs-slideshow-session-only"
        APPLICATION_ROOT = "/"
        SESSION_COOKIE_PATH = "/"
        DATABASE = str(presentation_db)
        ACCOUNT_DATABASE = str(accounts_db)
        COURSE_DATABASE = str(courses_db)
        UPLOAD_DIR = str(upload_dir)
        SERVICE_PORTAL_URL = "/portal"

    app = create_app(DocsConfig)

    font_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
    bold_path = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
    if not Path(font_path).exists():
        font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        bold_path = font_path

    decks = [
        ("processes", "进程与线程", "第 2 章", "进程状态、调度与线程模型", (28, 78, 121), (76, 175, 155), 36),
        ("memory", "虚拟内存", "第 4 章", "分页、页面置换与地址转换", (57, 91, 129), (226, 171, 68), 42),
        ("filesystem", "文件系统", "第 6 章", "文件组织、目录与磁盘空间管理", (49, 97, 83), (68, 132, 181), 30),
    ]
    created_at = "2026-09-20T08:30:00+00:00"

    with sqlite3.connect(presentation_db) as database:
        for deck_id, title, chapter, subtitle, top, accent, pages in decks:
            slides_dir = upload_dir / "presentations" / deck_id / "slides"
            slides_dir.mkdir(parents=True, exist_ok=True)
            image_path = slides_dir / "001.png"
            image = Image.new("RGB", (1200, 675), (245, 247, 249))
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 0, 1200, 210), fill=top)
            draw.rectangle((0, 210, 1200, 224), fill=accent)
            draw.rectangle((70, 285, 1130, 590), fill=(255, 255, 255), outline=(213, 220, 226), width=2)
            title_font = ImageFont.truetype(bold_path, 58)
            chapter_font = ImageFont.truetype(bold_path, 32)
            body_font = ImageFont.truetype(font_path, 29)
            small_font = ImageFont.truetype(font_path, 20)
            draw.text((72, 58), "AES · OPERATING SYSTEMS", font=small_font, fill=(220, 235, 240))
            draw.text((72, 105), title, font=title_font, fill=(255, 255, 255))
            draw.text((112, 335), chapter, font=chapter_font, fill=top)
            draw.text((112, 405), subtitle, font=body_font, fill=(42, 54, 67))
            draw.line((112, 475, 500, 475), fill=accent, width=8)
            draw.text((112, 515), "操作系统原理 · 教学演示", font=small_font, fill=(100, 112, 124))
            image.save(image_path)
            database.execute(
                """
                INSERT INTO presentations (
                    id, title, original_filename, owner_external_id, class_id,
                    class_name, course_name, content_sha256, slide_count,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, 'docs-teacher', 10, '操作系统实验班',
                          '操作系统原理', ?, ?, 'ready', ?, ?)
                """,
                (deck_id, title, f"{chapter}-{title}.pptx", f"docs-{deck_id}", pages, created_at, created_at),
            )
            database.execute(
                """
                INSERT INTO slides (presentation_id, slide_index, image_filename, extracted_text)
                VALUES (?, 0, '001.png', ?)
                """,
                (deck_id, subtitle),
            )
        database.commit()

    @app.get("/__docs/login")
    def docs_login():
        session.clear()
        session["_csrf_token"] = "docs-only-csrf"
        session["slideshow_user"] = {
            "external_id": "docs-teacher",
            "email": "teacher@example.edu",
            "name": "陈老师",
            "role": "teacher",
            "class_id": 10,
            "class_name": "操作系统实验班",
            "course_name": "操作系统原理",
        }
        return redirect("/")

    @app.get("/__docs/login/student-ai")
    def docs_student_ai_login():
        session.clear()
        session["_csrf_token"] = "docs-only-csrf"
        session["slideshow_user"] = {
            "external_id": "docs-student",
            "email": "student@example.edu",
            "name": "林同学",
            "role": "student",
            "class_id": 10,
            "class_name": "操作系统实验班",
            "course_name": "操作系统原理",
        }
        return redirect("/presentations/processes")

    app.run(host="127.0.0.1", port=port, use_reloader=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("app", choices=("homeworks", "slideshow"))
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    args.data_root.mkdir(parents=True, exist_ok=True)
    if args.app == "homeworks":
        run_homeworks(args.data_root, args.port)
    else:
        run_slideshow(args.data_root, args.port)


if __name__ == "__main__":
    main()
