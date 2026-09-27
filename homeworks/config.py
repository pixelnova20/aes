"""Application configuration.

Database paths default to the shared sibling ``accounts-data`` directory;
uploads and the source question bank stay under the Homeworks project root.
Values may be overridden via environment variables.
"""
import os

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 compatibility
    import tomli as tomllib

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_DIR = os.environ.get(
    "ACCOUNTS_DIR", os.path.join(os.path.dirname(BASE_DIR), "accounts-data")
)
SUPERUSER_CONFIG_PATH = os.environ.get(
    "SUPERUSER_CONFIG_PATH", os.path.join(os.path.dirname(BASE_DIR), "superuser.toml")
)


def _load_superuser_config(path):
    try:
        with open(path, "rb") as config_file:
            data = tomllib.load(config_file)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise RuntimeError(f"无法读取超级用户配置 {path}: {exc}") from exc

    superuser = data.get("superuser")
    if isinstance(superuser, dict):
        email = superuser.get("email")
        password = superuser.get("password")
    else:
        # Compatibility with releases that stored credentials at the TOML root.
        email = superuser
        password = data.get("password")
    if not isinstance(email, str) or "@" not in email or not email.strip():
        raise RuntimeError(f"超级用户配置中的 email 不是有效邮箱: {path}")
    if not isinstance(password, str) or len(password) < 6:
        raise RuntimeError(f"超级用户配置中的 password 至少需要 6 个字符: {path}")
    return {"email": email.strip().lower(), "password": password}


SUPERUSER = _load_superuser_config(SUPERUSER_CONFIG_PATH)


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-change-in-production")
    HOST = os.environ.get("HOST", "0.0.0.0")
    PORT = int(os.environ.get("PORT", "10000"))

    ACCOUNT_DATABASE = os.environ.get(
        "HOMEWORKS_ACCOUNT_DATABASE_PATH", os.path.join(ACCOUNTS_DIR, "accounts.db")
    )
    COURSE_DATABASE = os.environ.get(
        "HOMEWORKS_COURSE_DATABASE_PATH", os.path.join(ACCOUNTS_DIR, "courses.db")
    )
    DATABASE = COURSE_DATABASE

    # Uploaded files (chapter markdown + student photos).
    UPLOAD_DIR = os.environ.get("UPLOAD_DIR", os.path.join(BASE_DIR, "uploads"))
    CHAPTER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "chapters")
    ANSWER_UPLOAD_DIR = os.path.join(UPLOAD_DIR, "answers")

    # The sample question bank shipped with this repository.  Used to
    # auto-ingest the relative images referenced by a chapter markdown file.
    SOURCE_QUESTION_BANK_DIR = os.environ.get(
        "SOURCE_QUESTION_BANK_DIR", os.path.join(BASE_DIR, "course1-os")
    )

    # Session / security.
    PERMANENT_SESSION_LIFETIME = int(os.environ.get("SESSION_LIFETIME", 12 * 3600))
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    APPLICATION_ROOT = os.environ.get("APPLICATION_ROOT", "/homeworks")
    SSO_JWT_SECRET = os.environ.get("JWT_SECRET", "replace-with-a-long-random-secret")
    SUPERUSER_CONFIG_PATH = SUPERUSER_CONFIG_PATH
    SUPERUSER_EMAIL = SUPERUSER["email"]
    SERVICE_PORTAL_URL = os.environ.get("SERVICE_PORTAL_URL", "/portal")
    COURSEWORKS_REGISTER_URL = os.environ.get("COURSEWORKS_REGISTER_URL", "/?register=1")
    COURSEWORKS_INTERNAL_API_URL = os.environ.get(
        "COURSEWORKS_INTERNAL_API_URL", "http://127.0.0.1:3000/api"
    )
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB total request size

    # Student photo upload constraints.
    ALLOWED_ANSWER_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
    MAX_ANSWER_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
    MAX_FILES_PER_ANSWER = 5
