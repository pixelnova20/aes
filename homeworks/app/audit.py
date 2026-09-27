"""Audit logging helper."""
from .database import db_session
from .models import AuditLog
from .auth_utils import current_user


def log(action, detail=None):
    user = current_user()
    db_session.add(
        AuditLog(
            user_id=user.id if user else None,
            user_email=user.email if user else None,
            action=action,
            detail=detail,
        )
    )
    db_session.commit()