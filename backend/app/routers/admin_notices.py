"""Administrator: university/faculty notices and the academic calendar (S27).

Scope values follow the seeded data: 'uni' (university-wide) and 'faculty'. A notice whose publish_at is in the future
is shown as Scheduled; status 'draft' notices are never visible to learners; 'withdrawn' notices are kept for audit.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Announcement, AnnouncementRead, CalendarEvent, Faculty, User
from ._admin_common import now

router = APIRouter(prefix="/api/admin", tags=["admin-notices"])
ADMIN = Depends(require("admin"))
PRIORITIES = ("normal", "high", "urgent")
CAL_KINDS = ("uni", "exam", "due")


def _aware(d: datetime | None) -> datetime | None:
    if d and d.tzinfo is None:
        return d.replace(tzinfo=timezone.utc)
    return d


class NoticeIn(BaseModel):
    title: str = Field(min_length=3, max_length=300)
    body: str = Field(min_length=10, max_length=5000)
    scope: str = "uni"
    faculty_id: str | None = None
    priority: str = "normal"
    publish_at: datetime | None = None
    status: str = "published"

    @field_validator("title", "body")
    @classmethod
    def strip(cls, v):
        v = v.strip()
        if len(v) < 3:
            raise ValueError("Too short.")
        return v

    @field_validator("scope")
    @classmethod
    def sc(cls, v):
        if v not in ("uni", "faculty"):
            raise ValueError("Audience must be the whole university or one faculty.")
        return v

    @field_validator("priority")
    @classmethod
    def pr(cls, v):
        if v not in PRIORITIES:
            raise ValueError("Priority must be normal, high or urgent.")
        return v

    @field_validator("status")
    @classmethod
    def st(cls, v):
        if v not in ("draft", "published"):
            raise ValueError("Status must be draft or published.")
        return v


def _state(a: Announcement) -> str:
    if a.status != "published":
        return a.status
    return "scheduled" if a.publish_at and _aware(a.publish_at) > now() else "published"


def _out(a: Announcement, fac: dict, authors: dict, reads: dict) -> dict:
    return {"id": a.id, "title": a.title, "body": a.body, "scope": a.scope, "faculty_id": a.faculty_id,
            "audience": "All learners and staff" if a.scope == "uni" else fac.get(a.faculty_id, a.faculty_id or "Faculty"),
            "priority": a.priority, "publish_at": (a.publish_at or a.created_at).isoformat() if (a.publish_at or a.created_at) else None,
            "status": a.status, "state": _state(a), "author": authors.get(a.author_id), "reads": reads.get(a.id, 0),
            "created_at": a.created_at.isoformat() if a.created_at else None}


@router.get("/notices")
async def notices(state: str = Query("all", pattern="^(all|published|scheduled|draft|withdrawn)$"),
                  db: AsyncSession = Depends(get_db), _: User = ADMIN):
    rows = (await db.execute(select(Announcement).where(Announcement.scope.in_(["uni", "university", "faculty"]))
                             .order_by(func.coalesce(Announcement.publish_at, Announcement.created_at).desc()))).scalars().all()
    fac = dict((await db.execute(select(Faculty.id, Faculty.short))).all())
    authors = dict((await db.execute(select(User.id, User.name).where(User.role != "student"))).all())
    reads = dict((await db.execute(select(AnnouncementRead.announcement_id, func.count()).group_by(AnnouncementRead.announcement_id))).all())
    items = [_out(a, fac, authors, reads) for a in rows]
    if state != "all":
        items = [i for i in items if i["state"] == state]
    return {"items": items, "priorities": PRIORITIES}


async def _validate(db: AsyncSession, body: NoticeIn):
    if body.scope == "faculty":
        if not body.faculty_id or not await db.get(Faculty, body.faculty_id):
            raise HTTPException(422, "Choose the faculty this notice is for.")
    if body.publish_at and _aware(body.publish_at) > now().replace(year=now().year + 1):
        raise HTTPException(422, "Schedule notices no more than a year ahead.")


@router.post("/notices", status_code=201)
async def create_notice(body: NoticeIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _validate(db, body)
    at = _aware(body.publish_at) or now()
    a = Announcement(scope=body.scope, faculty_id=body.faculty_id if body.scope == "faculty" else None, author_id=user.id,
                     title=body.title, body=body.body, priority=body.priority, publish_at=at, status=body.status)
    db.add(a)
    verb = "Saved notice draft" if body.status == "draft" else ("Scheduled notice" if at > now() else "Published notice")
    await audit(db, user, verb, "content", body.title, detail={"scope": body.scope, "faculty": body.faculty_id, "publish_at": at.isoformat(),
                                                               "priority": body.priority})
    await db.commit()
    return {"id": a.id, "state": _state(a)}


@router.put("/notices/{nid}")
async def edit_notice(nid: str, body: NoticeIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    a = await db.get(Announcement, nid)
    if not a or a.scope not in ("uni", "university", "faculty"):
        raise HTTPException(404, "Notice not found.")
    await _validate(db, body)
    a.title, a.body, a.scope, a.priority, a.status = body.title, body.body, body.scope, body.priority, body.status
    a.faculty_id = body.faculty_id if body.scope == "faculty" else None
    a.publish_at = _aware(body.publish_at) or a.publish_at or now()
    await audit(db, user, "Edited notice", "content", a.title, detail={"state": _state(a)})
    await db.commit()
    return {"ok": True, "state": _state(a)}


@router.post("/notices/{nid}/withdraw")
async def withdraw(nid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    a = await db.get(Announcement, nid)
    if not a or a.scope not in ("uni", "university", "faculty"):
        raise HTTPException(404, "Notice not found.")
    a.status = "withdrawn"
    await audit(db, user, "Withdrew notice", "content", a.title)
    await db.commit()
    return {"ok": True}


@router.delete("/notices/{nid}")
async def delete_notice(nid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    a = await db.get(Announcement, nid)
    if not a or a.scope not in ("uni", "university", "faculty"):
        raise HTTPException(404, "Notice not found.")
    if _state(a) == "published":
        raise HTTPException(409, "Published notices can't be deleted — withdraw it instead so the record is kept.")
    await db.execute(delete(AnnouncementRead).where(AnnouncementRead.announcement_id == nid))
    await db.delete(a)
    await audit(db, user, "Deleted notice", "content", a.title)
    await db.commit()
    return {"ok": True}


# ---------- academic calendar ----------
class EventIn(BaseModel):
    title: str = Field(min_length=3, max_length=300)
    kind: str = "uni"
    start: datetime
    end: datetime | None = None
    location: str | None = Field(None, max_length=200)

    @field_validator("title")
    @classmethod
    def t(cls, v):
        v = v.strip()
        if len(v) < 3:
            raise ValueError("Name the event (at least 3 characters).")
        return v

    @field_validator("kind")
    @classmethod
    def k(cls, v):
        if v not in CAL_KINDS:
            raise ValueError("Type must be examination, deadline or university event.")
        return v


def _ev(e: CalendarEvent) -> dict:
    return {"id": e.id, "title": e.title, "kind": e.kind, "start": e.start.isoformat(), "end": e.end.isoformat() if e.end else None,
            "location": e.location, "course_id": e.course_id}


@router.get("/calendar")
async def calendar(past: bool = False, db: AsyncSession = Depends(get_db), _: User = ADMIN):
    q = select(CalendarEvent).where(or_(CalendarEvent.kind.in_(["uni", "exam"]),
                                        (CalendarEvent.kind == "due") & CalendarEvent.course_id.is_(None)))
    if not past:
        q = q.where(CalendarEvent.start >= now().replace(hour=0, minute=0, second=0, microsecond=0))
    rows = (await db.execute(q.order_by(CalendarEvent.start).limit(300))).scalars().all()
    return [_ev(e) for e in rows]


def _check_ev(body: EventIn):
    s, e = _aware(body.start), _aware(body.end)
    if e and e < s:
        raise HTTPException(422, "The event must end after it starts.")
    if s < now().replace(year=now().year - 2) or s > now().replace(year=now().year + 3):
        raise HTTPException(422, "Choose a date within the next three academic years.")
    return s, e


@router.post("/calendar", status_code=201)
async def add_event(body: EventIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    s, e = _check_ev(body)
    ev = CalendarEvent(kind=body.kind, title=body.title, start=s, end=e, location=(body.location or "").strip() or None)
    db.add(ev)
    await audit(db, user, "Added academic date", "content", f"{body.title} · {s.date().isoformat()}")
    await db.commit()
    return _ev(ev)


async def _get_ev(db, eid) -> CalendarEvent:
    ev = await db.get(CalendarEvent, eid)
    if not ev or ev.course_id or ev.kind not in CAL_KINDS:
        raise HTTPException(404, "Academic date not found (course dates are managed by lecturers).")
    return ev


@router.put("/calendar/{eid}")
async def edit_event(eid: str, body: EventIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    ev = await _get_ev(db, eid)
    s, e = _check_ev(body)
    ev.title, ev.kind, ev.start, ev.end, ev.location = body.title, body.kind, s, e, (body.location or "").strip() or None
    await audit(db, user, "Edited academic date", "content", f"{ev.title} · {s.date().isoformat()}")
    await db.commit()
    return _ev(ev)


@router.delete("/calendar/{eid}")
async def delete_event(eid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    ev = await _get_ev(db, eid)
    await db.delete(ev)
    await audit(db, user, "Removed academic date", "content", f"{ev.title} · {ev.start.date().isoformat()}")
    await db.commit()
    return {"ok": True}
