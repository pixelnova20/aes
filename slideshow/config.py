import os


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
ACCOUNTS_DIR = os.environ.get(
    "ACCOUNTS_DIR", os.path.join(PROJECT_ROOT, "accounts-data")
)


class Config:
    SECRET_KEY = os.environ.get(
        "SLIDESHOW_SESSION_SECRET",
        os.environ.get("JWT_SECRET", "slideshow-development-secret"),
    )
    SSO_JWT_SECRET = os.environ.get("JWT_SECRET", "replace-with-a-long-random-secret")
    SERVICE_PORTAL_URL = os.environ.get("SERVICE_PORTAL_URL", "/portal")
    APPLICATION_ROOT = os.environ.get("APPLICATION_ROOT", "/slideshow")

    DATABASE = os.environ.get(
        "SLIDESHOW_DATABASE_PATH", os.path.join(ACCOUNTS_DIR, "slideshow.db")
    )
    ACCOUNT_DATABASE = os.environ.get(
        "HOMEWORKS_ACCOUNT_DATABASE_PATH", os.path.join(ACCOUNTS_DIR, "accounts.db")
    )
    COURSE_DATABASE = os.environ.get(
        "HOMEWORKS_COURSE_DATABASE_PATH", os.path.join(ACCOUNTS_DIR, "courses.db")
    )
    UPLOAD_DIR = os.environ.get(
        "SLIDESHOW_UPLOAD_PATH", os.path.join(BASE_DIR, "uploads")
    )

    COURSEWORKS_INTERNAL_API_URL = os.environ.get(
        "COURSEWORKS_INTERNAL_API_URL", "http://127.0.0.1:3000/api"
    )
    AI_PROVIDER = os.environ.get("SLIDESHOW_AI_PROVIDER", "global")
    LIBREOFFICE_BIN = os.environ.get("LIBREOFFICE_BIN", "/usr/bin/libreoffice")
    PDFTOPPM_BIN = os.environ.get("PDFTOPPM_BIN", "/usr/bin/pdftoppm")
    CONVERSION_TIMEOUT_SECONDS = int(os.environ.get("SLIDESHOW_CONVERSION_TIMEOUT", "300"))

    MAX_CONTENT_LENGTH = 80 * 1024 * 1024
    PERMANENT_SESSION_LIFETIME = 12 * 3600
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_PATH = "/slideshow"
