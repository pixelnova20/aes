import json
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import jwt


class SlideAiError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def build_slide_context(presentation, slide):
    text = (slide.get("extracted_text") or "").strip()
    return "\n".join([
        f"课程：{presentation['course_name']}",
        f"班级：{presentation['class_name']}",
        f"演示文稿：{presentation['title']}",
        f"当前页：第 {slide['slide_index'] + 1} 页，共 {presentation['slide_count']} 页",
        "当前页提取文字：",
        text if text else "（这一页没有可提取的文字，可能主要由图片或图表组成。）",
    ])


def _access_token(config, user):
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user["external_id"],
            "role": user["role"],
            "email": user["email"],
            "iat": now,
            "exp": now + timedelta(seconds=90),
        },
        config["SSO_JWT_SECRET"],
        algorithm="HS256",
    )


def open_slide_chat_stream(config, user, presentation, slide, prompt, history):
    if config.get("AI_PROVIDER") == "mock":
        page = slide["slide_index"] + 1
        message = f"已收到你的问题。你正在阅读《{presentation['title']}》第 {page} 页。请先结合页面标题和关键概念说说你的理解。"
        return iter([json.dumps({"delta": message}, ensure_ascii=False) + "\n", '{"done":true}\n'])

    payload = json.dumps(
        {
            "materialContext": build_slide_context(presentation, slide),
            "prompt": prompt,
            "history": history,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    endpoint = config["COURSEWORKS_INTERNAL_API_URL"].rstrip("/") + "/ai/study-tutor/stream"
    request = Request(
        endpoint,
        data=payload,
        headers={
            "Authorization": f"Bearer {_access_token(config, user)}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        return urlopen(request, timeout=70)
    except HTTPError as error:
        try:
            result = json.loads(error.read().decode("utf-8"))
            message = result.get("message")
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = None
        raise SlideAiError(message or "AI 服务暂时无法完成请求。", error.code) from error
    except (URLError, TimeoutError) as error:
        raise SlideAiError("无法连接 AI 服务，请稍后重试。") from error
