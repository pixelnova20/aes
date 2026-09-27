"""Server-side bridge from Homeworks questions to the global AI provider."""
import json
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import jwt


class AiTutorError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def build_question_context(assignment, question):
    lines = [
        f"课程：{assignment.course.name}",
        f"作业：{assignment.title}",
        f"章节：第{assignment.chapter.chapter_number}章 {assignment.chapter.title or ''}".strip(),
        f"题号：{question.question_number}",
        f"题型：{question.type_label}",
        "题目：",
        question.stem_markdown.strip(),
    ]
    if question.snapshot_options:
        lines.extend(
            f"{option.label}. {option.content_markdown.strip()}"
            for option in question.snapshot_options
        )
    return "\n".join(lines)


def build_review_context(question, answer, grade):
    if answer is None:
        student_answer = "（未作答）"
        grader_comment = "（未提供）"
    else:
        student_answer = (
            answer.choice_answer
            if question.type == "choice"
            else answer.text_answer
        ) or "（未作答）"
        grader_comment = answer.grader_comment or "（未提供）"

    score = f"{grade.score:g}" if grade.score is not None else "（未提供）"
    overall_comment = grade.comment or "（未提供）"
    return "\n".join([
        f"学生本题作答：{student_answer}",
        f"教师本题批注：{grader_comment}",
        f"本次作业总分：{score}",
        f"教师总体评价：{overall_comment}",
    ])[:30_000]


def _ai_tutor_request(
    config,
    user,
    assignment,
    question,
    prompt,
    history,
    suffix="",
    review_context=None,
):
    if not user.external_id:
        raise AiTutorError("当前账号缺少统一身份信息，请重新登录服务门户。", 400)

    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "sub": user.external_id,
            "role": "student",
            "email": user.email,
            "purpose": "homeworks_ai_tutor",
            "homeworkTutorMode": "review" if review_context is not None else "guidance",
            "iat": now,
            "exp": now + timedelta(seconds=60),
        },
        config["SSO_JWT_SECRET"],
        algorithm="HS256",
    )
    payload = json.dumps(
        {
            "questionContext": build_question_context(assignment, question),
            **({"reviewContext": review_context} if review_context is not None else {}),
            "prompt": prompt,
            "history": history,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    endpoint = (
        config["COURSEWORKS_INTERNAL_API_URL"].rstrip("/")
        + "/ai/homework-tutor"
        + suffix
    )
    return Request(
        endpoint,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )


def _open_ai_tutor_request(ai_request):
    try:
        return urlopen(ai_request, timeout=70)
    except HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8"))
            message = result.get("message")
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = None
        raise AiTutorError(message or "AI 服务暂时无法完成请求。", error.code) from error
    except (URLError, TimeoutError) as error:
        raise AiTutorError("无法连接 AI 服务，请稍后重试。") from error


def ask_ai_tutor(
    config, user, assignment, question, prompt, history, review_context=None
):
    ai_request = _ai_tutor_request(
        config,
        user,
        assignment,
        question,
        prompt,
        history,
        review_context=review_context,
    )

    try:
        with _open_ai_tutor_request(ai_request) as response:
            result = json.loads(response.read().decode("utf-8"))
    except json.JSONDecodeError as error:
        raise AiTutorError("AI 服务返回了无效内容。") from error

    answer = result.get("answer") if isinstance(result, dict) else None
    if not isinstance(answer, str) or not answer.strip():
        raise AiTutorError("AI 服务没有返回有效内容。")
    return answer.strip()


def open_ai_tutor_stream(
    config, user, assignment, question, prompt, history, review_context=None
):
    ai_request = _ai_tutor_request(
        config,
        user,
        assignment,
        question,
        prompt,
        history,
        "/stream",
        review_context=review_context,
    )
    return _open_ai_tutor_request(ai_request)
