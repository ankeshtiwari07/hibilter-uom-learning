"""Administrator: users & roles (S28). Every change is audited (kind 'access').

Safeguards: an administrator can't change their own role or suspend themselves, and the last active administrator
can't be demoted or suspended.
"""
from __future__ import annotations

import re
import secrets
import string

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..core.security import hash_password
from ..models import Course, Enrolment, Faculty, Programme, User
from ._admin_common import now

router = APIRouter(prefix="/api/admin", tags=["admin-users"])
ADMIN = Depends(require("admin"))
ROLES = ("student", "lecturer", "admin")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TITLES = re.compile(r"^(Dr\.|Prof\.|Ms\.|Mr\.|Mrs\.)\s*", re.I)


def gen_password() -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        p = "".join(secrets.choice(alphabet) for _ in range(12)) + "-" + "".join(secrets.choice(string.digits) for _ in range(2))
        if any(c.isupper() for c in p) and any(c.islower() for c in p):
            return p


def _locked(u: User) -> bool:
    return bool(u.locked_until and u.locked_until > now())


def _out(u: User, fac: dict, prog: dict, scope: dict) -> dict:
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "title": u.title, "faculty_id": u.faculty_id,
            "faculty": fac.get(u.faculty_id), "programme_id": u.programme_id, "programme": prog.get(u.programme_id),
            "student_no": u.student_no, "year": u.year, "status": u.status, "locked": _locked(u),
            "locked_until": u.locked_until.isoformat() if _locked(u) else None, "failed_logins": u.failed_logins,
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "created_at": u.created_at.isoformat() if u.created_at else None, "scope": scope.get(u.id, [])}


@router.get("/users")
async def users(q: str | None = Query(None, max_length=100), role: str = Query("all", pattern="^(all|student|lecturer|admin)$"),
                status: str = Query("all", pattern="^(all|active|suspended|locked)$"), faculty: str | None = None,
                page: int = Query(1, ge=1, le=10000), size: int = Query(25, ge=5, le=100),
                db: AsyncSession = Depends(get_db), me: User = ADMIN):
    conds = []
    if q and q.strip():
        like = "%" + q.strip().replace("%", r"\%").replace("_", r"\_") + "%"
        conds.append(or_(User.name.ilike(like), User.email.ilike(like), User.student_no.ilike(like)))
    if role != "all":
        conds.append(User.role == role)
    if status == "locked":
        conds.append(User.locked_until > now())
    elif status != "all":
        conds.append(User.status == status)
    if faculty and faculty != "all":
        conds.append(User.faculty_id == faculty)
    total = (await db.execute(select(func.count()).select_from(User).where(*conds))).scalar()
    rows = (await db.execute(select(User).where(*conds).order_by(
        case((User.role == "admin", 0), (User.role == "lecturer", 1), else_=2), User.name).limit(size).offset((page - 1) * size))).scalars().all()
    ids = [u.id for u in rows]
    scope: dict[str, list[str]] = {}
    for uid, code in (await db.execute(select(Enrolment.user_id, Course.code).join(Course, Course.id == Enrolment.course_id)
                                       .where(Enrolment.user_id.in_(ids), Enrolment.status == "active").order_by(Course.code))).all():
        scope.setdefault(uid, []).append(code)
    for uid, code in (await db.execute(select(Course.lecturer_id, Course.code).where(Course.lecturer_id.in_(ids)).order_by(Course.code))).all():
        scope.setdefault(uid, []).append(code)
    fac = dict((await db.execute(select(Faculty.id, Faculty.short))).all())
    prog = dict((await db.execute(select(Programme.id, Programme.name))).all())
    counts = dict((await db.execute(select(User.role, func.count()).group_by(User.role))).all())
    return {"items": [_out(u, fac, prog, scope) for u in rows], "total": int(total), "page": page, "size": size,
            "counts": counts, "me": me.id}


class UserIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    email: str = Field(max_length=200)
    role: str
    title: str | None = Field(None, max_length=200)
    faculty_id: str | None = None
    programme_id: str | None = None
    student_no: str | None = Field(None, max_length=32)
    year: int | None = Field(None, ge=1, le=8)
    password: str | None = Field(None, max_length=200)

    @field_validator("email")
    @classmethod
    def em(cls, v):
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @field_validator("role")
    @classmethod
    def rl(cls, v):
        if v not in ROLES:
            raise ValueError("Role must be student, lecturer or admin.")
        return v

    @field_validator("name")
    @classmethod
    def nm(cls, v):
        v = re.sub(r"\s+", " ", v).strip()
        if len(v) < 2:
            raise ValueError("Enter the person's full name.")
        return v


@router.post("/users", status_code=201)
async def create_user(body: UserIn, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    if (await db.execute(select(User.id).where(func.lower(User.email) == body.email))).first():
        raise HTTPException(409, "A user with this email already exists.")
    if body.faculty_id and not await db.get(Faculty, body.faculty_id):
        raise HTTPException(422, "Choose an existing faculty.")
    if body.programme_id:
        p = await db.get(Programme, body.programme_id)
        if not p:
            raise HTTPException(422, "Choose an existing programme.")
        if body.faculty_id and p.faculty_id != body.faculty_id:
            raise HTTPException(422, "The programme belongs to a different faculty.")
    if body.role == "student" and not body.programme_id:
        raise HTTPException(422, "Choose the student's programme.")
    if body.role == "lecturer" and not body.faculty_id:
        raise HTTPException(422, "Choose the lecturer's faculty.")
    generated = not body.password
    pw = body.password or gen_password()
    if len(pw) < 10:
        raise HTTPException(422, "Initial password must be at least 10 characters.")
    sno = (body.student_no or "").strip() or None
    if body.role == "student":
        if sno and (await db.execute(select(User.id).where(User.student_no == sno))).first():
            raise HTTPException(409, "This student ID is already in use.")
        if not sno:
            while True:
                sno = f"DEMO-{secrets.randbelow(900000) + 2500000}"
                if not (await db.execute(select(User.id).where(User.student_no == sno))).first():
                    break
    fac_id = body.faculty_id
    if body.programme_id and not fac_id:
        fac_id = (await db.get(Programme, body.programme_id)).faculty_id
    first = TITLES.sub("", body.name).split(" ")[0]
    u = User(email=body.email, password_hash=hash_password(pw), role=body.role, name=body.name, first=first,
             title=(body.title or "").strip() or None, faculty_id=fac_id,
             programme_id=body.programme_id if body.role == "student" else None,
             student_no=sno if body.role == "student" else None, year=body.year if body.role == "student" else None,
             status="active", prefs={}, risk={}, failed_logins=0)
    db.add(u)
    await db.flush()
    await audit(db, me, "Created user", "access", f"{u.name} ({u.role})", detail={"email": u.email})
    await db.commit()
    return {"id": u.id, "email": u.email, "password": pw if generated else None, "generated": generated}


async def _target(db: AsyncSession, uid: str) -> User:
    u = await db.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found.")
    return u


async def _other_admins(db: AsyncSession, uid: str) -> int:
    return (await db.execute(select(func.count()).select_from(User).where(User.role == "admin", User.status == "active",
                                                                          User.id != uid))).scalar()


class RoleIn(BaseModel):
    role: str
    reason: str | None = Field(None, max_length=300)


@router.patch("/users/{uid}/role")
async def change_role(uid: str, body: RoleIn, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    if body.role not in ROLES:
        raise HTTPException(422, "Role must be student, lecturer or admin.")
    u = await _target(db, uid)
    if u.id == me.id:
        raise HTTPException(409, "You can't change your own role. Ask another administrator.")
    if u.role == body.role:
        return {"ok": True}
    if u.role == "admin" and not await _other_admins(db, u.id):
        raise HTTPException(409, "This is the last active administrator. Add another administrator first.")
    if body.role != "lecturer":
        assigned = (await db.execute(select(Course.code).where(Course.lecturer_id == u.id))).scalars().all()
        if assigned:
            raise HTTPException(409, f"Reassign this lecturer's courses first ({', '.join(assigned)}).")
    old = u.role
    u.role = body.role
    if body.role != "student":
        u.programme_id, u.year = None, None
    await audit(db, me, "Changed role", "access", f"{u.name}: {old} → {body.role}", reason=body.reason)
    await db.commit()
    return {"ok": True}


class ReasonIn(BaseModel):
    reason: str | None = Field(None, max_length=300)


@router.post("/users/{uid}/suspend")
async def suspend(uid: str, body: ReasonIn | None = None, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    if u.id == me.id:
        raise HTTPException(409, "You can't suspend your own account.")
    if u.role == "admin" and not await _other_admins(db, u.id):
        raise HTTPException(409, "This is the last active administrator and can't be suspended.")
    if u.status == "suspended":
        return {"ok": True}
    u.status = "suspended"
    await audit(db, me, "Suspended account", "access", f"{u.name} ({u.email})", reason=body.reason if body else None)
    await db.commit()
    return {"ok": True}


@router.post("/users/{uid}/reactivate")
async def reactivate(uid: str, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    if u.status == "active":
        return {"ok": True}
    u.status = "active"
    await audit(db, me, "Reactivated account", "access", f"{u.name} ({u.email})")
    await db.commit()
    return {"ok": True}


@router.post("/users/{uid}/unlock")
async def unlock(uid: str, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    was = _locked(u)
    u.locked_until, u.failed_logins = None, 0
    await audit(db, me, "Unlocked account", "access", f"{u.name} ({u.email})", detail={"was_locked": was})
    await db.commit()
    return {"ok": True}


@router.post("/users/{uid}/reset-password")
async def reset_password(uid: str, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    if u.id == me.id:
        raise HTTPException(409, "Change your own password from your profile instead.")
    pw = gen_password()
    u.password_hash = hash_password(pw)
    u.locked_until, u.failed_logins = None, 0
    await audit(db, me, "Reset password", "access", f"{u.name} ({u.email})")
    await db.commit()
    return {"password": pw}


class EnrolIn(BaseModel):
    course_id: str


@router.post("/users/{uid}/enrolments", status_code=201)
async def enrol(uid: str, body: EnrolIn, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    if u.role != "student":
        raise HTTPException(422, "Only students can be enrolled. Assign lecturers to courses instead.")
    c = await db.get(Course, body.course_id)
    if not c or c.status == "archived":
        raise HTTPException(422, "Choose an active course.")
    e = (await db.execute(select(Enrolment).where(Enrolment.user_id == uid, Enrolment.course_id == c.id))).scalar_one_or_none()
    if e and e.status == "active":
        raise HTTPException(409, f"{u.name} is already enrolled in {c.code}.")
    if e:
        e.status = "active"
    else:
        db.add(Enrolment(user_id=uid, course_id=c.id, progress=0, status="active"))
    await audit(db, me, "Enrolled student", "access", f"{u.name} → {c.code}")
    await db.commit()
    return {"ok": True}


@router.delete("/users/{uid}/enrolments/{course_id}")
async def unenrol(uid: str, course_id: str, db: AsyncSession = Depends(get_db), me: User = ADMIN):
    u = await _target(db, uid)
    e = (await db.execute(select(Enrolment).where(Enrolment.user_id == uid, Enrolment.course_id == course_id))).scalar_one_or_none()
    if not e or e.status != "active":
        raise HTTPException(404, "Enrolment not found.")
    c = await db.get(Course, course_id)
    e.status = "withdrawn"
    await audit(db, me, "Withdrew enrolment", "access", f"{u.name} → {c.code if c else course_id}")
    await db.commit()
    return {"ok": True}
