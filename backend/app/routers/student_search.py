"""Role-aware global search: GET /api/search?q=  (courses, lessons, announcements, people).

Students: all published courses, lessons in enrolled courses, announcements they can see, staff.
Lecturers: their courses and lessons, their course + university announcements, students enrolled in their courses and staff.
Admins: everything."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.db import get_db
from ..core.deps import current_user
from ..models import Announcement, Course, Enrolment, Lesson, Module, User
from ._student_util import UNI_SCOPES, enrolled_ids, iso, visible_announcements

router = APIRouter(prefix="/api/search", tags=["search"])
LIMIT = 8


def _like(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("")
async def search(q: str = Query(min_length=2, max_length=100), db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    term = q.strip()
    if len(term) < 2:
        return {"q": term, "courses": [], "lessons": [], "announcements": [], "people": []}
    pat = _like(term)
    low = term.lower()

    # scope of courses
    if user.role == "student":
        mine = await enrolled_ids(db, user)
    elif user.role == "lecturer":
        mine = list((await db.execute(select(Course.id).where(Course.lecturer_id == user.id))).scalars())
    else:
        mine = None  # admin: all

    cq = select(Course).where(or_(Course.title.ilike(pat), Course.code.ilike(pat), Course.description.ilike(pat)))
    if user.role == "student":
        cq = cq.where(Course.status == "published")
    elif user.role == "lecturer":
        cq = cq.where(Course.id.in_(mine or ["-"]))
    courses = list((await db.execute(cq.order_by(Course.code).limit(LIMIT))).scalars())
    course_out = [{"id": c.id, "code": c.code, "title": c.title, "enrolled": mine is None or c.id in mine,
                   "link": (f"/s-course/{c.id}" if c.id in (mine or []) else "/s-catalogue") if user.role == "student" else
                   "/l-courses" if user.role == "lecturer" else "/a-structure"} for c in courses]

    # lessons: module items + virtual faculty lessons
    scope_ids = mine if mine is not None else list((await db.execute(select(Course.id))).scalars())
    codes = {c.id: c.code for c in (await db.execute(select(Course).where(Course.id.in_(scope_ids or ["-"])))).scalars()}
    lessons = []
    for m in (await db.execute(select(Module).where(Module.course_id.in_(scope_ids or ["-"])).order_by(Module.course_id, Module.ord))).scalars():
        for it in m.items or []:
            if low in (it.get("title") or "").lower() or low in m.title.lower():
                typ = it.get("type", "reading")
                if user.role == "student":
                    link = (f"/s-classroom/{it.get('lesson_id') or it.get('id')}" if it.get("vf") or typ == "virtual" else
                            f"/s-course/{m.course_id}" if typ in ("quiz", "assignment") else f"/s-lesson?course={m.course_id}&item={it.get('id')}")
                else:
                    link = "/l-editor" if user.role == "lecturer" else None
                lessons.append({"id": it.get("id"), "title": it.get("title"), "type": typ, "module": m.title, "course_code": codes.get(m.course_id), "link": link})
    seen = {(x["course_code"], x["id"]) for x in lessons}
    lq = select(Lesson).where(Lesson.course_id.in_(scope_ids or ["-"]), or_(Lesson.title.ilike(pat), Lesson.module.ilike(pat)))
    if user.role == "student":
        lq = lq.where(Lesson.status == "published")
    for l in (await db.execute(lq.limit(LIMIT))).scalars():
        if (codes.get(l.course_id), l.id) not in seen:
            lessons.append({"id": l.id, "title": l.title, "type": "virtual", "module": l.module, "course_code": codes.get(l.course_id),
                            "link": f"/s-classroom/{l.id}" if user.role == "student" else "/vf-config"})

    # announcements
    if user.role == "student":
        cond = visible_announcements(user, mine or [])
    elif user.role == "lecturer":
        cond = and_(Announcement.status == "published", or_(Announcement.scope.in_(UNI_SCOPES), Announcement.course_id.in_(mine or ["-"])))
    else:
        cond = Announcement.id.isnot(None)
    anns = (await db.execute(select(Announcement).where(cond, or_(Announcement.title.ilike(pat), Announcement.body.ilike(pat)))
                             .order_by(Announcement.created_at.desc()).limit(LIMIT))).scalars()
    ann_out = [{"id": a.id, "title": a.title, "body": a.body[:160], "at": iso(a.publish_at or a.created_at), "course_code": codes.get(a.course_id),
                "link": "/s-news" if user.role == "student" else "/l-comms" if user.role == "lecturer" else "/a-notices"} for a in anns]

    # people
    pq = select(User).where(User.status == "active", or_(User.name.ilike(pat), User.email.ilike(pat), User.title.ilike(pat)))
    if user.role == "student":
        pq = pq.where(User.role.in_(["lecturer", "admin"]))
    elif user.role == "lecturer":
        studs = select(Enrolment.user_id).where(Enrolment.course_id.in_(mine or ["-"]))
        pq = pq.where(or_(User.role.in_(["lecturer", "admin"]), User.id.in_(studs)))
    people = list((await db.execute(pq.order_by(User.name).limit(LIMIT))).scalars())
    teaches: dict[str, list[str]] = {}
    for c in (await db.execute(select(Course).where(Course.lecturer_id.in_([p.id for p in people] or ["-"])))).scalars():
        teaches.setdefault(c.lecturer_id, []).append(c.code)
    people_out = []
    for p in people:
        row = {"id": p.id, "name": p.name, "role": p.role, "title": p.title, "teaches": teaches.get(p.id, [])}
        if p.role != "student" or user.role != "student":
            row["email"] = p.email
        if p.role == "student":
            row["student_no"] = p.student_no
            row["link"] = "/a-directory" if user.role == "admin" else "/l-analytics"
        people_out.append(row)
    return {"q": term, "courses": course_out, "lessons": lessons[:LIMIT], "announcements": ann_out, "people": people_out}
