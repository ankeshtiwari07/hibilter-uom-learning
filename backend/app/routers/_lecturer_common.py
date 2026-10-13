"""Shared helpers for the lecturer portal routers (not a router itself: modules starting with "_" are not auto-registered)."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Assessment, Course, Enrolment, Event, Lesson, Submission, User, VFSession


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


async def my_courses(db: AsyncSession, user: User) -> list[Course]:
    q = select(Course).order_by(Course.code)
    if user.role != "admin":
        q = q.where(Course.lecturer_id == user.id)
    return list((await db.execute(q)).scalars())


async def my_course_ids(db: AsyncSession, user: User) -> list[str]:
    return [c.id for c in await my_courses(db, user)]


async def owned_course(db: AsyncSession, user: User, course_id: str) -> Course:
    c = await db.get(Course, course_id)
    if not c:
        raise HTTPException(404, "Course not found")
    if user.role != "admin" and c.lecturer_id != user.id:
        raise HTTPException(403, "You can only manage courses you teach.")
    return c


async def owned_lesson(db: AsyncSession, user: User, lesson_id: str) -> tuple[Lesson, Course]:
    lesson = await db.get(Lesson, lesson_id)
    if not lesson:
        raise HTTPException(404, "Lesson not found")
    return lesson, await owned_course(db, user, lesson.course_id)


async def owned_assessment(db: AsyncSession, user: User, aid: str) -> tuple[Assessment, Course]:
    a = await db.get(Assessment, aid)
    if not a:
        raise HTTPException(404, "Assessment not found")
    return a, await owned_course(db, user, a.course_id)


async def enrolled_students(db: AsyncSession, course_ids: list[str]) -> list[tuple[User, Enrolment]]:
    if not course_ids:
        return []
    rows = (await db.execute(select(User, Enrolment).join(Enrolment, Enrolment.user_id == User.id)
                             .where(Enrolment.course_id.in_(course_ids), User.role == "student")
                             .order_by(User.name))).all()
    return [(u, e) for u, e in rows]


async def last_active(db: AsyncSession, user_ids: list[str]) -> dict[str, datetime]:
    """Most recent real activity per learner: events, VF sessions, submissions, sign-ins."""
    out: dict[str, datetime] = {}
    if not user_ids:
        return out

    def bump(uid, ts):
        if uid and ts and (uid not in out or ts > out[uid]):
            out[uid] = ts

    for uid, ts in (await db.execute(select(Event.actor_id, func.max(Event.ts)).where(Event.actor_id.in_(user_ids)).group_by(Event.actor_id))).all():
        bump(uid, ts)
    for uid, ts in (await db.execute(select(VFSession.user_id, func.max(VFSession.updated_at)).where(VFSession.user_id.in_(user_ids)).group_by(VFSession.user_id))).all():
        bump(uid, ts)
    for uid, ts in (await db.execute(select(Submission.user_id, func.max(Submission.submitted_at)).where(Submission.user_id.in_(user_ids)).group_by(Submission.user_id))).all():
        bump(uid, ts)
    for uid, ts in (await db.execute(select(User.id, User.last_login_at).where(User.id.in_(user_ids)))).all():
        bump(uid, ts)
    return out


async def overdue_counts(db: AsyncSession, course_ids: list[str]) -> dict[str, int]:
    """Published assessments past their due date with no submission, per learner (only for courses given)."""
    if not course_ids:
        return {}
    t = now()
    due = list((await db.execute(select(Assessment).where(Assessment.course_id.in_(course_ids), Assessment.status == "published",
                                                         Assessment.due.is_not(None), Assessment.due < t))).scalars())
    if not due:
        return {}
    enrol = (await db.execute(select(Enrolment.user_id, Enrolment.course_id).where(Enrolment.course_id.in_(course_ids)))).all()
    done = set((await db.execute(select(Submission.user_id, Submission.assessment_id)
                                 .where(Submission.assessment_id.in_([a.id for a in due]),
                                        Submission.status.in_(["submitted", "graded", "published"])))).all())
    out: dict[str, int] = {}
    for uid, cid in enrol:
        for a in due:
            if a.course_id == cid and (uid, a.id) not in done:
                out[uid] = out.get(uid, 0) + 1
    return out


def risk_reasons(u: User, overdue: int, last: datetime | None) -> list[str]:
    """Support indicators for human review (rules from the concept demo) — not predictions."""
    r = u.risk or {}
    out = []
    od = max(int(r.get("overdue") or 0), overdue)
    if od >= 1:
        out.append(f"{od} overdue submission{'s' if od > 1 else ''}")
    act = r.get("activity")
    if act is not None and act < 35:
        out.append(f"low activity ({act}/100)")
    if last:
        days = (now() - last).days
        if days >= 9:
            out.append(f"inactive {days} days")
    avg = r.get("avg")
    if r.get("trend") == "down" and avg is not None and avg < 60:
        out.append(f"recent marks falling (avg {avg}%)")
    return out


def csv_bytes(rows: list[list]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    return buf.getvalue().encode("utf-8-sig")


def week_start(d: datetime) -> datetime:
    d = d.astimezone(timezone.utc)
    return (d - timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
