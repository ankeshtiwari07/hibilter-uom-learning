"""Idempotent seed from the concept demo's synthetic data. All people and figures are fictional.

Dates in the demo are anchored on 2026-10-12; they are shifted so the data stays current relative to seed day."""
from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select

from ..core.audit import audit
from ..core.db import SessionLocal
from ..core.security import hash_password
from ..models import (FAQ, AcademicTerm, Announcement, Assessment, Avatar, CalendarEvent, Chunk, Course, Enrolment,
                      Faculty, Lesson, LessonVersion, Message, Module, Programme, Setting, Source, Submission,
                      SupportTicket, Thread, User)

DATA = json.loads((Path(__file__).parent / "demo_data.json").read_text())
ANCHOR = date(2026, 10, 12)
SHIFT = timedelta(days=(date.today() - ANCHOR).days)
PNG_SCALE = 1672 / 1280  # demo calibration was measured on 1280px copies of the same portraits

CP_ACK = {
    "cp1": "Machine learning is a subset of artificial intelligence that enables systems to learn patterns from data.",
    "cp2": "The labels are the correct answers, so the model can compare its predictions and reduce its errors.",
    "cp3": "Biased data can make a model less accurate, or unfair, for the people it under-represents.",
}
SIDE_ANSWERS = {
    "deep": "Deep learning is a part of machine learning that uses large neural networks. It sits inside machine learning, which sits inside AI.",
    "example": "Good question. Examples from the lesson include forecasting electricity demand, estimating sugar-cane yields from satellite images, and flagging fraudulent card transactions.",
    "overfit": "Overfitting is when a model does very well on its training data, but poorly on new data it has never seen.",
    "label": "A label is the correct answer attached to a training example, such as spam, or not spam.",
    "none": "That goes a little beyond today’s approved material. I suggest raising it with your course lecturer in the discussion forum.",
}
CONCEPT_ASK = {
    "subset": "how machine learning relates to AI as a whole", "data": "where a machine learning system gets its knowledge from",
    "rules": "how this differs from a programmer writing every rule", "aidef": "what AI as a field tries to do",
    "answer": "what information each label actually contains", "compare": "how the model uses that information while training",
    "mapping": "how inputs and labels are paired", "unfair": "what could happen to people who are under-represented",
}
PORTRAITS = {"henri": ("henri.png", None), "isabelle": ("isabelle.png", None), "arjun": ("arjun.png", None),
             "nalini": ("nalini.png", None), "elena": ("elena.png", "elena_alt.png"), "lucas": ("lucas.png", "lucas_listen.png")}


def dt(d: str, t: str | None = None) -> datetime:
    if "T" in d:
        d, t = d.split("T")
    base = datetime.fromisoformat(f"{d}T{(t or '09:00')[:5]}:00").replace(tzinfo=timezone.utc)
    return base + SHIFT


def demo_password() -> str:
    return os.environ.get("SEED_PASSWORD", "Demo-UoM-2026!")


def lesson_content() -> dict:
    L = json.loads(json.dumps(DATA["LESSON"]))
    for s in L["segments"]:
        s["checkpoint"]["ack"] = CP_ACK[s["checkpoint"]["id"]]
    L["side_answers"] = SIDE_ANSWERS
    L["concept_ask"] = CONCEPT_ASK
    L["objectives"] = ["Distinguish AI, machine learning and deep learning",
                       "Explain how supervised learning uses labelled data", "Recognise how biased data creates risk"]
    return L


