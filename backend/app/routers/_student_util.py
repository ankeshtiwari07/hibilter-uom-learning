"""Shared helpers for the student portal routers (not a router itself — underscore modules are skipped by main.py)."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import (Announcement, Assessment, Course, Enrolment, Event, Lesson, Module, Submission, User,
                      VFSession)

DONE_SUB = ("submitted", "graded", "published")
GRADED = ("published",)  # marks/feedback are visible to students only once published
LOCKED = ("graded", "published")  # lecturer has started (or finished) marking: no more changes
UNI_SCOPES = ("uni", "university")


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.isoformat()


async def enrolments(db: AsyncSession, user: User) -> list[Enrolment]:
    rows = list((await db.execute(select(Enrolment).where(Enrolment.user_id == user.id, Enrolment.status == "active")
                                  .order_by(Enrolment.id))).scalars())
    demo = demo_courses()
    return rows if demo is None else [e for e in rows if e.course_id in demo]


async def enrolled_ids(db: AsyncSession, user: User) -> list[str]:
    return [e.course_id for e in await enrolments(db, user)]


async def require_enrolled(db: AsyncSession, user: User, course_id: str) -> tuple[Course, Enrolment]:
    row = (await db.execute(select(Course, Enrolment).join(Enrolment, Enrolment.course_id == Course.id)
                            .where(Enrolment.user_id == user.id, Course.id == course_id, Enrolment.status == "active"))).first()
    if not row:
        raise HTTPException(403, "You're not enrolled in this course.")
    demo = demo_courses()
    if demo is not None and course_id not in demo:
        raise HTTPException(403, "This course isn't open in the demo yet.")
    return row[0], row[1]


def visible_announcements(user: User, course_ids: list[str]):
    """SQL condition for announcements a student may see."""
    t = now()
    return and_(Announcement.status.in_(("published", "scheduled")), or_(Announcement.publish_at.is_(None), Announcement.publish_at <= t),
                or_(Announcement.scope.in_(UNI_SCOPES), Announcement.course_id.in_(course_ids or ["-"]),
                    and_(Announcement.scope == "faculty", Announcement.faculty_id == user.faculty_id)))


# ---------- module items, assessment linking and completion ----------
_PREFIX = re.compile(r"^(quiz|assignment|lab|exam|test|reading|video)(\s*\d+)?\s*:\s*", re.I)


def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", _PREFIX.sub("", (t or "").strip().lower())).strip()


def link_assessment(item: dict, assessments: list[Assessment]) -> Assessment | None:
    """Module items of type quiz/assignment link to an Assessment by explicit id, else by normalised title."""
    if item.get("type") not in ("quiz", "assignment", "lab", "exam"):
        return None
    aid = item.get("assessment_id")
    if aid:
        return next((a for a in assessments if a.id == aid), None)
    n = _norm(item.get("title", ""))
    if not n:
        return None
    for a in assessments:
        an = _norm(a.title)
        if an and (an == n or an in n or n in an):
            return a
    return None


async def course_modules(db: AsyncSession, course_ids: list[str]) -> dict[str, list[Module]]:
    out: dict[str, list[Module]] = {c: [] for c in course_ids}
    if not course_ids:
        return out
    for m in (await db.execute(select(Module).where(Module.course_id.in_(course_ids)).order_by(Module.course_id, Module.ord))).scalars():
        out.setdefault(m.course_id, []).append(m)
    return out


def studio_only() -> bool:
    """Demo mode (STUDIO_ONLY=1): only lectures with a published studio video can be opened; the rest show as coming soon."""
    return os.environ.get("STUDIO_ONLY") == "1"


def demo_courses() -> set[str] | None:
    """In demo mode, the courses students can see: those with at least one published studio video. None = no restriction."""
    if not studio_only():
        return None
    from ..core.config import get_settings
    root = Path(get_settings().media_dir) / "studio" / "out"
    try:
        return {c.name for c in root.iterdir() if c.is_dir() and any(production_manifest(c.name, i.name) for i in c.iterdir() if i.is_dir())}
    except OSError:
        return set()


def production_manifest(course_id: str, item_id: str) -> dict | None:
    """The published studio video for a lecture (app.studio), if any."""
    from ..core.config import get_settings
    p = Path(get_settings().media_dir) / "studio" / "out" / course_id / item_id / "current.json"
    try:
        m = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return m if m.get("video_url") and not m.get("draft") else None


async def item_states(db: AsyncSession, user: User, course_ids: list[str]) -> dict:
    """Completion state per module item for the user, for many courses in a few queries.

    Returns {"items": {course_id: [item dicts with status/link/module]}, "progress": {course_id: pct}}."""
    mods = await course_modules(db, course_ids)
    assess = list((await db.execute(select(Assessment).where(Assessment.course_id.in_(course_ids or ["-"]),
                                                             Assessment.status == "published"))).scalars())
    subs = {}
    if assess:
        for s in (await db.execute(select(Submission).where(Submission.user_id == user.id,
                                                            Submission.assessment_id.in_([a.id for a in assess])))).scalars():
            cur = subs.get(s.assessment_id)
            rank = {"draft": 0, "submitted": 1, "graded": 2, "published": 3}
            if not cur or rank.get(s.status, 0) > rank.get(cur.status, 0):
                subs[s.assessment_id] = s
    lessons = {l.id: l for l in (await db.execute(select(Lesson).where(Lesson.course_id.in_(course_ids or ["-"])))).scalars()}
    vf: dict[str, VFSession] = {}  # latest session per lesson
    vf_done: set[str] = set()
    if lessons:
        for s in (await db.execute(select(VFSession).where(VFSession.user_id == user.id, VFSession.lesson_id.in_(list(lessons)))
                                   .order_by(VFSession.updated_at))).scalars():
            vf[s.lesson_id] = s
            if s.status == "completed":
                vf_done.add(s.lesson_id)
    lp = {}
    for e in (await db.execute(select(Event).where(Event.actor_id == user.id, Event.type == "lesson_progress",
                                                   Event.course_id.in_(course_ids or ["-"])).order_by(Event.id))).scalars():
        k = (e.course_id, (e.payload or {}).get("item_id"))
        st = lp.get(k, {"done": False, "pos": 0, "at": None})
        lp[k] = {"done": st["done"] or bool((e.payload or {}).get("done")), "pos": (e.payload or {}).get("pos", st["pos"]), "at": iso(e.ts)}
    items: dict[str, list[dict]] = {}
    prog: dict[str, int] = {}
    for cid in course_ids:
        cas = [a for a in assess if a.course_id == cid]
        out = []
        for m in mods.get(cid, []):
            for it in (m.items or []):
                typ = it.get("type", "reading")
                d = {"id": it.get("id"), "title": it.get("title", ""), "type": typ, "dur": it.get("dur"), "module": m.title,
                     "module_id": m.id, "vf": bool(it.get("vf")) or typ == "virtual", "status": "todo", "link": None}
                if d["vf"]:
                    lid = it.get("lesson_id") or it.get("id")
                    les = lessons.get(lid)
                    d["lesson_id"] = lid if les else None
                    d["link"] = f"/s-classroom/{lid}" if les and les.status == "published" and not studio_only() else None
                    if studio_only():
                        d["soon"] = True  # demo: interactive lessons still use the animated-portrait lecturer
                    if lid in vf_done:
                        d["status"] = "done"
                    elif lid in vf:
                        d["status"] = "progress"
                elif typ in ("quiz", "assignment", "lab", "exam"):
                    a = link_assessment(it, cas)
                    d["assessment_id"] = a.id if a else None
                    if a:
                        d["link"] = f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}"
                        s = subs.get(a.id)
                        if s:
                            d["status"] = "done" if s.status in DONE_SUB else "progress"
                elif typ == "video" and studio_only() and not production_manifest(cid, it.get("id")):
                    d["soon"] = True  # demo: lecture video not produced yet
                else:
                    d["link"] = f"/s-lesson?course={cid}&item={it.get('id')}"
                    st = lp.get((cid, it.get("id")))
                    if st:
                        d["status"] = "done" if st["done"] else "progress"
                        d["pos"] = st["pos"]
                out.append(d)
        items[cid] = out
        prog[cid] = round(100 * sum(1 for x in out if x["status"] == "done") / len(out)) if out else 0
    return {"items": items, "progress": prog, "subs": subs, "assessments": assess, "vf": vf, "vf_done": vf_done, "lessons": lessons}


async def sync_progress(db: AsyncSession, user: User, course_id: str) -> int:
    """Recompute completion for one course and raise Enrolment.progress (never lowers recorded progress)."""
    st = await item_states(db, user, [course_id])
    pct = st["progress"].get(course_id, 0)
    e = (await db.execute(select(Enrolment).where(Enrolment.user_id == user.id, Enrolment.course_id == course_id))).scalar_one_or_none()
    if e and pct > (e.progress or 0):
        e.progress = pct
    return e.progress if e else pct


async def staff_names(db: AsyncSession, ids) -> dict[str, User]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {u.id: u for u in (await db.execute(select(User).where(User.id.in_(ids)))).scalars()}


def set_pref(user: User, key: str, value):
    """JSON column: assign a new dict so SQLAlchemy sees the change."""
    p = dict(user.prefs or {})
    p[key] = value
    user.prefs = p
