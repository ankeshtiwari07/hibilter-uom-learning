import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from .config import get_settings

_ph = PasswordHasher()
COOKIE = "uom_session"
CSRF_COOKIE = "uom_csrf"


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, h: str | None) -> bool:
    if not h:
        return False
    try:
        return _ph.verify(h, pw)
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def make_token(user_id: str, role: str) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": user_id, "role": role, "iat": now, "exp": now + timedelta(minutes=s.jwt_ttl_minutes)},
                      s.jwt_secret, algorithm="HS256")


def read_token(tok: str) -> dict | None:
    try:
        return jwt.decode(tok, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def new_csrf() -> str:
    return secrets.token_urlsafe(24)
