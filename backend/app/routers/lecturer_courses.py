"""Lecturer dashboard (S14) and course management (S15): settings, outcomes, modules and roster."""
from __future__ import annotations

import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import (Assessment, CalendarEvent, Course, Enrolment, Faculty, Lesson, Message, Module, ReviewItem, Submission,
                      Thread, User, VFAttempt, VFSession)
from ._lecturer_common import (enrolled_students, iso, last_active, my_courses, now, overdue_counts, owned_course,
                               risk_reasons)

router = APIRouter(prefix="/api/lecturer", tags=["lecturer"])
LECT = require("lecturer", "admin")


# ---------------------------------------------------------------- dashboard
@router.get("/dashboard")
async def dashboard(db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    courses = await my_courses(db, user)
    cids = [c.id for c in courses]
    fac = await db.get(Faculty, user.faculty_id) if user.faculty_id else None
    roster = await enrolled_students(db, cids)
    students = {u.id for u, _ in roster}
    t = now()
    # submissions waiting for marking
    pend_rows = (await db.execute(select(Submission, Assessment).join(Assessment, Assessment.id == Submission.assessment_id)
                                  .where(Assessment.course_id.in_(cids), Submission.status == "submitted"))).all() if cids else []
    by_as: dict[str, dict] = {}
    for sb, a in pend_rows:
        x = by_as.setdefault(a.id, {"id": a.id, "title": a.title, "course_id": a.course_id, "due": iso(a.due), "n": 0})
        x["n"] += 1
    # at-risk learners
    od = await overdue_counts(db, cids)
    last = await last_active(db, list(students))
    course_of = {}
    for u, e in roster:
        course_of.setdefault(u.id, []).append(e.course_id)
    seen, follow = set(), []
    for u, e in roster:
        if u.id in seen:
            continue
        seen.add(u.id)
        rs = risk_reasons(u, od.get(u.id, 0), last.get(u.id))
        if rs:
            follow.append({"id": u.id, "name": u.name, "first": u.first, "reasons": rs, "courses": course_of[u.id]})
    # graded average (published + graded) as % of max
    scores = (await db.execute(select(Submission.score, Assessment.max_score).join(Assessment, Assessment.id == Submission.assessment_id)
                               .where(Assessment.course_id.in_(cids), Submission.status.in_(["graded", "published"]),
                                      Submission.score.is_not(None)))).all() if cids else []
    avg = round(sum(s / m * 100 for s, m in scores if m) / len(scores), 1) if scores else None
    # virtual faculty
    lesson_ids = list((await db.execute(select(Lesson.id).where(Lesson.course_id.in_(cids)))).scalars()) if cids else []
    vs = list((await db.execute(select(VFSession).where(VFSession.lesson_id.in_(lesson_ids), VFSession.status != "superseded")))
              .scalars()) if lesson_ids else []
    started = [s for s in vs if s.started_at]
    completed = [s for s in vs if s.status == "completed"]
    firsts = (await db.execute(select(VFAttempt.verdict).where(VFAttempt.session_id.in_([s.id for s in vs]), VFAttempt.n == 1))).scalars().all() if vs else []
    first_ok = round(100 * sum(1 for v in firsts if v == "correct") / len(firsts)) if firsts else None
    open_reviews = (await db.execute(select(func.count()).select_from(ReviewItem).where(ReviewItem.course_id.in_(cids), ReviewItem.status == "open"))).scalar() if cids else 0
    names = {u.id: u.name for u, _ in roster}
    today0 = t.replace(hour=0, minute=0, second=0, microsecond=0)
    vf_today = sorted([s for s in vs if s.updated_at and s.updated_at >= today0 - timedelta(days=1)], key=lambda s: s.updated_at, reverse=True)[:5]
    # upcoming (next 10 days): calendar + due dates
    cal = (await db.execute(select(CalendarEvent).where(CalendarEvent.course_id.in_(cids), CalendarEvent.start >= today0,
                                                        CalendarEvent.kind.not_in(["due", "exam"]),
                                                        CalendarEvent.start <= t + timedelta(days=10)).order_by(CalendarEvent.start).limit(8))).scalars().all() if cids else []
    due = (await db.execute(select(Assessment).where(Assessment.course_id.in_(cids), Assessment.due >= today0,
                                                     Assessment.due <= t + timedelta(days=30)).order_by(Assessment.due))).scalars().all() if cids else []
    code = {c.id: c.code for c in courses}
    upcoming = [{"kind": e.kind, "title": e.title, "at": iso(e.start), "location": e.location} for e in cal]
    upcoming += [{"kind": "exam" if a.type == "exam" else "due", "title": f"{code[a.course_id]} · {a.title}", "at": iso(a.due)} for a in due]
    upcoming.sort(key=lambda x: x["at"] or "")
    # recent activity
    act = []
    for sb, a in (await db.execute(select(Submission, Assessment).join(Assessment, Assessment.id == Submission.assessment_id)
                                   .where(Assessment.course_id.in_(cids), Submission.submitted_at.is_not(None))
                                   .order_by(Submission.submitted_at.desc()).limit(5))).all() if cids else []:
        act.append({"kind": "submission", "text": f"{names.get(sb.user_id, 'A student')} submitted {a.title}", "at": iso(sb.submitted_at), "link": "/l-grading"})
    for s in completed[-5:]:
        act.append({"kind": "vf", "text": f"{names.get(s.user_id, 'A student')} completed a virtual faculty lesson", "at": iso(s.ended_at), "link": "/vf-analytics"})
    threads = (await db.execute(select(Thread.id, Thread.subject).where(Thread.course_id.in_(cids)))).all() if cids else []
    if threads:
        tmap = dict(threads)
        for m in (await db.execute(select(Message).where(Message.thread_id.in_(list(tmap)), Message.author_id != user.id)
                                   .order_by(Message.created_at.desc()).limit(5))).scalars():
            act.append({"kind": "message", "text": f"{names.get(m.author_id, 'A student')} posted in “{tmap[m.thread_id]}”", "at": iso(m.created_at), "link": "/l-comms"})
    act.sort(key=lambda x: x["at"] or "", reverse=True)
    # per-course progress
    prog = dict((await db.execute(select(Enrolment.course_id, func.avg(Enrolment.progress)).where(Enrolment.course_id.in_(cids))
                                  .group_by(Enrolment.course_id))).all()) if cids else {}
    sizes = dict((await db.execute(select(Enrolment.course_id, func.count()).where(Enrolment.course_id.in_(cids)).group_by(Enrolment.course_id))).all()) if cids else {}
    # weekly active learners for the largest course
    trend = None
    if courses:
        from .lecturer_analytics import compute
        main = max(courses, key=lambda c: sizes.get(c.id, 0))
        a = await compute(db, main.id, weeks=6)
        trend = {"course": main.code, "weeks": a["weeks"], "active": a["weekly_active"]}
    return {
        "trend": trend,
        "me": {"name": user.name, "title": user.title, "faculty": fac.name if fac else None},
        "courses": [{"id": c.id, "code": c.code, "title": c.title, "students": sizes.get(c.id, 0), "progress": round(float(prog.get(c.id) or 0)),
                     "status": c.status, "vf_enabled": c.vf_enabled} for c in courses],
        "kpis": {"courses": len(courses), "students": len(students), "to_grade": len(pend_rows),
                 "to_grade_by": sorted(by_as.values(), key=lambda x: x["due"] or ""), "at_risk": len(follow), "avg": avg,
                 "vf_started": len(started), "vf_completed": len(completed),
                 "vf_completion": round(100 * len(completed) / len(started)) if started else None, "vf_first_try": first_ok,
                 "open_reviews": open_reviews},
        "follow_up": follow[:6],
        "vf_today": [{"id": s.id, "name": names.get(s.user_id, "Learner"), "status": s.status, "outcome": s.outcome or {},
                      "at": iso(s.updated_at)} for s in vf_today],
        "upcoming": upcoming[:8],
        "activity": act[:8],
    }


# ---------------------------------------------------------------- courses
def _course_out(c: Course, sizes: dict, prog: dict, counts: dict) -> dict:
    m = c.meta or {}
    return {"id": c.id, "code": c.code, "title": c.title, "description": c.description, "status": c.status, "vf_enabled": c.vf_enabled,
            "term": c.term, "credits": c.credits, "cover": c.cover, "outcomes": m.get("outcomes", []), "weeks": m.get("weeks"),
            "format": m.get("format"), "students": sizes.get(c.id, 0), "progress": round(float(prog.get(c.id) or 0)),
            "draft_modules": m.get("draft_modules", []), **counts.get(c.id, {})}


@router.get("/courses")
async def list_courses(db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    courses = await my_courses(db, user)
    cids = [c.id for c in courses]
    if not cids:
        return []
    sizes = dict((await db.execute(select(Enrolment.course_id, func.count()).where(Enrolment.course_id.in_(cids)).group_by(Enrolment.course_id))).all())
    prog = dict((await db.execute(select(Enrolment.course_id, func.avg(Enrolment.progress)).where(Enrolment.course_id.in_(cids)).group_by(Enrolment.course_id))).all())
    counts: dict[str, dict] = {c: {"modules": 0, "lessons": 0, "assessments": 0} for c in cids}
    for cid, n in (await db.execute(select(Module.course_id, func.count()).where(Module.course_id.in_(cids)).group_by(Module.course_id))).all():
        counts[cid]["modules"] = n
    for cid, n in (await db.execute(select(Lesson.course_id, func.count()).where(Lesson.course_id.in_(cids)).group_by(Lesson.course_id))).all():
        counts[cid]["lessons"] = n
    for cid, n in (await db.execute(select(Assessment.course_id, func.count()).where(Assessment.course_id.in_(cids)).group_by(Assessment.course_id))).all():
        counts[cid]["assessments"] = n
    return [_course_out(c, sizes, prog, counts) for c in courses]


@router.get("/courses/{cid}")
async def get_course(cid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, cid)
    sizes = dict((await db.execute(select(Enrolment.course_id, func.count()).where(Enrolment.course_id == cid).group_by(Enrolment.course_id))).all())
    prog = dict((await db.execute(select(Enrolment.course_id, func.avg(Enrolment.progress)).where(Enrolment.course_id == cid).group_by(Enrolment.course_id))).all())
    mods = (await db.execute(select(Module).where(Module.course_id == cid).order_by(Module.ord))).scalars().all()
    lessons = (await db.execute(select(Lesson).where(Lesson.course_id == cid).order_by(Lesson.id))).scalars().all()
    ass = (await db.execute(select(Assessment).where(Assessment.course_id == cid).order_by(Assessment.due))).scalars().all()
    out = _course_out(c, sizes, prog, {})
    out["modules"] = [{"id": m.id, "title": m.title, "ord": m.ord, "items": m.items or []} for m in mods]
    out["lessons"] = [{"id": l.id, "title": l.title, "status": l.status, "version": l.version} for l in lessons]
    out["assessments"] = [{"id": a.id, "title": a.title, "type": a.type, "status": a.status, "due": iso(a.due)} for a in ass]
    return out


class CourseIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=4000)
    status: str = Field(pattern="^(draft|published)$")
    vf_enabled: bool = False
    outcomes: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("title", "description")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("outcomes")
    @classmethod
    def outs(cls, v: list[str]) -> list[str]:
        v = [o.strip() for o in v if o.strip()]
        for o in v:
            if len(o) > 300:
                raise ValueError("Each outcome must be 300 characters or fewer.")
        return v


@router.patch("/courses/{cid}")
async def update_course(cid: str, body: CourseIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, cid)
    changes = []
    if body.title != c.title:
        changes.append("title")
    if body.description != (c.description or ""):
        changes.append("description")
    if body.status != c.status:
        changes.append(f"status {c.status} → {body.status}")
    if body.vf_enabled != c.vf_enabled:
        changes.append(f"virtual faculty {'on' if body.vf_enabled else 'off'}")
    if body.outcomes != (c.meta or {}).get("outcomes", []):
        changes.append("learning outcomes")
    c.title, c.description, c.status, c.vf_enabled = body.title, body.description, body.status, body.vf_enabled
    c.meta = {**(c.meta or {}), "outcomes": body.outcomes}
    if changes:
        await audit(db, user, "Updated course settings", "content", f"{c.code} {c.title}", detail={"changes": changes})
    await db.commit()
    return {"ok": True, "changes": changes}


ITEM_TYPES = {"virtual", "video", "reading", "quiz", "assignment"}


class ItemIn(BaseModel):
    id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    type: str
    title: str = Field(min_length=1, max_length=200)
    dur: int = Field(default=10, ge=1, le=600)
    vf: bool | None = None
    lesson_id: str | None = Field(default=None, max_length=32)
    assessment_id: str | None = Field(default=None, max_length=32)

    @field_validator("type")
    @classmethod
    def t(cls, v: str) -> str:
        if v not in ITEM_TYPES:
            raise ValueError(f"Item type must be one of {', '.join(sorted(ITEM_TYPES))}.")
        return v


class ModuleIn(BaseModel):
    id: str | None = Field(default=None, max_length=32)
    title: str = Field(min_length=1, max_length=200)
    published: bool = True
    items: list[ItemIn] = Field(default_factory=list, max_length=40)


class ModulesIn(BaseModel):
    modules: list[ModuleIn] = Field(max_length=30)


@router.put("/courses/{cid}/modules")
async def save_modules(cid: str, body: ModulesIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, cid)
    ids = [it.id for m in body.modules for it in m.items]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "Each lesson or activity can appear only once in the course outline.")
    existing = {m.id: m for m in (await db.execute(select(Module).where(Module.course_id == cid))).scalars()}
    keep, drafts = set(), []
    for i, m in enumerate(body.modules):
        mid = m.id if m.id and m.id in existing else None
        title = re.sub(r"^Module \d+\s*·\s*", "", m.title.strip())
        title = f"Module {i + 1} · {title}"
        items = [it.model_dump(exclude_none=True) for it in m.items]
        if mid:
            row = existing[mid]
            row.ord, row.title, row.items = i + 1, title, items
        else:
            mid = f"{cid}-m{len(existing) + i + 1}-{now().strftime('%H%M%S')}"[:32]
            db.add(Module(id=mid, course_id=cid, ord=i + 1, title=title, items=items))
        keep.add(mid)
        if not m.published:
            drafts.append(mid)
    removed = [m for k, m in existing.items() if k not in keep]
    for m in removed:
        await db.delete(m)
    c.meta = {**(c.meta or {}), "draft_modules": drafts}
    await audit(db, user, "Published course changes", "content", f"{c.code} course structure",
                detail={"modules": len(body.modules), "items": len(ids), "removed_modules": [m.title for m in removed], "draft_modules": len(drafts)})
    await db.commit()
    return {"ok": True}


