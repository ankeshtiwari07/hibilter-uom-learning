"""Student portal: announcements & discussions (S11), timetable (S10), support (S12), profile & privacy (S13)."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import (FAQ, Announcement, AnnouncementRead, Assessment, CalendarEvent, Course, Enrolment, Faculty, Message,
                      Programme, SupportTicket, Thread, User)
from ..services.assistant import bm25
from ._student_util import UNI_SCOPES, demo_courses, enrolled_ids, enrolments, iso, now, require_enrolled, set_pref, staff_names, visible_announcements

router = APIRouter(prefix="/api/student", tags=["student"])
student = require("student")


# ---------------- announcements ----------------
@router.get("/announcements")
async def announcements(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    read = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    rows = list((await db.execute(select(Announcement).where(visible_announcements(user, cids))
                                  .order_by(func.coalesce(Announcement.publish_at, Announcement.created_at).desc()).limit(200))).scalars())
    authors = await staff_names(db, [a.author_id for a in rows])
    fac = await db.get(Faculty, user.faculty_id) if user.faculty_id else None
    return [{"id": a.id, "scope": "university" if a.scope in UNI_SCOPES else a.scope, "title": a.title, "body": a.body, "priority": a.priority,
             "course_id": a.course_id, "course_code": courses[a.course_id].code if a.course_id in courses else None,
             "faculty": fac.short if a.scope == "faculty" and fac else None,
             "by": authors[a.author_id].name if a.author_id in authors else "University administration",
             "at": iso(a.publish_at or a.created_at), "unread": a.id not in read} for a in rows]


async def _mark(db: AsyncSession, user: User, ids: list[str]):
    have = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    for aid in ids:
        if aid not in have:
            db.add(AnnouncementRead(announcement_id=aid, user_id=user.id))


@router.post("/announcements/{ann_id}/read")
async def read_one(ann_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    ok = (await db.execute(select(Announcement.id).where(Announcement.id == ann_id, visible_announcements(user, cids)))).scalar_one_or_none()
    if not ok:
        raise HTTPException(404, "Announcement not found")
    await _mark(db, user, [ann_id])
    await db.commit()
    return {"ok": True}


@router.post("/announcements/read-all")
async def read_all(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    ids = list((await db.execute(select(Announcement.id).where(visible_announcements(user, cids)))).scalars())
    await _mark(db, user, ids)
    await db.commit()
    return {"ok": True, "count": len(ids)}


# ---------------- discussions & messages ----------------
async def thread_rows(db: AsyncSession, user: User, course_ids: list[str], private: bool) -> list[dict]:
    """Course discussion threads (participants == []) or the user's private message threads (participants lists user ids)."""
    if not course_ids:
        return []
    threads = list((await db.execute(select(Thread).where(Thread.course_id.in_(course_ids)).order_by(Thread.created_at.desc()))).scalars())
    threads = [t for t in threads if (bool(t.participants) == private) and (not private or user.id in (t.participants or []))]
    if not threads:
        return []
    msgs = list((await db.execute(select(Message).where(Message.thread_id.in_([t.id for t in threads])).order_by(Message.id))).scalars())
    people = await staff_names(db, [m.author_id for m in msgs] + [p for t in threads for p in (t.participants or [])])
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(course_ids)))).scalars()}
    by_t: dict[str, list[Message]] = {}
    for m in msgs:
        by_t.setdefault(m.thread_id, []).append(m)
    out = []
    for t in threads:
        ms = by_t.get(t.id, [])
        first = ms[0] if ms else None
        staff_reply = any(people.get(m.author_id) and people[m.author_id].role in ("lecturer", "admin") for m in ms)
        other = next((people[p] for p in (t.participants or []) if p != user.id and p in people), None)
        last = ms[-1] if ms else None
        out.append({"id": t.id, "subject": t.subject, "course_id": t.course_id, "course_code": courses[t.course_id].code if t.course_id in courses else None,
                    "by": people[first.author_id].name if first and first.author_id in people else None,
                    "replies": max(0, len(ms) - 1), "last_at": iso(last.created_at if last else t.created_at),
                    "last": (last.body[:160] if last else ""), "last_by": people[last.author_id].name if last and last.author_id in people else None,
                    "answered": staff_reply, "with": other.name if other else None, "mine": bool(first and first.author_id == user.id)})
    out.sort(key=lambda x: x["last_at"] or "", reverse=True)
    return out


