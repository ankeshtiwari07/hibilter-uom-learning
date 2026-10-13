from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.deps import current_user
from ..core.ratelimit import hit
from ..core.security import COOKIE, CSRF_COOKIE, hash_password, make_token, new_csrf, verify_password
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
LOCK_AFTER = 5
LOCK_MINUTES = 15


class LoginIn(BaseModel):
    email: str
    password: str


class PasswordIn(BaseModel):
    current: str
    new: str


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "role": u.role, "name": u.name, "first": u.first, "title": u.title,
            "faculty_id": u.faculty_id, "programme_id": u.programme_id, "student_no": u.student_no, "year": u.year,
            "prefs": u.prefs or {}}


def _set_cookies(resp: Response, token: str):
    s = get_settings()
    resp.set_cookie(COOKIE, token, httponly=True, secure=s.cookie_secure, samesite="lax", max_age=s.jwt_ttl_minutes * 60, path="/")
    resp.set_cookie(CSRF_COOKIE, new_csrf(), httponly=False, secure=s.cookie_secure, samesite="lax", max_age=s.jwt_ttl_minutes * 60, path="/")


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if not await hit(f"login:{ip}", get_settings().login_rate_per_min):
        raise HTTPException(429, "Too many sign-in attempts. Wait a minute and try again.")
    email = body.email.strip().lower()
    u = (await db.execute(select(User).where(func.lower(User.email) == email))).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if u and u.locked_until and u.locked_until > now:
        raise HTTPException(423, f"Account locked after repeated failed sign-ins. Try again after {u.locked_until:%H:%M} UTC.")
    if not u or not verify_password(body.password, u.password_hash):
        if u:
            u.failed_logins += 1
            if u.failed_logins >= LOCK_AFTER:
                u.locked_until = now + timedelta(minutes=LOCK_MINUTES)
                await audit(db, u, "Account locked", "auth", u.email, detail={"ip": ip})
            await db.commit()
        raise HTTPException(401, "Email or password is incorrect.")
    if u.status != "active":
        raise HTTPException(403, "This account is suspended. Contact the academic office.")
    u.failed_logins, u.locked_until, u.last_login_at = 0, None, now
    await audit(db, u, "Signed in", "auth", u.email, detail={"ip": ip})
    await db.commit()
    _set_cookies(response, make_token(u.id, u.role))
    return user_out(u)


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(response: Response, request: Request, user: User = Depends(current_user)):
    if not request.cookies.get(CSRF_COOKIE):
        _set_cookies(response, make_token(user.id, user.role))
    return user_out(user)


@router.post("/password")
async def change_password(body: PasswordIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    if not verify_password(body.current, user.password_hash):
        raise HTTPException(400, "Current password is incorrect.")
    if len(body.new) < 10:
        raise HTTPException(400, "Use at least 10 characters.")
    user.password_hash = hash_password(body.new)
    await audit(db, user, "Changed password", "auth", user.email)
    await db.commit()
    return {"ok": True}


@router.patch("/prefs")
async def prefs(body: dict, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    allowed = {"theme", "captions", "reducedMotion", "textSize", "audio", "notifications", "engine", "avatar", "language"}
    user.prefs = {**(user.prefs or {}), **{k: v for k, v in body.items() if k in allowed}}
    await db.commit()
    return user.prefs