@router.get("/courses/{cid}/roster")
async def roster(cid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    await owned_course(db, user, cid)
    rows = await enrolled_students(db, [cid])
    uids = [u.id for u, _ in rows]
    last = await last_active(db, uids)
    od = await overdue_counts(db, [cid])
    subs = (await db.execute(select(Submission.user_id, Submission.status, Submission.score, Assessment.max_score)
                             .join(Assessment, Assessment.id == Submission.assessment_id)
                             .where(Assessment.course_id == cid, Submission.user_id.in_(uids)))).all() if uids else []
    agg: dict[str, dict] = {}
    for uid, st, sc, mx in subs:
        a = agg.setdefault(uid, {"submitted": 0, "scores": []})
        if st in ("submitted", "graded", "published"):
            a["submitted"] += 1
        if st == "published" and sc is not None and mx:
            a["scores"].append(sc / mx * 100)
    lessons = [l for l in (await db.execute(select(Lesson.id).where(Lesson.course_id == cid))).scalars()]
    vf_done = dict((await db.execute(select(VFSession.user_id, func.count()).where(VFSession.lesson_id.in_(lessons), VFSession.status == "completed")
                                     .group_by(VFSession.user_id))).all()) if lessons else {}
    out = []
    for u, e in rows:
        a = agg.get(u.id, {"submitted": 0, "scores": []})
        out.append({"id": u.id, "name": u.name, "first": u.first, "student_no": u.student_no, "email": u.email, "year": u.year,
                    "progress": e.progress, "status": e.status, "last_active": iso(last.get(u.id)),
                    "submitted": a["submitted"], "avg": round(sum(a["scores"]) / len(a["scores"])) if a["scores"] else (u.risk or {}).get("avg"),
                    "vf_completed": vf_done.get(u.id, 0), "reasons": risk_reasons(u, od.get(u.id, 0), last.get(u.id))})
    return out
