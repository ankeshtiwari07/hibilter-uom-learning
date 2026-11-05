from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import User
from .db import get_db
from .security import COOKIE, CSRF_COOKIE, read_token

SAFE = {"GET", "HEAD", "OPTIONS"}
TRIAL_EXPIRED = "This trial access has expired. Contact Hibilter to extend it."


def trial_expired(user: User) -> bool:
    return bool(user.expires_at and datetime.now(timezone.utc) >= user.expires_at)


def owner_id(user: User) -> str:
    """The lecturer whose courses this account manages (a read-only trial lecturer mirrors another lecturer)."""
    return user.acts_for or user.id


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    tok = request.cookies.get(COOKIE) or (request.headers.get("authorization", "")[7:] or None)
    claims = read_token(tok) if tok else None
    if not claims:
        raise HTTPException(401, "Sign in to continue.")
    # CSRF double-submit for cookie-authenticated mutations
    if request.method not in SAFE and request.cookies.get(COOKIE):
        if not request.headers.get("x-csrf") or request.headers.get("x-csrf") != request.cookies.get(CSRF_COOKIE):
            raise HTTPException(403, "Security token missing or expired. Reload the page.")
    user = await db.get(User, claims["sub"])
    if not user or user.status != "active":
        raise HTTPException(401, "Your account is not active.")
    if trial_expired(user):
        raise HTTPException(401, TRIAL_EXPIRED)
    return user


def require(*roles: str):
    async def dep(request: Request, user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "You don't have access to this.")
        if user.acts_for and request.method not in SAFE:
            raise HTTPException(403, "This trial lecturer account is view-only — changes are disabled.")
        return user
    return dep
