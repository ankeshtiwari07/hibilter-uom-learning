"""Student portal: dashboard, catalogue, course overview, lesson player and progress (S02–S05, S09)."""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import (Announcement, AnnouncementRead, Assessment, Avatar, CalendarEvent, Course, Enrolment, Event,
                      Faculty, Lesson, Programme, Source, Submission, SupportTicket, User, VFAttempt, VFSession)
from ._student_util import (DONE_SUB, GRADED, enrolled_ids, enrolments, iso, item_states, now, require_enrolled, staff_names,
                            sync_progress, visible_announcements)

router = APIRouter(prefix="/api/student", tags=["student"])
student = require("student")

# Demo player content for module items that have no media/transcript of their own yet (synthetic, from the concept demo).
DEMO_PLAYER = {
    ("c1", "L4"): {
        "presenter": "Dr. Meera Lallchand",
        "objectives": ["Define a label and explain its role in training", "Describe the train / test split",
                       "Recognise overfitting from a performance gap"],
        "transcript": [
            {"t": 12, "title": "Labelled data", "sub": "input → model → prediction ⟷ label",
             "text": "In supervised learning, every training example comes with a label — the correct answer."},
            {"t": 280, "title": "Example: spam filter", "sub": "email → spam / not spam",
             "text": "For a spam filter, the label says whether each email is spam or not."},
            {"t": 545, "title": "Training loop", "sub": "predict → compare → adjust",
             "text": "The model makes a prediction, compares it with the label, and adjusts."},
            {"t": 810, "title": "Testing on unseen data", "sub": "train set | test set",
             "text": "We keep some labelled data aside as a test set to check performance on unseen examples."},
        ],
        "chips": ["What is a test set for?", "Explain labels simply", "Give me 3 revision questions"],
    },
}


def course_card(c: Course, fac: dict, lec: dict, progress: int | None = None, enrolled: bool = False) -> dict:
    meta = c.meta or {}
    lu = lec.get(c.lecturer_id)
    return {"id": c.id, "code": c.code, "title": c.title, "description": c.description, "cover": c.cover, "credits": c.credits,
            "term": c.term, "faculty_id": c.faculty_id, "faculty": fac[c.faculty_id].short if c.faculty_id in fac else "",
            "faculty_name": fac[c.faculty_id].name if c.faculty_id in fac else "", "programme_id": c.programme_id,
            "lecturer": lu.name if lu else None, "lecturer_id": c.lecturer_id, "weeks": meta.get("weeks"),
            "format": meta.get("format") or "Blended", "outcomes": meta.get("outcomes") or [], "vf": bool(c.vf_enabled or meta.get("vf")),
            "vf_avatar": meta.get("vf"), "enrolled": enrolled, "progress": progress}


async def _faculties(db) -> dict[str, Faculty]:
    return {f.id: f for f in (await db.execute(select(Faculty))).scalars()}


