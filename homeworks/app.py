"""Entry point.

Run the development server from the project root:

    python3 app.py

Production uses Gunicorn through the Unix socket configured by homework.service.
For local development, the server listens on 0.0.0.0:10000 by default; override
with the PORT environment variable (e.g. ``PORT=8000 python3 app.py``).
"""
from app import create_app
from config import Config

app = create_app()

if __name__ == "__main__":
    app.run(host=Config.HOST, port=Config.PORT, debug=False)
