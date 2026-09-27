"""Question-bank markdown parser and HTML renderer.

Parses chapter markdown files that follow the ``course1-os`` format into
choice / blank / comprehensive questions, and converts each question's
markdown stem into HTML (with relative image references rewritten to the
protected chapter-image endpoint).
"""
import os
import re
import shutil
from urllib.parse import quote

import markdown as md

from .database import db_session
from .models import Question, QuestionOption

H1_RE = re.compile(r"^#\s+(.*?)\s*$")
H2_RE = re.compile(r"^##\s+(.*?)\s*$")
NUMBER_RE = re.compile(r"^(\d+)\.\s*(.*)$")
OPTION_RE = re.compile(r"^([A-D])\.\s*(.*)$")
IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
IMAGE_HTML_RE = re.compile(r'<img[^>]+src=["\']([^"\']+)["\']')
SRC_RE = re.compile(r'src=["\']([^"\']+)["\']')

_SECTION_KEYWORDS = {
    "choice": ("选择", "单选", "choice", "选择题"),
    "blank": ("填空", "blank", "填空题"),
    "short_answer": ("简答", "short answer", "short_answer"),
    "comprehensive": ("综合", "解答", "comprehensive"),
}

_ABSOLUTE_PREFIXES = ("http://", "https://", "data:", "//", "#", "/")


def classify_section(header):
    text = header.strip()
    for qtype, keywords in _SECTION_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                return qtype
    return None


def _split_questions(lines):
    questions = []
    cur_num = None
    cur_lines = []
    for ln in lines:
        m = NUMBER_RE.match(ln)
        if m:
            if cur_num is not None:
                questions.append((cur_num, cur_lines))
            cur_num = int(m.group(1))
            cur_lines = [m.group(2)]
        else:
            if cur_num is not None:
                cur_lines.append(ln)
    if cur_num is not None:
        questions.append((cur_num, cur_lines))
    return questions


def _split_stem_options(lines):
    stem = []
    i = 0
    while i < len(lines):
        if OPTION_RE.match(lines[i]):
            break
        stem.append(lines[i])
        i += 1

    options = []
    cur = None
    for j in range(i, len(lines)):
        m = OPTION_RE.match(lines[j])
        if m:
            if cur is not None:
                options.append(cur)
            cur = {"label": m.group(1), "lines": [m.group(2)]}
        else:
            if cur is not None:
                cur["lines"].append(lines[j])
    if cur is not None:
        options.append(cur)
    return stem, options


def parse_markdown(text):
    lines = text.splitlines()

    title = None
    for ln in lines:
        m = H1_RE.match(ln)
        if m:
            title = m.group(1).strip()
            break

    sections = []
    current = None
    for ln in lines:
        m = H2_RE.match(ln)
        if m:
            qtype = classify_section(m.group(1))
            if current is not None:
                sections.append(current)
            current = (qtype, [])
        else:
            if current is not None:
                current[1].append(ln)
    if current is not None:
        sections.append(current)

    questions = []
    for qtype, body in sections:
        if qtype is None:
            continue
        for num, qlines in _split_questions(body):
            questions.append((qtype, num, qlines))
    return title, questions


def render_markdown(text, chapter_id=None):
    if not text:
        return ""
    html = md.markdown(text, extensions=["tables", "fenced_code"], output_format="html")
    if chapter_id is not None:
        html = _rewrite_image_srcs(html, chapter_id)
    return html


def _rewrite_image_srcs(html, chapter_id):
    def repl(m):
        return f'src="{chapter_image_url(chapter_id, m.group(1))}"'

    return SRC_RE.sub(repl, html)


def chapter_image_url(chapter_id, relpath):
    if relpath.startswith(_ABSOLUTE_PREFIXES):
        return relpath
    encoded = quote(relpath, safe="/")
    return f"/chapter-images/{chapter_id}/{encoded}"


def extract_image_relpaths(md_text):
    seen = []
    for m in IMAGE_MD_RE.finditer(md_text):
        _append_rel(seen, m.group(1))
    for m in IMAGE_HTML_RE.finditer(md_text):
        _append_rel(seen, m.group(1))
    return seen


def _append_rel(seen, path):
    path = (path or "").strip()
    if not path or path.startswith(_ABSOLUTE_PREFIXES):
        return
    if path not in seen:
        seen.append(path)


def ingest_referenced_images(md_text, source_root, dest_root):
    copied = 0
    for rel in extract_image_relpaths(md_text):
        src = os.path.join(source_root, rel)
        if not os.path.isfile(src):
            continue
        dest = os.path.join(dest_root, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not os.path.exists(dest):
            shutil.copyfile(src, dest)
            copied += 1
    return copied


def delete_chapter_questions(chapter_id):
    """Remove a chapter's questions.

    AssignmentQuestion records that reference these questions are NOT
    deleted — they carry their own snapshot data so published assignments
    survive re-upload.
    """
    questions = db_session.query(Question).filter_by(chapter_id=chapter_id).all()
    for q in questions:
        db_session.delete(q)
    db_session.commit()


def import_chapter_questions(chapter_id, md_text):
    delete_chapter_questions(chapter_id)

    title, questions = parse_markdown(md_text)
    for qtype, num, lines in questions:
        q = Question(
            chapter_id=chapter_id,
            question_number=num,
            type=qtype,
            stem_markdown="",
            stem_html="",
        )
        if qtype == "choice":
            stem_lines, options = _split_stem_options(lines)
            q.stem_markdown = "\n".join(stem_lines).strip()
            q.stem_html = render_markdown(q.stem_markdown, chapter_id)
            db_session.add(q)
            db_session.flush()
            for idx, opt in enumerate(options):
                content_md = "\n".join(opt["lines"]).strip()
                db_session.add(
                    QuestionOption(
                        question_id=q.id,
                        label=opt["label"],
                        content_markdown=content_md,
                        content_html=render_markdown(content_md, chapter_id),
                        sort_order=idx,
                    )
                )
        else:
            q.stem_markdown = "\n".join(lines).strip()
            q.stem_html = render_markdown(q.stem_markdown, chapter_id)
            db_session.add(q)

    db_session.commit()
    return len(questions), title