# ---------------- S02 dashboard ----------------
@router.get("/dashboard")
async def dashboard(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    ens = await enrolments(db, user)
    cids = [e.course_id for e in ens]
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    fac = await _faculties(db)
    lec = await staff_names(db, [c.lecturer_id for c in courses.values()])
    st = await item_states(db, user, cids)
    prog = {e.course_id: max(e.progress or 0, st["progress"].get(e.course_id, 0)) for e in ens}
    prog_row = await db.get(Programme, user.programme_id) if user.programme_id else None
    t = now()

    # deadlines (not yet submitted, due from yesterday onwards)
    subs = st["subs"]
    deadlines = []
    for a in sorted([a for a in st["assessments"] if a.due and a.due >= t - timedelta(days=1)], key=lambda a: a.due):
        s = subs.get(a.id)
        if s and s.status in DONE_SUB:
            continue
        deadlines.append({"id": a.id, "title": a.title, "type": a.type, "due": iso(a.due), "course_code": courses[a.course_id].code,
                          "link": f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}" if a.type in ("assignment", "lab") else "/s-cal"})
    graded = [(a, subs[a.id]) for a in st["assessments"] if a.id in subs and subs[a.id].status in GRADED and subs[a.id].score is not None]
    avg = round(sum(100 * s.score / (a.max_score or 100) for a, s in graded) / len(graded)) if graded else None

    # events in a window around today (client filters to its local "today")
    evs = (await db.execute(select(CalendarEvent).where(CalendarEvent.start >= t - timedelta(days=1), CalendarEvent.start <= t + timedelta(days=2),
                                                        (CalendarEvent.course_id.in_(cids or ["-"])) | CalendarEvent.course_id.is_(None))
                            .order_by(CalendarEvent.start))).scalars()
    events = [{"id": e.id, "kind": e.kind, "title": e.title, "start": iso(e.start), "end": iso(e.end)} for e in evs]

    read = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    anns = (await db.execute(select(Announcement).where(visible_announcements(user, cids))
                             .order_by(func.coalesce(Announcement.publish_at, Announcement.created_at).desc()).limit(3))).scalars()
    ann = [{"id": a.id, "title": a.title, "scope": a.scope, "course_code": courses[a.course_id].code if a.course_id in courses else None,
            "at": iso(a.publish_at or a.created_at), "unread": a.id not in read} for a in anns]
    unread = (await db.execute(select(func.count()).select_from(Announcement).where(visible_announcements(user, cids),
                                                                                     Announcement.id.notin_(list(read) or ["-"])))).scalar()

    # virtual-faculty hero: first published VF lesson not completed (else the latest completed one)
    lessons = [l for l in st["lessons"].values() if l.status == "published"]
    lessons.sort(key=lambda l: (l.id in st["vf_done"], cids.index(l.course_id) if l.course_id in cids else 99, l.id))
    hero = None
    if lessons:
        l = lessons[0]
        last = st["vf"].get(l.id)
        av_id = (user.prefs or {}).get("avatar") if (user.prefs or {}).get("avatar") in (l.avatars or []) else None
        av_id = av_id or (last.avatar_id if last else None) or (l.avatars or ["henri"])[0]
        av = await db.get(Avatar, av_id)
        segs = l.content.get("segments", [])
        saved = None
        if last and last.status in ("saved", "saved-after-error", "active") and last.seg > 0 and l.id not in st["vf_done"]:
            saved = segs[last.seg]["title"] if last.seg < len(segs) else None
        done = l.id in st["vf_done"]
        nxt = None
        if done:  # next item after the VF lesson in its course
            its = st["items"].get(l.course_id, [])
            idx = next((i for i, x in enumerate(its) if x.get("lesson_id") == l.id), -1)
            nxt = next((x for x in its[idx + 1:] if x["status"] != "done" and x["link"]), None)
        hero = {"lesson_id": l.id, "title": l.title, "module": l.module, "course_code": courses[l.course_id].code if l.course_id in courses else "",
                "dur": l.content.get("dur", 25), "checkpoints": len(segs), "status": "done" if done else "progress" if last else "todo",
                "saved_at": saved, "pct": 100 if done else round(100 * last.seg / max(1, len(segs))) if last else 0,
                "avatar": {"id": av.id, "name": av.name, "portrait": av.portrait, "pos": (av.calib or {}).get("pos")} if av else None,
                "next": nxt}

    # recently accessed: lesson opens, VF sessions, submissions
    recent = []
    seen = set()
    for e in (await db.execute(select(Event).where(Event.actor_id == user.id, Event.type == "lesson_progress").order_by(Event.id.desc()).limit(20))).scalars():
        k = (e.course_id, (e.payload or {}).get("item_id"))
        if k in seen or e.course_id not in courses:
            continue
        seen.add(k)
        it = next((x for x in st["items"].get(e.course_id, []) if x["id"] == k[1]), None)
        if it:
            recent.append({"icon": "play" if it["type"] == "video" else "book", "title": it["title"], "at": iso(e.ts), "link": it["link"],
                           "desc": f"{courses[e.course_id].code} · {it['type'].capitalize()} · {'Completed' if it['status'] == 'done' else 'In progress'}"})
    for lid, s in st["vf"].items():
        l = st["lessons"].get(lid)
        if l:
            recent.append({"icon": "cap", "title": l.title, "at": iso(s.updated_at), "link": f"/s-classroom/{lid}",
                           "desc": f"{courses[l.course_id].code if l.course_id in courses else ''} · Virtual lesson · {'Completed' if lid in st['vf_done'] else 'In progress'}"})
    for a in st["assessments"]:
        s = subs.get(a.id)
        if s and s.status in DONE_SUB:
            sc = f" · {s.score:g}/{a.max_score}" if s.status in GRADED and s.score is not None else ""
            recent.append({"icon": "checkc" if a.type == "quiz" else "clip", "title": a.title, "at": iso(s.submitted_at or s.created_at),
                           "link": f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}", "desc": f"{courses[a.course_id].code}{sc}"})
    recent.sort(key=lambda x: x["at"] or "", reverse=True)

    recs = await recommendations(db, user, st, courses, deadlines)
    profile = {"name": user.name, "first": user.first, "student_no": user.student_no, "year": user.year,
               "programme": prog_row.name if prog_row else None, "faculty": fac[user.faculty_id].short if user.faculty_id in fac else None}
    cards = [course_card(courses[c], fac, lec, prog.get(c, 0), True) for c in cids if c in courses]
    due_week = [d for d in deadlines if d["due"] and d["due"] <= iso(t + timedelta(days=7))]
    return {"profile": profile, "term": courses[cids[0]].term if cids else None, "courses": cards,
            "kpis": {"courses": len(cards), "completion": round(sum(prog.values()) / len(prog)) if prog else 0, "due_week": len(due_week),
                     "average": avg, "graded_count": len(graded), "unread": unread},
            "deadlines": deadlines[:5], "events": events, "announcements": ann, "hero": hero, "recent": recent[:4], "recommendations": recs}


async def recommendations(db: AsyncSession, user: User, st: dict, courses: dict, deadlines: list) -> list[dict]:
    """Explainable, rule-based suggestions. Each one carries the reason it is shown."""
    out = []
    # 1. concepts missed in virtual-faculty checkpoints
    sids = {s.id: s for s in st["vf"].values()}
    if sids:
        atts = (await db.execute(select(VFAttempt).where(VFAttempt.session_id.in_(list(sids))).order_by(VFAttempt.id.desc()).limit(30))).scalars()
        for a in atts:
            if a.verdict == "correct" or not a.missing:
                continue
            l = st["lessons"].get(sids[a.session_id].lesson_id)
            cp = next((sg["checkpoint"] for sg in (l.content.get("segments", []) if l else []) if sg["checkpoint"]["id"] == a.checkpoint_id), None)
            label = next((c["label"] for c in (cp or {}).get("concepts", []) if c["id"] in a.missing), None)
            if label and l:
                out.append({"title": f"Revise: {label}", "why": f"You missed this idea in a checkpoint of “{l.title}”.",
                            "link": f"/s-ai?course={l.course_id}&q={label}", "icon": "ai"})
                break
    # 2. quiz questions answered incorrectly
    for a in st["assessments"]:
        s = st["subs"].get(a.id)
        if a.type == "quiz" and s and s.status in GRADED and isinstance(s.answers, dict) and s.answers.get("result"):
            wrong = [i for i, ok in enumerate(s.answers["result"]) if not ok]
            if wrong:
                out.append({"title": f"Revise questions from {a.title}", "why": f"You answered {len(wrong)} of {len(s.answers['result'])} questions incorrectly.",
                            "link": f"/s-quiz?id={a.id}", "icon": "checkc"})
                break
    # 3. nearest quiz deadline not yet attempted
    q = next((d for d in deadlines if d["type"] == "quiz"), None)
    if q:
        out.append({"title": f"Take {q['title']}", "why": f"{q['course_code']} quiz closes {q['due'][:10]}.", "link": q["link"], "icon": "clock", "due": q["due"]})
    # 4. continue the least-progressed course
    best = None
    for cid, its in st["items"].items():
        nxt = next((x for x in its if x["status"] != "done" and x["link"]), None)
        if nxt and (best is None or st["progress"].get(cid, 0) < best[0]):
            best = (st["progress"].get(cid, 0), cid, nxt)
    if best:
        out.append({"title": f"Continue: {best[2]['title']}", "why": f"Next unfinished item in {courses[best[1]].code} ({best[0]}% complete).",
                    "link": best[2]["link"], "icon": "play"})
    return out[:3]


# ---------------- S03 catalogue ----------------
@router.get("/catalogue")
async def catalogue(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    courses = list((await db.execute(select(Course).where(Course.status == "published").order_by(Course.code))).scalars())
    fac = await _faculties(db)
    progs = list((await db.execute(select(Programme).order_by(Programme.name))).scalars())
    lec = await staff_names(db, [c.lecturer_id for c in courses])
    ens = {e.course_id: e for e in await enrolments(db, user)}
    avatars = {a.id: a.name for a in (await db.execute(select(Avatar))).scalars()}
    pending = set()
    for t in (await db.execute(select(SupportTicket).where(SupportTicket.user_id == user.id, SupportTicket.category == "Enrolment",
                                                           SupportTicket.status != "resolved"))).scalars():
        for u in (t.updates or []):
            if isinstance(u, dict) and u.get("course_id"):
                pending.add(u["course_id"])
    out = []
    for c in courses:
        card = course_card(c, fac, lec, ens[c.id].progress if c.id in ens else None, c.id in ens)
        card["vf_name"] = avatars.get(card["vf_avatar"])
        card["requested"] = c.id in pending
        out.append(card)
    return {"courses": out, "faculties": [{"id": f.id, "short": f.short, "name": f.name} for f in fac.values()],
            "programmes": [{"id": p.id, "name": p.name, "faculty_id": p.faculty_id, "level": p.level} for p in progs]}


class EnrolReqIn(BaseModel):
    note: str = Field(default="", max_length=1000)


@router.post("/catalogue/{course_id}/request")
async def request_enrolment(course_id: str, body: EnrolReqIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    c = await db.get(Course, course_id)
    if not c or c.status != "published":
        raise HTTPException(404, "Course not found")
    if (await db.execute(select(Enrolment).where(Enrolment.user_id == user.id, Enrolment.course_id == c.id))).scalar_one_or_none():
        raise HTTPException(409, "You're already enrolled in this course.")
    for t in (await db.execute(select(SupportTicket).where(SupportTicket.user_id == user.id, SupportTicket.category == "Enrolment",
                                                           SupportTicket.status != "resolved"))).scalars():
        if any(isinstance(u, dict) and u.get("course_id") == c.id for u in (t.updates or [])):
            return {"id": t.id, "status": t.status, "duplicate": True}
    from .student_comms import new_ticket_id
    tid = await new_ticket_id(db)
    body_txt = f"Please enrol me in {c.code} · {c.title} ({c.term})." + (f"\n\n{body.note.strip()}" if body.note.strip() else "")
    db.add(SupportTicket(id=tid, user_id=user.id, category="Enrolment", subject=f"Enrolment request: {c.code} {c.title}"[:300], body=body_txt,
                         status="open", updates=[{"at": iso(now()), "text": "Routed to the programme coordinator. Typical first response: 2 working days.",
                                                  "course_id": c.id}]))
    await audit(db, user, "Requested enrolment", "access", f"{c.code} · {c.title}", detail={"ticket": tid})
    await db.commit()
    return {"id": tid, "status": "open", "duplicate": False}


# ---------------- S04 course overview ----------------
@router.get("/courses")
async def my_courses(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    ens = await enrolments(db, user)
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_([e.course_id for e in ens] or ["-"])))).scalars()}
    fac = await _faculties(db)
    lec = await staff_names(db, [c.lecturer_id for c in courses.values()])
    return [course_card(courses[e.course_id], fac, lec, e.progress, True) for e in ens if e.course_id in courses]


@router.get("/courses/{course_id}")
async def course_detail(course_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    c, en = await require_enrolled(db, user, course_id)
    fac = await _faculties(db)
    lec = await staff_names(db, [c.lecturer_id])
    st = await item_states(db, user, [c.id])
    items = st["items"][c.id]
    modules = []
    for it in items:
        if not modules or modules[-1]["id"] != it["module_id"]:
            modules.append({"id": it["module_id"], "title": it["module"], "items": []})
        modules[-1]["items"].append(it)
    subs = st["subs"]
    assess = []
    for a in sorted(st["assessments"], key=lambda a: (a.due is None, a.due)):
        s = subs.get(a.id)
        status = ("graded" if s and s.status in GRADED else "submitted" if s and s.status == "submitted" else
                  "closed" if a.due and a.due < now() else "open" if a.type in ("quiz", "assignment", "lab") else "upcoming")
        assess.append({"id": a.id, "title": a.title, "type": a.type, "weight": a.weight, "due": iso(a.due), "status": status,
                       "score": s.score if s and s.status in GRADED else None, "max": a.max_score,
                       "link": f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}" if a.type in ("assignment", "lab") else None})
    read = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    anns = list((await db.execute(select(Announcement).where(visible_announcements(user, [c.id]), Announcement.course_id == c.id)
                                  .order_by(func.coalesce(Announcement.publish_at, Announcement.created_at).desc()))).scalars())
    authors = await staff_names(db, [a.author_id for a in anns])
    from .student_comms import thread_rows
    threads = await thread_rows(db, user, [c.id], private=False)
    sources = (await db.execute(select(Source).where(Source.course_id == c.id, Source.approved.is_(True)).order_by(Source.created_at))).scalars()
    lessons = [l for l in st["lessons"].values() if l.status == "published"]
    card = course_card(c, fac, lec, max(en.progress or 0, st["progress"][c.id]), True)
    lu = lec.get(c.lecturer_id)
    card["lecturer_title"] = lu.title if lu else None
    card["lecturer_email"] = lu.email if lu else None
    return {"course": card, "modules": [m for m in modules if m["items"]], "done": sum(1 for x in items if x["status"] == "done"), "total": len(items),
            "assessments": assess, "vf_lessons": [{"id": l.id, "title": l.title, "done": l.id in st["vf_done"]} for l in lessons],
            "announcements": [{"id": a.id, "title": a.title, "body": a.body, "by": authors[a.author_id].name if a.author_id in authors else "Course team",
                               "at": iso(a.publish_at or a.created_at), "unread": a.id not in read} for a in anns],
            "threads": threads,
            "resources": [{"id": s.id, "title": s.title, "kind": s.kind, "uri": s.uri} for s in sources]}


# ---------------- S05 lesson player ----------------
def _find_item(items: list[dict], item_id: str) -> int:
    return next((i for i, x in enumerate(items) if x["id"] == item_id), -1)


@router.get("/lessons/next")
async def next_lesson(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Where /s-lesson without parameters should go: the most recent in-progress video/reading, else the next unfinished one."""
    cids = await enrolled_ids(db, user)
    st = await item_states(db, user, cids)
    last = (await db.execute(select(Event).where(Event.actor_id == user.id, Event.type == "lesson_progress", Event.course_id.in_(cids or ["-"]))
                             .order_by(Event.id.desc()).limit(1))).scalar_one_or_none()
    if last:
        it = next((x for x in st["items"].get(last.course_id, []) if x["id"] == (last.payload or {}).get("item_id")), None)
        if it and it["status"] != "done":
            return {"course": last.course_id, "item": it["id"]}
    for cid in cids:
        it = next((x for x in st["items"].get(cid, []) if x["type"] in ("video", "reading") and x["status"] != "done"), None)
        if it:
            return {"course": cid, "item": it["id"]}
    for cid in cids:
        it = next((x for x in st["items"].get(cid, []) if x["type"] in ("video", "reading")), None)
        if it:
            return {"course": cid, "item": it["id"]}
    return None


@router.get("/lessons/{course_id}/{item_id}")
async def lesson_item(course_id: str, item_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    c, _ = await require_enrolled(db, user, course_id)
    st = await item_states(db, user, [c.id])
    items = st["items"][c.id]
    i = _find_item(items, item_id)
    if i < 0:
        raise HTTPException(404, "Lesson not found in this course")
    it = items[i]
    from ..models import Module
    raw = next((x for m in (await db.execute(select(Module).where(Module.id == it["module_id"]))).scalars() for x in (m.items or []) if x.get("id") == item_id), {})
    demo = DEMO_PLAYER.get((c.id, item_id), {})
    lec = await staff_names(db, [c.lecturer_id])
    notes = (await db.execute(select(Event).where(Event.actor_id == user.id, Event.type == "note", Event.course_id == c.id).order_by(Event.id.desc()))).scalars()
    nav = [x for x in items if x["link"]]
    j = next((k for k, x in enumerate(nav) if x["id"] == item_id), -1)
    sources = (await db.execute(select(Source).where(Source.course_id == c.id, Source.approved.is_(True)))).scalars()
    related = [x for x in items if x["id"] != item_id and x["link"] and (x["module_id"] == it["module_id"] or x["vf"] or x["type"] == "quiz")][:3]
    return {"course": {"id": c.id, "code": c.code, "title": c.title}, "item": {**it, "index": i + 1},
            "media_url": raw.get("url") or raw.get("video_url"), "body": raw.get("body"),
            "presenter": raw.get("presenter") or demo.get("presenter") or (lec[c.lecturer_id].name if c.lecturer_id in lec else None),
            "objectives": raw.get("objectives") or demo.get("objectives") or [],
            "transcript": raw.get("transcript") or demo.get("transcript") or [],
            "chips": demo.get("chips") or [f"Explain {it['title'].split(':')[-1].strip()} simply", "Give me 3 revision questions"],
            "prev": nav[j - 1] if j > 0 else None, "next": nav[j + 1] if 0 <= j < len(nav) - 1 else None,
            "notes": [{"id": n.id, "kind": (n.payload or {}).get("kind", "note"), "text": (n.payload or {}).get("text", ""), "t": (n.payload or {}).get("t"),
                       "at": iso(n.ts)} for n in notes if (n.payload or {}).get("item_id") == item_id],
            "materials": [{"id": s.id, "title": s.title, "kind": s.kind, "uri": s.uri} for s in sources],
            "related": related}


class ProgressIn(BaseModel):
    pos: int = Field(default=0, ge=0, le=60 * 60 * 10)
    done: bool = False


@router.post("/lessons/{course_id}/{item_id}/progress")
async def lesson_progress(course_id: str, item_id: str, body: ProgressIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    c, en = await require_enrolled(db, user, course_id)
    st = await item_states(db, user, [c.id])
    it = next((x for x in st["items"][c.id] if x["id"] == item_id), None)
    if not it or it["type"] not in ("video", "reading"):
        raise HTTPException(404, "Lesson not found in this course")
    last = (await db.execute(select(Event).where(Event.actor_id == user.id, Event.type == "lesson_progress", Event.course_id == c.id)
                             .order_by(Event.id.desc()).limit(1))).scalar_one_or_none()
    already = it["status"] == "done"
    done = body.done or already
    if last and (last.payload or {}).get("item_id") == item_id and last.ts and now() - last.ts < timedelta(minutes=30) and bool((last.payload or {}).get("done")) == done:
        last.payload = {**(last.payload or {}), "pos": body.pos}  # coalesce frequent position saves
    else:
        db.add(Event(actor_id=user.id, course_id=c.id, type="lesson_progress", payload={"item_id": item_id, "pos": body.pos, "done": done}))
    await db.flush()
    pct = await sync_progress(db, user, c.id)
    await db.commit()
    return {"done": done, "newly_completed": body.done and not already, "course_progress": pct}


class NoteIn(BaseModel):
    text: str = Field(default="", max_length=2000)
    kind: str = Field(default="note", pattern="^(note|bookmark)$")
    t: int | None = Field(default=None, ge=0, le=60 * 60 * 10)


@router.post("/lessons/{course_id}/{item_id}/notes")
async def add_note(course_id: str, item_id: str, body: NoteIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    c, _ = await require_enrolled(db, user, course_id)
    text = body.text.strip()
    if body.kind == "note" and not text:
        raise HTTPException(422, "Write something first.")
    if body.kind == "bookmark" and not text:
        text = f"Bookmark at {(body.t or 0) // 60}:{(body.t or 0) % 60:02d}"
    e = Event(actor_id=user.id, course_id=c.id, type="note", payload={"item_id": item_id, "kind": body.kind, "text": text, "t": body.t})
    db.add(e)
    await db.commit()
    return {"id": e.id, "kind": body.kind, "text": text, "t": body.t, "at": iso(e.ts)}


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    e = await db.get(Event, note_id)
    if not e or e.actor_id != user.id or e.type != "note":
        raise HTTPException(404, "Note not found")
    await db.delete(e)
    await db.commit()
    return {"ok": True}


# ---------------- S09 progress ----------------
@router.get("/progress")
async def progress(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    ens = await enrolments(db, user)
    cids = [e.course_id for e in ens]
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    st = await item_states(db, user, cids)
    prog = {e.course_id: max(e.progress or 0, st["progress"].get(e.course_id, 0)) for e in ens}
    t = now()
    all_subs = list((await db.execute(select(Submission, Assessment).join(Assessment, Assessment.id == Submission.assessment_id)
                                      .where(Submission.user_id == user.id, Submission.status != "draft")
                                      .order_by(Submission.submitted_at))).all())
    scores, pending = [], []
    for s, a in all_subs:
        row = {"id": a.id, "title": a.title, "type": a.type, "course_code": courses[a.course_id].code if a.course_id in courses else "",
               "course_id": a.course_id, "weight": a.weight, "max": a.max_score, "at": iso(s.submitted_at or s.created_at), "attempt": s.attempt}
        if s.status in GRADED and s.score is not None:
            scores.append({**row, "score": s.score, "pct": round(100 * s.score / (a.max_score or 100)), "marked_by": "auto" if a.type == "quiz" and not s.graded_by else "lecturer"})
        else:
            pending.append({**row, "status": s.status})
    best: dict[str, dict] = {}
    for r in scores:  # best attempt per assessment
        if r["id"] not in best or r["pct"] > best[r["id"]]["pct"]:
            best[r["id"]] = r
    upcoming = [{"id": a.id, "title": a.title, "type": a.type, "course_code": courses[a.course_id].code, "due": iso(a.due),
                 "link": f"/s-quiz?id={a.id}" if a.type == "quiz" else f"/s-assign?id={a.id}"}
                for a in sorted(st["assessments"], key=lambda a: (a.due is None, a.due)) if a.id not in best and not any(p["id"] == a.id for p in pending)
                and a.due and a.due >= t]
    missed = [a for a in st["assessments"] if a.due and t - timedelta(days=30) <= a.due < t and a.type in ("quiz", "assignment", "lab")
              and not (st["subs"].get(a.id) and st["subs"][a.id].status in DONE_SUB)]

    # activity: events, submissions, VF sessions
    evs = list((await db.execute(select(Event).where(Event.actor_id == user.id).order_by(Event.id.desc()).limit(300))).scalars())
    days = {e.ts.date() for e in evs if e.ts and e.ts >= t - timedelta(days=14)}
    days |= {s.submitted_at.date() for s, _ in all_subs if s.submitted_at and s.submitted_at >= t - timedelta(days=14)}
    streak = 0
    d = t.date()
    if d not in days:
        d -= timedelta(days=1)
    while d in days:
        streak += 1
        d -= timedelta(days=1)
    cands = [e.ts for e in evs if e.ts] + [s.submitted_at for s, _ in all_subs if s.submitted_at]
    last_active = max(cands) if cands else None

    # virtual-faculty checkpoint history
    sessions = list((await db.execute(select(VFSession).where(VFSession.user_id == user.id, VFSession.status != "superseded")
                                      .order_by(VFSession.updated_at.desc()).limit(20))).scalars())
    atts = defaultdict(list)
    if sessions:
        for a in (await db.execute(select(VFAttempt).where(VFAttempt.session_id.in_([s.id for s in sessions])).order_by(VFAttempt.id))).scalars():
            atts[a.session_id].append(a)
    lessons = {l.id: l for l in (await db.execute(select(Lesson).where(Lesson.id.in_({s.lesson_id for s in sessions} or {"-"})))).scalars()}
    avatars = {a.id: a for a in (await db.execute(select(Avatar))).scalars()}
    vf = []
    concept_hits: dict[str, dict] = {}
    for s in sessions:
        l = lessons.get(s.lesson_id)
        if not l:
            continue
        cps = []
        for sg in l.content.get("segments", []):
            cp = sg["checkpoint"]
            a = [x for x in atts[s.id] if x.checkpoint_id == cp["id"]]
            labels = {c["id"]: c["label"] for c in cp.get("concepts", [])}
            for x in a:
                for cid_ in x.found or []:
                    concept_hits.setdefault(labels.get(cid_, cid_), {"ok": 0, "miss": 0})["ok"] += 1
                for cid_ in x.missing or []:
                    if cid_ in labels:
                        concept_hits.setdefault(labels[cid_], {"ok": 0, "miss": 0})["miss"] += 1
            outcome = (s.outcome or {}).get(cp["id"]) or ("passed" if a and a[-1].verdict == "correct" else "open")
            if not a and outcome == "open":
                continue
            cps.append({"id": cp["id"], "question": cp["question"], "attempts": len(a), "first": a[0].verdict if a else None,
                        "final": a[-1].verdict if a else None, "hints": (s.hints or {}).get(cp["id"], 0), "outcome": outcome})
        av = avatars.get(s.avatar_id)
        vf.append({"id": s.id, "lesson_id": l.id, "lesson": l.title, "avatar": av.name if av else s.avatar_id, "avatar_short": av.short if av else "",
                   "status": s.status, "at": iso(s.updated_at), "checkpoints": cps, "total": len(l.content.get("segments", []))})
    completed_vf = [x for x in vf if x["status"] == "completed"]
    first_try = sum(1 for c in (completed_vf[0]["checkpoints"] if completed_vf else []) if c["first"] == "correct")

    # strengths / areas to improve (rule-based on own evidence)
    strengths, improve = [], []
    for label, h in concept_hits.items():
        (strengths if h["ok"] > h["miss"] else improve).append({"label": label, "detail": f"Shown in {h['ok']} checkpoint answer(s), missing in {h['miss']}."})
    for s, a in all_subs:
        if a.type == "quiz" and isinstance(s.answers, dict) and s.answers.get("result") and a.questions:
            res = s.answers["result"]
            for i, ok in enumerate(res):
                if not ok and i < len(a.questions):
                    improve.append({"label": a.questions[i]["q"][:90], "detail": f"Incorrect in {a.title} (attempt {s.attempt}).", "link": f"/s-ai?course={a.course_id}&q={a.questions[i]['q'][:120]}"})
            if sum(res) >= max(1, round(0.8 * len(res))):
                strengths.append({"label": a.title, "detail": f"{sum(res)}/{len(res)} correct."})
    for r in best.values():
        if r["pct"] >= 70 and r["type"] != "quiz":
            strengths.append({"label": r["title"], "detail": f"{r['score']:g}/{r['max']} ({r['pct']}%)."})
        elif r["pct"] < 50:
            improve.append({"label": r["title"], "detail": f"{r['score']:g}/{r['max']} ({r['pct']}%). Read the lecturer feedback."})

    # support indicators: transparent rules
    indicators = []
    if len(missed) >= 1:
        indicators.append({"rule": "Missed deadline", "detail": f"{len(missed)} assessment(s) past their due date in the last 30 days without a submission: " + ", ".join(a.title for a in missed[:3]) + "."})
    if last_active and last_active < t - timedelta(days=10):
        indicators.append({"rule": "No recent activity", "detail": "No learning activity recorded in the last 10 days."})
    chron = sorted(best.values(), key=lambda r: r["at"] or "")
    if len(chron) >= 3:
        recent, earlier = chron[-1]["pct"], sum(r["pct"] for r in chron[:-1]) / (len(chron) - 1)
        if earlier - recent > 15:
            indicators.append({"rule": "Recent marks dropped", "detail": f"Latest mark {recent}% vs your earlier average {round(earlier)}% (drop over 15 points)."})

    timeline = []
    for s, a in all_subs:
        timeline.append({"at": iso(s.submitted_at or s.created_at), "kind": "g" if s.status in GRADED else "",
                         "text": f"{'Submitted' if s.status == 'submitted' else 'Marked'} {a.title}" + (f" · {s.score:g}/{a.max_score}" if s.status in GRADED and s.score is not None else "")})
    for x in vf:
        timeline.append({"at": x["at"], "kind": "" if x["status"] == "completed" else "n",
                         "text": f"{'Completed' if x['status'] == 'completed' else 'Started'} virtual lesson with {x['avatar_short'] or x['avatar']}"})
    item_title = {(cid, it["id"]): it["title"] for cid, its in st["items"].items() for it in its}
    for e in evs:
        if e.type == "lesson_progress" and (e.payload or {}).get("done"):
            timeline.append({"at": iso(e.ts), "kind": "n", "text": f"Completed “{item_title.get((e.course_id, (e.payload or {}).get('item_id')), 'lesson')}”"})
    timeline.sort(key=lambda x: x["at"] or "", reverse=True)

    outcomes = [{"course_id": c.id, "code": c.code, "title": c.title, "outcomes": (c.meta or {}).get("outcomes", []),
                 "evidence": sum(1 for r in best.values() if r["course_id"] == c.id) + sum(1 for x in vf if lessons.get(x["lesson_id"]) and lessons[x["lesson_id"]].course_id == c.id),
                 "progress": prog.get(c.id, 0)} for c in courses.values()]
    avg = round(sum(r["pct"] for r in best.values()) / len(best)) if best else None
    return {"kpis": {"average": avg, "graded": len(best), "completion": round(sum(prog.values()) / len(prog)) if prog else 0,
                     "streak": streak, "active_days": len(days), "vf_completed": len(completed_vf), "vf_first_try": first_try,
                     "vf_total": completed_vf[0]["total"] if completed_vf else 0},
            "courses": [{"id": c.id, "code": c.code, "title": c.title, "progress": prog.get(c.id, 0)} for c in courses.values()],
            "scores": sorted(best.values(), key=lambda r: r["at"] or ""), "pending": pending, "upcoming": upcoming[:6],
            "vf": vf, "strengths": strengths[:5], "improve": improve[:5], "indicators": indicators, "timeline": timeline[:10],
            "outcomes": outcomes}
