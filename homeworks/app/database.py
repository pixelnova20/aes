"""Database bootstrap: SQLAlchemy engine, scoped session and declarative base."""
import os

from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, scoped_session, sessionmaker

Base = declarative_base()
engine = None
db_session = scoped_session(sessionmaker(expire_on_commit=False))


def init_db(app):
    """Create the database file (and its directory) and all tables."""
    global engine

    course_db_path = app.config["COURSE_DATABASE"]
    account_db_path = app.config["ACCOUNT_DATABASE"]
    os.makedirs(os.path.dirname(course_db_path), exist_ok=True)
    os.makedirs(os.path.dirname(account_db_path), exist_ok=True)

    engine = create_engine(
        f"sqlite:///{course_db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _attach_account_database(dbapi_connection, _connection_record):
        dbapi_connection.execute("ATTACH DATABASE ? AS accounts", (account_db_path,))

    db_session.configure(bind=engine)

    # Import models so they are registered on the metadata before create_all.
    from . import models  # noqa: F401

    Base.metadata.create_all(engine)


def close_db(exc=None):
    db_session.remove()