@router.get("/threads")
async def threads(course_id: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    if course_id:
        if course_id not in cids:
            raise HTTPException(403, "You're not enrolled in this course.")
        cids = [course_id]
    return await thread_rows(db, user, cids, private=False)


@router.get("/messages")
async def messages(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    rows = await thread_rows(db, user, cids, private=True)
    ens = await enrolments(db, user)
    courses = list((await db.execute(select(Course).where(Course.id.in_([e.course_id for e in ens] or ["-"])))).scalars())
    lec = await staff_names(db, [c.lecturer_id for c in courses])
    recipients = [{"course_id": c.id, "course_code": c.code, "lecturer_id": c.lecturer_id, "lecturer": lec[c.lecturer_id].name}
                  for c in courses if c.lecturer_id in lec]
    return {"threads": rows, "recipients": recipients}


async def _thread_for(db: AsyncSession, user: User, thread_id: str) -> Thread:
    t = await db.get(Thread, thread_id)
    if not t or not t.course_id:
        raise HTTPException(404, "Thread not found")
    cids = await enrolled_ids(db, user)
    if t.course_id not in cids or (t.participants and user.id not in t.participants):
        raise HTTPException(404, "Thread not found")
    return t


@router.get("/threads/{thread_id}")
async def thread_detail(thread_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    t = await _thread_for(db, user, thread_id)
    ms = list((await db.execute(select(Message).where(Message.thread_id == t.id).order_by(Message.id))).scalars())
    people = await staff_names(db, [m.author_id for m in ms])
    c = await db.get(Course, t.course_id)
    return {"id": t.id, "subject": t.subject, "course_id": t.course_id, "course_code": c.code if c else None, "private": bool(t.participants),
            "messages": [{"id": m.id, "body": m.body, "at": iso(m.created_at), "by": people[m.author_id].name if m.author_id in people else "Unknown",
                          "role": people[m.author_id].role if m.author_id in people else None, "mine": m.author_id == user.id} for m in ms]}


class ThreadIn(BaseModel):
    course_id: str = Field(min_length=1, max_length=32)
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=2, max_length=5000)

    @field_validator("subject", "body")
    @classmethod
    def strip(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Too short")
        return v


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


@router.post("/threads")
async def new_thread(body: ThreadIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    await require_enrolled(db, user, body.course_id)
    t = Thread(course_id=body.course_id, subject=body.subject, participants=[])
    db.add(t)
    await db.flush()
    db.add(Message(thread_id=t.id, author_id=user.id, body=body.body))
    await db.commit()
    return {"id": t.id}


@router.post("/messages")
async def new_message(body: ThreadIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Private message to the lecturer of an enrolled course (a Thread whose participants are the two people)."""
    c, _ = await require_enrolled(db, user, body.course_id)
    if not c.lecturer_id:
        raise HTTPException(422, "This course has no lecturer assigned yet. Use Support instead.")
    t = Thread(course_id=c.id, subject=body.subject, participants=[user.id, c.lecturer_id])
    db.add(t)
    await db.flush()
    db.add(Message(thread_id=t.id, author_id=user.id, body=body.body))
    await db.commit()
    return {"id": t.id}


@router.post("/threads/{thread_id}/messages")
async def reply(thread_id: str, body: ReplyIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    t = await _thread_for(db, user, thread_id)
    text = body.body.strip()
    if not text:
        raise HTTPException(422, "Write a reply first.")
    m = Message(thread_id=t.id, author_id=user.id, body=text)
    db.add(m)
    await db.commit()
    return {"id": m.id, "body": m.body, "at": iso(m.created_at), "by": user.name, "role": user.role, "mine": True}


# ---------------- calendar ----------------
async def _calendar(db: AsyncSession, user: User, start: datetime, end: datetime) -> list[dict]:
    cids = await enrolled_ids(db, user)
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    rows = list((await db.execute(select(CalendarEvent).where(CalendarEvent.start >= start, CalendarEvent.start < end,
                                                              (CalendarEvent.course_id.in_(cids or ["-"])) | CalendarEvent.course_id.is_(None))
                                  .order_by(CalendarEvent.start))).scalars())
    rem = set((user.prefs or {}).get("student.reminders") or [])
    out = [{"id": e.id, "kind": e.kind, "title": e.title, "start": iso(e.start), "end": iso(e.end), "location": e.location,
            "course_id": e.course_id, "course_code": courses[e.course_id].code if e.course_id in courses else None,
            "source": "timetable", "reminder": e.id in rem} for e in rows]
    # assessment due dates appear automatically unless the timetable already carries the same deadline
    have = {(e.course_id, e.start) for e in rows if e.kind in ("due", "exam")}
    for a in (await db.execute(select(Assessment).where(Assessment.course_id.in_(cids or ["-"]), Assessment.status == "published",
                                                        Assessment.due >= start, Assessment.due < end))).scalars():
        if (a.course_id, a.due) in have:
            continue
        eid = f"as-{a.id}"
        out.append({"id": eid, "kind": "exam" if a.type == "exam" else "due", "title": f"{a.title} ({courses[a.course_id].code})", "start": iso(a.due),
                    "end": None, "location": None, "course_id": a.course_id, "course_code": courses[a.course_id].code, "source": "assessment",
                    "assessment_id": a.id, "link": f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}" if a.type in ("assignment", "lab") else None,
                    "reminder": eid in rem})
    out.sort(key=lambda x: x["start"])
    return out


def _range(start: str | None, end: str | None) -> tuple[datetime, datetime]:
    try:
        s = datetime.fromisoformat(start) if start else now() - timedelta(days=45)
        e = datetime.fromisoformat(end) if end else now() + timedelta(days=90)
    except ValueError:
        raise HTTPException(422, "Use ISO dates, for example 2026-10-01.")
    s = s if s.tzinfo else s.replace(tzinfo=timezone.utc)
    e = e if e.tzinfo else e.replace(tzinfo=timezone.utc)
    if e <= s or e - s > timedelta(days=400):
        raise HTTPException(422, "Choose a range of up to 400 days.")
    return s, e


@router.get("/calendar")
async def calendar(start: str | None = None, end: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    s, e = _range(start, end)
    return await _calendar(db, user, s, e)


class ReminderIn(BaseModel):
    on: bool


@router.put("/calendar/reminders/{event_id}")
async def reminder(event_id: str, body: ReminderIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", event_id):
        raise HTTPException(422, "Unknown event")
    if event_id.startswith("as-"):
        a = await db.get(Assessment, event_id[3:])
        if not a or a.course_id not in await enrolled_ids(db, user):
            raise HTTPException(404, "Event not found")
    else:
        e = await db.get(CalendarEvent, event_id)
        if not e or (e.course_id and e.course_id not in await enrolled_ids(db, user)):
            raise HTTPException(404, "Event not found")
    rem = [x for x in ((user.prefs or {}).get("student.reminders") or []) if x != event_id]
    if body.on:
        rem.append(event_id)
    set_pref(user, "student.reminders", rem[-200:])
    await db.commit()
    return {"ok": True, "on": body.on}


def _ics_text(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@router.get("/calendar.ics")
async def calendar_ics(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    s, e = now() - timedelta(days=30), now() + timedelta(days=180)
    evs = await _calendar(db, user, s, e)
    fmt = lambda iso_s: datetime.fromisoformat(iso_s).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stamp = now().strftime("%Y%m%dT%H%M%SZ")
    kind = {"cls": "Class", "due": "Deadline", "exam": "Examination", "uni": "University event", "vf": "Virtual lesson"}
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hibilter x UoM//UoM Learning//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:UoM Learning timetable"]
    for ev in evs:
        st = datetime.fromisoformat(ev["start"])
        en = datetime.fromisoformat(ev["end"]) if ev["end"] else st + timedelta(minutes=30)
        lines += ["BEGIN:VEVENT", f"UID:{ev['id']}@uom-learning", f"DTSTAMP:{stamp}", f"DTSTART:{fmt(st.isoformat())}", f"DTEND:{fmt(en.isoformat())}",
                  f"SUMMARY:{_ics_text(ev['title'])}", f"CATEGORIES:{kind.get(ev['kind'], 'Event')}"]
        if ev.get("location"):
            lines.append(f"LOCATION:{_ics_text(ev['location'])}")
        if ev.get("reminder"):
            lines += ["BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_text(ev['title'])}", "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    await audit(db, user, "Exported calendar", "export", "Own timetable (.ics)", detail={"events": len(evs)})
    await db.commit()
    return Response("\r\n".join(lines) + "\r\n", media_type="text/calendar",
                    headers={"Content-Disposition": 'attachment; filename="uom-timetable.ics"', "Cache-Control": "no-store"})


# ---------------- support ----------------
CATEGORIES = ["Academic", "Technical", "Accessibility", "Wellbeing", "Fees & administration", "Enrolment"]
ROUTE = {"Technical": "IT Helpdesk", "Academic": "programme coordinator", "Enrolment": "programme coordinator",
         "Accessibility": "Special Needs support office", "Fees & administration": "Academic office"}


async def new_ticket_id(db: AsyncSession) -> str:
    ids = (await db.execute(select(SupportTicket.id).where(SupportTicket.id.like("SR-%")))).scalars()
    n = max([int(i[3:]) for i in ids if i[3:].isdigit()] or [1059])
    return f"SR-{n + 1}"


@router.get("/support/faq")
async def faq(q: str = Query(default="", max_length=200), db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    rows = list((await db.execute(select(FAQ).order_by(FAQ.id))).scalars())
    if q.strip():
        ql = q.strip().lower()
        rows = [f for f in rows if ql in (f.q + " " + f.a + " " + f.category).lower()] or \
            [f for f, s in sorted(zip(rows, bm25(q, [f.q + " " + f.a for f in rows])), key=lambda x: -x[1]) if s > 0.8]
    return [{"id": f.id, "q": f.q, "a": f.a, "category": f.category} for f in rows]


class AskIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)


@router.post("/support/ask")
async def support_ask(body: AskIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Support assistant: answers only from the FAQ (with the FAQ cited); otherwise routes to a person."""
    rows = list((await db.execute(select(FAQ))).scalars())
    scores = bm25(body.q, [f.q + " " + f.q + " " + f.a for f in rows]) if rows else []
    best = max(zip(scores, rows), key=lambda x: x[0], default=(0, None))
    if best[1] is not None and best[0] >= 1.2:
        f = best[1]
        return {"found": True, "answer": f.a, "source": f.q, "faq_id": f.id}
    return {"found": False, "answer": "I’m not certain about that one, so I won’t guess. Use “Talk to a person” and a member of staff will help.", "source": None}


@router.get("/support/tickets")
async def tickets(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    rows = (await db.execute(select(SupportTicket).where(SupportTicket.user_id == user.id).order_by(SupportTicket.created_at.desc()))).scalars()
    return [{"id": t.id, "category": t.category, "subject": t.subject, "body": t.body, "status": t.status, "at": iso(t.created_at),
             "updates": [u for u in (t.updates or []) if isinstance(u, dict)]} for t in rows]


class TicketIn(BaseModel):
    category: str
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=20, max_length=5000)
    course_id: str | None = Field(default=None, max_length=32)

    @field_validator("category")
    @classmethod
    def cat(cls, v: str) -> str:
        if v not in CATEGORIES:
            raise ValueError("Choose a category.")
        return v

    @field_validator("subject")
    @classmethod
    def subj(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 3:
            raise ValueError("Add a subject.")
        return v

    @field_validator("body")
    @classmethod
    def bod(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 20:
            raise ValueError("Describe your request in at least 20 characters.")
        return v


@router.post("/support/tickets")
async def create_ticket(body: TicketIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    code = None
    if body.course_id:
        c, _ = await require_enrolled(db, user, body.course_id)
        code = c.code
    to = ROUTE.get(body.category, "Student Welfare Office")
    upd = {"at": iso(now()), "text": f"Routed to {to}. Typical first response: 2 working days."}
    if body.course_id:
        upd["course_id"] = body.course_id
    for _ in range(3):
        tid = await new_ticket_id(db)
        db.add(SupportTicket(id=tid, user_id=user.id, category=body.category, subject=(f"[{code}] " if code else "") + body.subject,
                             body=body.body, status="open", updates=[upd]))
        try:
            await db.commit()
            return {"id": tid, "status": "open", "routed_to": to}
        except IntegrityError:
            await db.rollback()
    raise HTTPException(503, "Couldn’t create the request. Try again.")


# ---------------- profile & privacy ----------------
PRIVACY_DEFAULT = {"ai_memory": False, "assistant_history": True, "analytics": True}


@router.get("/profile")
async def profile(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    prog = await db.get(Programme, user.programme_id) if user.programme_id else None
    fac = await db.get(Faculty, user.faculty_id) if user.faculty_id else None
    rows = (await db.execute(select(Enrolment, Course).join(Course, Course.id == Enrolment.course_id).where(Enrolment.user_id == user.id)
                             .order_by(Course.code))).all()
    demo = demo_courses()
    return {"name": user.name, "first": user.first, "email": user.email, "student_no": user.student_no, "year": user.year, "status": user.status,
            "programme": prog.name if prog else None, "level": prog.level if prog else None, "faculty": fac.name if fac else None,
            "last_login_at": iso(user.last_login_at),
            "enrolments": [{"course_id": c.id, "code": c.code, "title": c.title, "credits": c.credits, "term": c.term, "status": e.status,
                            "progress": e.progress} for e, c in rows if demo is None or c.id in demo],
            "prefs": user.prefs or {}, "privacy": {**PRIVACY_DEFAULT, **((user.prefs or {}).get("privacy") or {})}}


class StudentPrefsIn(BaseModel):
    transcript: bool | None = None
    highContrast: bool | None = None
    privacy: dict[str, bool] | None = None


@router.patch("/prefs")
async def student_prefs(body: StudentPrefsIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Preferences the shared /api/auth/prefs endpoint doesn't accept (transcript, high contrast, privacy choices)."""
    changed = {}
    for k in ("transcript", "highContrast"):
        v = getattr(body, k)
        if v is not None:
            set_pref(user, k, v)
            changed[k] = v
    if body.privacy is not None:
        bad = set(body.privacy) - set(PRIVACY_DEFAULT)
        if bad:
            raise HTTPException(422, f"Unknown privacy setting: {', '.join(sorted(bad))}")
        cur = {**PRIVACY_DEFAULT, **((user.prefs or {}).get("privacy") or {}), **body.privacy}
        set_pref(user, "privacy", cur)
        changed["privacy"] = cur
        await audit(db, user, "Updated privacy choices", "data", user.email, detail=body.privacy)
    await db.commit()
    return user.prefs
