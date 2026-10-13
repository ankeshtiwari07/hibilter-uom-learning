"""Administrator: academic structure (S22) — faculties, programmes, courses, academic terms."""
from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import AcademicTerm, Course, Enrolment, Faculty, Lesson, Module, Programme, User

router = APIRouter(prefix="/api/admin", tags=["admin-structure"])
ADMIN = Depends(require("admin"))
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,15}$")
CODE_RE = re.compile(r"^[A-Z]{2,5}-[A-Z]{2,4}\d{3}[A-Z]?$")
COURSE_STATUSES = ("draft", "published", "archived")
LEVELS = ("Undergraduate", "Postgraduate", "Short course", "Doctoral", "Diploma")


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# ---------- tree ----------
@router.get("/structure")
async def structure(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    facs = (await db.execute(select(Faculty).order_by(Faculty.name))).scalars().all()
    progs = (await db.execute(select(Programme).order_by(Programme.name))).scalars().all()
    rows = (await db.execute(
        select(Course, User.name, func.count(Enrolment.id).filter(Enrolment.status == "active"))
        .outerjoin(User, User.id == Course.lecturer_id).outerjoin(Enrolment, Enrolment.course_id == Course.id)
        .group_by(Course.id, User.name).order_by(Course.code))).all()
    students = dict((await db.execute(select(User.programme_id, func.count()).where(User.role == "student")
                                       .group_by(User.programme_id))).all())
    courses = [{"id": c.id, "code": c.code, "title": c.title, "faculty_id": c.faculty_id, "programme_id": c.programme_id,
                "lecturer_id": c.lecturer_id, "lecturer": lec, "term": c.term, "credits": c.credits, "status": c.status,
                "vf_enabled": c.vf_enabled, "enrolled": int(n or 0)} for c, lec, n in rows]
    return {"faculties": [{"id": f.id, "name": f.name, "short": f.short,
                           "programmes": [{"id": p.id, "name": p.name, "level": p.level, "years": p.years,
                                           "students": int(students.get(p.id, 0)),
                                           "courses": [c for c in courses if c["programme_id"] == p.id]}
                                          for p in progs if p.faculty_id == f.id],
                           "unassigned": [c for c in courses if c["faculty_id"] == f.id and not c["programme_id"]]}
                          for f in facs]}


@router.get("/courses/{course_id}")
async def course_detail(course_id: str, db: AsyncSession = Depends(get_db), _: User = ADMIN):
    c = await db.get(Course, course_id)
    if not c:
        raise HTTPException(404, "Course not found.")
    mods = (await db.execute(select(Module).where(Module.course_id == c.id).order_by(Module.ord))).scalars().all()
    lessons = (await db.execute(select(func.count()).select_from(Lesson).where(Lesson.course_id == c.id))).scalar()
    enrol = (await db.execute(select(User.id, User.name, Enrolment.progress).join(Enrolment, Enrolment.user_id == User.id)
                              .where(Enrolment.course_id == c.id, Enrolment.status == "active").order_by(User.name))).all()
    fac = await db.get(Faculty, c.faculty_id); prog = await db.get(Programme, c.programme_id) if c.programme_id else None
    lec = await db.get(User, c.lecturer_id) if c.lecturer_id else None
    return {"id": c.id, "code": c.code, "title": c.title, "faculty_id": c.faculty_id, "faculty": fac.name if fac else None,
            "programme_id": c.programme_id, "programme": prog.name if prog else None, "lecturer_id": c.lecturer_id,
            "lecturer": lec.name if lec else None, "term": c.term, "credits": c.credits, "description": c.description,
            "status": c.status, "vf_enabled": c.vf_enabled, "digital_lecturer": (c.meta or {}).get("vf"),
            "modules": [{"id": m.id, "title": m.title, "items": len(m.items or [])} for m in mods], "vf_lessons": int(lessons or 0),
            "enrolled": len(enrol), "enrolled_sample": [n for _, n, _ in enrol[:8]]}


# ---------- faculties ----------
class FacultyIn(BaseModel):
    id: str | None = Field(None, max_length=16)
    name: str = Field(min_length=3, max_length=200)
    short: str = Field(min_length=2, max_length=64)


@router.post("/faculties", status_code=201)
async def create_faculty(body: FacultyIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    fid = (body.id or "").strip().lower()
    if not ID_RE.match(fid):
        raise HTTPException(422, "Faculty ID must be 2–16 lowercase letters, digits or hyphens.")
    if await db.get(Faculty, fid):
        raise HTTPException(409, "A faculty with this ID already exists.")
    name = _clean(body.name)
    if (await db.execute(select(Faculty).where(func.lower(Faculty.name) == name.lower()))).first():
        raise HTTPException(409, "A faculty with this name already exists.")
    db.add(Faculty(id=fid, name=name, short=_clean(body.short)))
    await audit(db, user, "Created faculty", "content", name)
    await db.commit()
    return {"id": fid}


@router.patch("/faculties/{fid}")
async def edit_faculty(fid: str, body: FacultyIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    f = await db.get(Faculty, fid)
    if not f:
        raise HTTPException(404, "Faculty not found.")
    f.name, f.short = _clean(body.name), _clean(body.short)
    await audit(db, user, "Edited faculty", "content", f.name)
    await db.commit()
    return {"ok": True}


# ---------- programmes ----------
class ProgrammeIn(BaseModel):
    id: str | None = Field(None, max_length=32)
    faculty_id: str
    name: str = Field(min_length=3, max_length=200)
    level: str
    years: int = Field(3, ge=0, le=8)

    @field_validator("level")
    @classmethod
    def lv(cls, v):
        if v not in LEVELS:
            raise ValueError(f"Level must be one of: {', '.join(LEVELS)}")
        return v


@router.post("/programmes", status_code=201)
async def create_programme(body: ProgrammeIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    if not await db.get(Faculty, body.faculty_id):
        raise HTTPException(422, "Choose an existing faculty.")
    name = _clean(body.name)
    if (await db.execute(select(Programme).where(func.lower(Programme.name) == name.lower(), Programme.faculty_id == body.faculty_id))).first():
        raise HTTPException(409, "This faculty already has a programme with this name.")
    pid = (body.id or "").strip().lower() or "p-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24]
    if not re.match(r"^[a-z0-9][a-z0-9-]{1,31}$", pid):
        raise HTTPException(422, "Programme ID must be lowercase letters, digits or hyphens.")
    base, i = pid, 2
    while await db.get(Programme, pid):
        pid = f"{base[:28]}-{i}"; i += 1
    db.add(Programme(id=pid, faculty_id=body.faculty_id, name=name, level=body.level, years=body.years))
    await audit(db, user, "Created programme", "content", name, detail={"faculty": body.faculty_id})
    await db.commit()
    return {"id": pid}


@router.patch("/programmes/{pid}")
async def edit_programme(pid: str, body: ProgrammeIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    p = await db.get(Programme, pid)
    if not p:
        raise HTTPException(404, "Programme not found.")
    if not await db.get(Faculty, body.faculty_id):
        raise HTTPException(422, "Choose an existing faculty.")
    p.name, p.level, p.years = _clean(body.name), body.level, body.years
    if p.faculty_id != body.faculty_id:
        p.faculty_id = body.faculty_id
        await db.execute(update(Course).where(Course.programme_id == pid).values(faculty_id=body.faculty_id))
    await audit(db, user, "Edited programme", "content", p.name)
    await db.commit()
    return {"ok": True}


@router.delete("/programmes/{pid}")
async def delete_programme(pid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    p = await db.get(Programme, pid)
    if not p:
        raise HTTPException(404, "Programme not found.")
    nc = (await db.execute(select(func.count()).select_from(Course).where(Course.programme_id == pid))).scalar()
    ns = (await db.execute(select(func.count()).select_from(User).where(User.programme_id == pid))).scalar()
    if nc or ns:
        raise HTTPException(409, f"This programme still has {nc} course(s) and {ns} learner(s). Move or archive them first.")
    await db.delete(p)
    await audit(db, user, "Deleted programme", "content", p.name)
    await db.commit()
    return {"ok": True}


# ---------- courses ----------
class CourseIn(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    title: str = Field(min_length=3, max_length=200)
    faculty_id: str
    programme_id: str | None = None
    lecturer_id: str | None = None
    term: str = Field("S1 2026/27", min_length=2, max_length=32)
    credits: int = Field(3, ge=0, le=60)
    description: str = Field("", max_length=4000)
    status: str = "draft"

    @field_validator("code")
    @classmethod
    def code_ok(cls, v):
        v = v.strip().upper()
        if not CODE_RE.match(v):
            raise ValueError("Use a code like HB-AI101 (prefix, hyphen, subject letters and three digits).")
        return v

    @field_validator("status")
    @classmethod
    def st_ok(cls, v):
        if v not in COURSE_STATUSES:
            raise ValueError("Status must be draft, published or archived.")
        return v


class CoursePatch(BaseModel):
    code: str | None = None
    title: str | None = Field(None, min_length=3, max_length=200)
    faculty_id: str | None = None
    programme_id: str | None = None
    lecturer_id: str | None = None
    term: str | None = Field(None, min_length=2, max_length=32)
    credits: int | None = Field(None, ge=0, le=60)
    description: str | None = Field(None, max_length=4000)
    status: str | None = None
    reason: str | None = Field(None, max_length=300)

    _code = field_validator("code")(lambda cls, v: CourseIn.code_ok(v) if v is not None else v)
    _st = field_validator("status")(lambda cls, v: CourseIn.st_ok(v) if v is not None else v)


async def _check_refs(db: AsyncSession, faculty_id, programme_id, lecturer_id):
    if faculty_id is not None and not await db.get(Faculty, faculty_id):
        raise HTTPException(422, "Choose an existing faculty.")
    if programme_id:
        p = await db.get(Programme, programme_id)
        if not p:
            raise HTTPException(422, "Choose an existing programme.")
        if faculty_id and p.faculty_id != faculty_id:
            raise HTTPException(422, "The programme belongs to a different faculty.")
    if lecturer_id:
        l = await db.get(User, lecturer_id)
        if not l or l.role != "lecturer":
            raise HTTPException(422, "Assign an existing lecturer account.")
        if l.status != "active":
            raise HTTPException(422, "This lecturer account is suspended.")


async def _code_free(db: AsyncSession, code: str, except_id: str | None = None):
    q = select(Course.id).where(func.upper(Course.code) == code.upper())
    if except_id:
        q = q.where(Course.id != except_id)
    if (await db.execute(q)).first():
        raise HTTPException(409, f"Course code {code} is already in use.")


@router.post("/courses", status_code=201)
async def create_course(body: CourseIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _check_refs(db, body.faculty_id, body.programme_id, body.lecturer_id)
    await _code_free(db, body.code)
    cid = "c-" + re.sub(r"[^a-z0-9]+", "", body.code.lower())[:28]
    while await db.get(Course, cid):
        cid = cid[:26] + "x"
    db.add(Course(id=cid, code=body.code, title=_clean(body.title), faculty_id=body.faculty_id, programme_id=body.programme_id or None,
                  lecturer_id=body.lecturer_id or None, term=_clean(body.term), credits=body.credits,
                  description=body.description.strip(), status=body.status, cover=1, vf_enabled=False, meta={}))
    await audit(db, user, "Created course", "content", f"{body.code} {_clean(body.title)}")
    await db.commit()
    return {"id": cid}


@router.patch("/courses/{course_id}")
async def edit_course(course_id: str, body: CoursePatch, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    c = await db.get(Course, course_id)
    if not c:
        raise HTTPException(404, "Course not found.")
    data = body.model_dump(exclude_unset=True)
    reason = data.pop("reason", None)
    fac = data.get("faculty_id", c.faculty_id)
    prog = data["programme_id"] if "programme_id" in data else c.programme_id
    await _check_refs(db, fac, prog, data.get("lecturer_id"))
    if "code" in data and data["code"]:
        await _code_free(db, data["code"], c.id)
    changes = {}
    for k, v in data.items():
        if k in ("title", "term") and v is not None:
            v = _clean(v)
        if k in ("programme_id", "lecturer_id") and not v:
            v = None
        if v is None and k not in ("programme_id", "lecturer_id"):
            continue
        if getattr(c, k) != v:
            changes[k] = [getattr(c, k), v]
            setattr(c, k, v)
    if not changes:
        return {"ok": True, "changed": []}
    if "lecturer_id" in changes:
        lec = await db.get(User, c.lecturer_id) if c.lecturer_id else None
        await audit(db, user, "Assigned lecturer", "access", f"{c.code} → {lec.name if lec else 'Unassigned'}", reason=reason)
    if "status" in changes:
        await audit(db, user, {"archived": "Archived course", "published": "Published course", "draft": "Moved course to draft"}[c.status],
                    "content", f"{c.code} {c.title}", reason=reason)
    other = {k: v for k, v in changes.items() if k not in ("lecturer_id", "status")}
    if other:
        await audit(db, user, "Edited course", "content", f"{c.code} {c.title}", reason=reason,
                    detail={k: [str(a) if a is not None else None, str(b) if b is not None else None] for k, (a, b) in other.items()})
    await db.commit()
    return {"ok": True, "changed": list(changes)}


# ---------- academic terms ----------
class TermIn(BaseModel):
    id: str | None = Field(None, max_length=32)
    name: str = Field(min_length=3, max_length=100)
    start: date
    end: date


@router.get("/terms")
async def terms(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    ts = (await db.execute(select(AcademicTerm).order_by(AcademicTerm.start.desc()))).scalars().all()
    return [{"id": t.id, "name": t.name, "start": t.start.isoformat(), "end": t.end.isoformat(), "current": t.current} for t in ts]


async def _term_ok(db: AsyncSession, body: TermIn, except_id: str | None = None):
    if body.end <= body.start:
        raise HTTPException(422, "The term must end after it starts.")
    if (body.end - body.start).days > 400:
        raise HTTPException(422, "A term can't be longer than about a year.")
    q = select(AcademicTerm).where(AcademicTerm.start <= body.end, AcademicTerm.end >= body.start)
    if except_id:
        q = q.where(AcademicTerm.id != except_id)
    clash = (await db.execute(q)).scalars().first()
    if clash:
        raise HTTPException(409, f"These dates overlap with {clash.name}.")
    q = select(AcademicTerm.id).where(func.lower(AcademicTerm.name) == _clean(body.name).lower())
    if except_id:
        q = q.where(AcademicTerm.id != except_id)
    if (await db.execute(q)).first():
        raise HTTPException(409, "A term with this name already exists.")


@router.post("/terms", status_code=201)
async def create_term(body: TermIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _term_ok(db, body)
    tid = (body.id or "").strip().lower() or re.sub(r"[^a-z0-9]+", "-", _clean(body.name).lower()).strip("-")[:32]
    if await db.get(AcademicTerm, tid):
        raise HTTPException(409, "A term with this ID already exists.")
    db.add(AcademicTerm(id=tid, name=_clean(body.name), start=body.start, end=body.end, current=False))
    await audit(db, user, "Created academic term", "content", f"{_clean(body.name)} ({body.start} – {body.end})")
    await db.commit()
    return {"id": tid}


@router.patch("/terms/{tid}")
async def edit_term(tid: str, body: TermIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    t = await db.get(AcademicTerm, tid)
    if not t:
        raise HTTPException(404, "Term not found.")
    await _term_ok(db, body, tid)
    t.name, t.start, t.end = _clean(body.name), body.start, body.end
    await audit(db, user, "Edited academic term", "content", f"{t.name} ({t.start} – {t.end})")
    await db.commit()
    return {"ok": True}


@router.post("/terms/{tid}/current")
async def set_current(tid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    t = await db.get(AcademicTerm, tid)
    if not t:
        raise HTTPException(404, "Term not found.")
    await db.execute(update(AcademicTerm).values(current=False))
    t.current = True
    await audit(db, user, "Set current academic term", "system", t.name)
    await db.commit()
    return {"ok": True}


@router.delete("/terms/{tid}")
async def delete_term(tid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    t = await db.get(AcademicTerm, tid)
    if not t:
        raise HTTPException(404, "Term not found.")
    if t.current:
        raise HTTPException(409, "You can't delete the current term. Set another term as current first.")
    await db.delete(t)
    await audit(db, user, "Deleted academic term", "content", t.name)
    await db.commit()
    return {"ok": True}