async def seed(reset_passwords: bool = False):
    async with SessionLocal() as db:
        if await db.get(Faculty, "icdt") and not reset_passwords:
            print("already seeded")
            return
        pw = hash_password(demo_password())
        for f in DATA["FACULTIES"]:
            db.add(Faculty(id=f["id"], name=f["name"], short=f["short"]))
        await db.flush()
        for p in DATA["PROGRAMMES"]:
            db.add(Programme(id=p["id"], faculty_id=p["fac"], name=p["name"], level=p["level"], years=p["years"]))
        await db.flush()
        for st in DATA["STAFF"]:
            db.add(User(id=st["id"], email=st["email"].lower(), password_hash=pw, role=st["role"], name=st["name"], first=st["first"],
                        title=st["title"], faculty_id=st.get("fac")))
        for s in DATA["STUDENTS"]:
            db.add(User(id=s["id"], email=s["email"].lower(), password_hash=pw, role="student", name=s["name"], first=s["first"],
                        faculty_id=s["fac"], programme_id=s["prog"], student_no=s["sid"], year=s["year"],
                        status="active" if s.get("status", "Active") == "Active" else "suspended",
                        risk={k: s.get(k) for k in ("activity", "avg", "completion", "overdue", "trend")}))
        await db.flush()
        for c in DATA["COURSES"]:
            db.add(Course(id=c["id"], code=c["code"], title=c["title"], faculty_id=c["fac"], programme_id=c.get("prog"),
                          lecturer_id=c.get("lec"), credits=c.get("credits", 3), description=c.get("desc", ""), cover=c.get("cv", 1),
                          term=c.get("sem", "S1 2026/27"), vf_enabled=bool(c.get("vf")),
                          meta={k: c.get(k) for k in ("weeks", "format", "outcomes", "vf") if k in c}))
        await db.flush()
        prog = DATA.get("SAGAR_PROGRESS", {})
        for sid, cids in DATA["ENROL"].items():
            for cid in cids:
                db.add(Enrolment(user_id=sid, course_id=cid, progress=prog.get(cid, 0) if sid == "s1" else 0))
        for cid, mods in DATA["MODULES"].items():
            for i, m in enumerate(mods):
                db.add(Module(id=f"{cid}-{m['id']}", course_id=cid, ord=i + 1, title=m["title"], items=m["lessons"]))
        # avatars — exact PNG masters; demo lip calibration rescaled to the PNG resolution
        for a in DATA["AVATARS"]:
            lip = {k: (round(v * PNG_SCALE, 1) if k in ("x", "y", "mw", "chin", "jaw") else v) for k, v in a["lip"].items()}
            main, listen = PORTRAITS[a["id"]]
            db.add(Avatar(id=a["id"], name=a["name"], short=a["short"], subject=a["subject"], teach=a["teach"], gender=a["gender"],
                          voice=a["voice"], voice_id=a["tts"], style=a["style"], portrait=f"/assets/portraits/{main}",
                          listen_portrait=f"/assets/portraits/{listen}" if listen else None,
                          calib={"lip": lip, "pos": a.get("pos", "50% 30%"), "pitch": a.get("pitch", 1), "rate": a.get("rate", 1),
                                 "voiceHint": a.get("voiceHint")}))
        await db.flush()
        content = lesson_content()
        policy = {"threshold": "required", "hints": True, "assisted": True, "simpler": True}
        db.add(Lesson(id="L1", course_id="c1", title=content["title"], module=content["module"], version=1, status="published",
                      content=content, policy=policy, published_at=datetime.now(timezone.utc),
                      avatars=["henri", "isabelle", "arjun", "nalini", "elena", "lucas"]))
        await db.flush()
        db.add(LessonVersion(lesson_id="L1", version=1, content=content, policy=policy, author_id="l1"))
        # assessments, quiz, submissions
        quiz = DATA["QUIZ"]
        for a in DATA["ASSESSMENTS"]:
            qs = quiz.get(a.get("qs"), {}).get("questions", []) if a.get("qs") else []
            db.add(Assessment(id=a["id"], course_id=a["course"], title=a["title"], type=a["type"], due=dt(a["due"]) if a.get("due") else None,
                              weight=a.get("weight", 10), max_score=a.get("marks", 100), status="published",
                              instructions=a.get("brief", ""),
                              questions=qs, settings={"time_limit": quiz.get(a.get("qs"), {}).get("time"), "attempts": 2}))
        await db.flush()
        for sb in DATA["SUBMISSIONS"]:
            at = sb.get("at") if sb.get("at") not in (None, "—") else None
            db.add(Submission(assessment_id=sb["as"], user_id=sb["st"], attempt=1, file_name=sb.get("file"),
                              submitted_at=dt(*at.split(" ")) if at else None,
                              score=sb.get("mark"), feedback=sb.get("fb"),
                              status="graded" if sb.get("mark") is not None else ("submitted" if at else "draft"),
                              answers={"words": sb.get("words")}))
        for n in DATA["ANNOUNCEMENTS"]:
            db.add(Announcement(id=n["id"], scope=n["scope"], course_id=n.get("course"), title=n["title"], body=n["body"],
                                author_id=next((s["id"] for s in DATA["STAFF"] if s["name"] == n.get("by")), None),
                                priority=n.get("priority", "normal"), publish_at=datetime.now(timezone.utc)))
        for t in DATA["THREADS"]:
            db.add(Thread(id=t["id"], course_id=t.get("course"), subject=t["title"], participants=[]))
        await db.flush()
        by_name = {s["name"]: s["id"] for s in DATA["STUDENTS"] + DATA["STAFF"]}
        for t in DATA["THREADS"]:
            db.add(Message(thread_id=t["id"], author_id=by_name.get(t.get("by"), "s1"), body=t["title"]))
        for e in DATA["EVENTS"]:
            course = next((c["id"] for c in DATA["COURSES"] if c["code"] in e["title"]), None)
            db.add(CalendarEvent(kind=e["k"], title=e["title"], start=dt(e["d"], e.get("t")), end=dt(e["d"], e["e"]) if e.get("e") else None,
                                 course_id=course))
        for f in DATA["FAQ"]:
            db.add(FAQ(q=f.get("q", ""), a=f.get("a", ""), category=f.get("tag", "General")))
        for t in DATA["SUPPORT_TICKETS"]:
            db.add(SupportTicket(id=t["id"], user_id="s1", category=t.get("cat", "General"), subject=t["title"], body=t["title"],
                                 status=t.get("status", "Open").lower(), updates=[{"at": t.get("at"), "text": t.get("last")}]))
        db.add(AcademicTerm(id="s1-2026", name="Semester 1 2026/27", start=date(2026, 8, 17) + SHIFT, end=date(2026, 12, 18) + SHIFT, current=True))
        db.add(Setting(key="vf", value={"hints": True, "assisted": True, "threshold": "required", "engine": "auto",
                                        "memory": False, "max_attempts": 3}))
        db.add(Setting(key="ai", value={"assistant": True, "label_ai": True, "retention_days": 365}))
        # approved sources for the AI study assistant (lesson scripts are always an approved source)
        src = Source(id="src-l1", course_id="c1", title="L1 · Understanding AI and ML (lesson script)", kind="lesson", approved_by="l1")
        db.add(src)
        await db.flush()
        for i, sgm in enumerate(content["segments"]):
            db.add(Chunk(source_id="src-l1", course_id="c1", page=i + 1, text=f"{sgm['title']}. " + " ".join(sgm["speech"])))
        system = type("S", (), {"id": None, "name": "System"})()
        await audit(db, system, "Seeded demo data", "system", "Synthetic UoM concept dataset")
        await db.commit()
        print("seeded")


if __name__ == "__main__":
    asyncio.run(seed())
