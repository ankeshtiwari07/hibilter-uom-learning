"""Lecturer communication (S20): course announcements (now or scheduled), course question threads, private messages to
groups of students (all / flagged for follow-up / not yet submitted / individuals) and assessment reminder schedules."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Announcement, AnnouncementRead, Assessment, Course, Enrolment, Message, Submission, Thread, User
from ._lecturer_common import iso, last_active, my_course_ids, now, overdue_counts, owned_assessment, owned_course, risk_reasons

router = APIRouter(prefix="/api/lecturer/comms", tags=["lecturer-comms"])
LECT = require("lecturer")


async def promote_scheduled(db: AsyncSession):
    """Scheduled announcements whose time has come become visible (status 'published')."""
    await db.execute(update(Announcement).where(Announcement.status == "scheduled", Announcement.publish_at <= now()).values(status="published"))


@router.get("/announcements")
async def announcements(db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    await promote_scheduled(db)
    await db.commit()
    cids = await my_course_ids(db, user)
    if not cids:
        return []
    code = dict((await db.execute(select(Course.id, Course.code).where(Course.id.in_(cids)))).all())
    rows = (await db.execute(select(Announcement).where(Announcement.course_id.in_(cids), Announcement.status != "withdrawn")
                             .order_by(func.coalesce(Announcement.publish_at, Announcement.created_at).desc()).limit(40))).scalars().all()
    reads = dict((await db.execute(select(AnnouncementRead.announcement_id, func.count()).where(AnnouncementRead.announcement_id.in_([a.id for a in rows]))
                                   .group_by(AnnouncementRead.announcement_id))).all()) if rows else {}
    sizes = dict((await db.execute(select(Enrolment.course_id, func.count()).where(Enrolment.course_id.in_(cids)).group_by(Enrolment.course_id))).all())
    return [{"id": a.id, "course_id": a.course_id, "course_code": code.get(a.course_id), "title": a.title, "body": a.body, "priority": a.priority,
             "status": a.status, "publish_at": iso(a.publish_at or a.created_at), "mine": a.author_id == user.id,
             "reads": reads.get(a.id, 0), "audience": sizes.get(a.course_id, 0)} for a in rows]


class AnnIn(BaseModel):
    course_id: str = Field(max_length=32)
    title: str = Field(min_length=3, max_length=300)
    body: str = Field(min_length=10, max_length=5000)
    priority: Literal["normal", "high"] = "normal"
    publish_at: datetime | None = None


@router.post("/announcements")
async def post_announcement(body: AnnIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, body.course_id)
    t = now()
    when = body.publish_at
    if when and when.tzinfo is None:
        raise HTTPException(422, "Include a timezone with the scheduled time.")
    scheduled = bool(when and when > t)
    if when and (when - t).days > 180:
        raise HTTPException(422, "Schedule no more than six months ahead.")
    a = Announcement(scope="course", course_id=c.id, author_id=user.id, title=body.title.strip(), body=body.body.strip(), priority=body.priority,
                     publish_at=when if scheduled else t, status="scheduled" if scheduled else "published")
    db.add(a)
    await audit(db, user, "Scheduled announcement" if scheduled else "Posted announcement", "content", f"{c.code} · {a.title}",
                detail={"publish_at": iso(a.publish_at)})
    await db.commit()
    return {"id": a.id, "status": a.status, "publish_at": iso(a.publish_at)}


@router.delete("/announcements/{aid}")
async def withdraw(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    a = await db.get(Announcement, aid)
    if not a or not a.course_id:
        raise HTTPException(404, "Announcement not found")
    c = await owned_course(db, user, a.course_id)
    a.status = "withdrawn"
    await audit(db, user, "Withdrew announcement", "content", f"{c.code} · {a.title}")
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- threads
@router.get("/threads")
async def threads(db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    cids = await my_course_ids(db, user)
    code = dict((await db.execute(select(Course.id, Course.code).where(Course.id.in_(cids)))).all()) if cids else {}
    rows = (await db.execute(select(Thread).where(Thread.course_id.in_(cids)) if cids else select(Thread).where(False))).scalars().all()
    ids = [t.id for t in rows]
    if not ids:
        return []
    msgs = (await db.execute(select(Message).where(Message.thread_id.in_(ids)).order_by(Message.created_at))).scalars().all()
    authors = {u.id: u for u in (await db.execute(select(User).where(User.id.in_({m.author_id for m in msgs})))).scalars()}
    by: dict[str, list] = {}
    for m in msgs:
        by.setdefault(m.thread_id, []).append(m)
    out = []
    for t in rows:
        ms = by.get(t.id, [])
        first, lastm = (ms[0] if ms else None), (ms[-1] if ms else None)
        private = len(t.participants or []) > 0
        out.append({"id": t.id, "course_id": t.course_id, "course_code": code.get(t.course_id), "subject": t.subject, "private": private,
                    "by": authors[first.author_id].name if first and first.author_id in authors else None,
                    "replies": max(0, len(ms) - 1), "last_at": iso(lastm.created_at if lastm else t.created_at),
                    "needs_reply": bool(lastm and authors.get(lastm.author_id) and authors[lastm.author_id].role == "student")})
    out.sort(key=lambda x: x["last_at"] or "", reverse=True)
    return out


@router.get("/threads/{tid}")
async def thread(tid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    t = await db.get(Thread, tid)
    if not t or not t.course_id:
        raise HTTPException(404, "Thread not found")
    await owned_course(db, user, t.course_id)
    msgs = (await db.execute(select(Message, User).join(User, User.id == Message.author_id).where(Message.thread_id == tid)
                             .order_by(Message.created_at))).all()
    return {"id": t.id, "subject": t.subject, "course_id": t.course_id,
            "messages": [{"id": m.id, "body": m.body, "at": iso(m.created_at), "author": u.name, "role": u.role, "mine": u.id == user.id} for m, u in msgs]}


class ReplyIn(BaseModel):
    body: str = Field(min_length=2, max_length=5000)


@router.post("/threads/{tid}/messages")
async def reply(tid: str, body: ReplyIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    t = await db.get(Thread, tid)
    if not t or not t.course_id:
        raise HTTPException(404, "Thread not found")
    await owned_course(db, user, t.course_id)
    m = Message(thread_id=tid, author_id=user.id, body=body.body.strip())
    db.add(m)
    await db.commit()
    return {"id": m.id}


# ---------------------------------------------------------------- group messages
async def audience(db: AsyncSession, c: Course, kind: str, assessment_id: str | None, user_ids: list[str] | None) -> list[User]:
    students = (await db.execute(select(User).join(Enrolment, Enrolment.user_id == User.id).where(Enrolment.course_id == c.id, User.role == "student")
                                 .order_by(User.name))).scalars().all()
    if kind == "all":
        return list(students)
    if kind == "at_risk":
        ids = [u.id for u in students]
        last, od = await last_active(db, ids), await overdue_counts(db, [c.id])
        return [u for u in students if risk_reasons(u, od.get(u.id, 0), last.get(u.id))]
    if kind == "not_submitted":
        if not assessment_id:
            raise HTTPException(422, "Choose the assessment.")
        done = set((await db.execute(select(Submission.user_id).where(Submission.assessment_id == assessment_id,
                                                                      Submission.status.in_(["submitted", "graded", "published"])))).scalars())
        return [u for u in students if u.id not in done]
    want = set(user_ids or [])
    return [u for u in students if u.id in want]


@router.get("/audiences")
async def audiences(course_id: str, assessment_id: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, course_id)
    if assessment_id:
        a, _ = await owned_assessment(db, user, assessment_id)
        if a.course_id != c.id:
            raise HTTPException(422, "That assessment belongs to another course.")
    al = await audience(db, c, "all", None, None)
    risk = await audience(db, c, "at_risk", None, None)
    ns = await audience(db, c, "not_submitted", assessment_id, None) if assessment_id else []
    return {"all": len(al), "at_risk": len(risk), "not_submitted": len(ns),
            "students": [{"id": u.id, "name": u.name} for u in al], "at_risk_ids": [u.id for u in risk]}


class GroupMsgIn(BaseModel):
    course_id: str = Field(max_length=32)
    audience: Literal["all", "at_risk", "not_submitted", "individual"]
    assessment_id: str | None = Field(default=None, max_length=32)
    user_ids: list[str] | None = Field(default=None, max_length=500)
    subject: str = Field(min_length=3, max_length=300)
    body: str = Field(min_length=10, max_length=5000)


@router.post("/messages")
async def group_message(body: GroupMsgIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, body.course_id)
    if body.audience == "individual" and not body.user_ids:
        raise HTTPException(422, "Choose at least one student.")
    people = await audience(db, c, body.audience, body.assessment_id, body.user_ids)
    if not people:
        raise HTTPException(422, "No students match this group.")
    for p in people:
        t = Thread(course_id=c.id, subject=body.subject.strip(), participants=[user.id, p.id])
        db.add(t)
        await db.flush()
        db.add(Message(thread_id=t.id, author_id=user.id, body=body.body.strip().replace("{first name}", p.first)))
    await audit(db, user, "Messaged students", "content", f"{c.code} · {body.subject.strip()}", detail={"audience": body.audience, "recipients": len(people)})
    await db.commit()
    return {"ok": True, "sent": len(people)}


class ReminderIn(BaseModel):
    when: list[Literal["3d", "1d"]] = Field(max_length=2)


@router.get("/reminders")
async def reminders(db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    cids = await my_course_ids(db, user)
    if not cids:
        return []
    code = dict((await db.execute(select(Course.id, Course.code).where(Course.id.in_(cids)))).all())
    rows = (await db.execute(select(Assessment).where(Assessment.course_id.in_(cids), Assessment.status == "published", Assessment.due >= now())
                             .order_by(Assessment.due))).scalars().all()
    return [{"id": a.id, "title": a.title, "course_code": code[a.course_id], "due": iso(a.due), "reminders": (a.settings or {}).get("reminders", [])} for a in rows]


@router.put("/reminders/{aid}")
async def set_reminders(aid: str, body: ReminderIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    a, c = await owned_assessment(db, user, aid)
    a.settings = {**(a.settings or {}), "reminders": sorted(set(body.when))}
    await audit(db, user, "Scheduled assessment reminders", "content", f"{c.code} · {a.title}", detail={"when": a.settings["reminders"]})
    await db.commit()
    return {"ok": True, "reminders": a.settings["reminders"]}
