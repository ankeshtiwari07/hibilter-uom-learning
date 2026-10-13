"""Synthetic learning history so analytics screens have realistic volume. Deterministic; idempotent (Setting 'seed_history').
All people and figures are invented. Run: python -m app.seed.history"""
from __future__ import annotations

import asyncio
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..core.db import SessionLocal
from ..core.security import hash_password
from ..models import (Assessment, Course, Enrolment, Event, Lesson, ReviewItem, Setting, Submission, User, VFAttempt,
                      VFSession)
from .seed import DATA, demo_password

R = random.Random(20261012)
FIRST = ["Aarav", "Anjali", "Bilal", "Chloé", "Damien", "Deepika", "Ethan", "Fatima", "Gaël", "Hansika", "Ibrahim", "Isha", "Jean-Marc",
         "Kavya", "Kenzo", "Laetitia", "Leela", "Mahesh", "Marie", "Nadia", "Nikhil", "Océane", "Pooja", "Quentin", "Rahul", "Reshma",
         "Samir", "Shreya", "Sophie", "Tanvi", "Thierry", "Urvashi", "Varun", "Vanessa", "Wassim", "Yash", "Yasmine", "Zara", "Arnaud", "Bhavna"]
LAST = ["Ramgoolam", "Jugnauth", "Bérenger", "Dookun", "Seetaram", "Appadoo", "Lagesse", "Bhunjun", "Ramdhony", "Ah-Chuen", "Moutou",
        "Peerbux", "Gokhool", "Hurry", "Lim Fat", "Mungur", "Narrainen", "Oozeer", "Pillay", "Ramsamy", "Sookun", "Tengur", "Veerapen", "Wong"]
CP_PROFILE = {  # first-attempt correct prob, misconception mix
    "cp1": (0.58, [("same", .09), ("reversed", .06)]),
    "cp2": (0.66, [("nolabel", .05)]),
    "cp3": (0.79, []),
}
SAMPLE = {
    "cp1": {"correct": ["Machine learning is a subset of AI where systems learn patterns from data instead of explicit rules.",
                        "AI is the broad field and ML is one branch of it that learns from examples."],
            "partial": ["Machine learning is when computers learn from data.", "ML is part of AI."],
            "same": ["There is no difference, they are the same thing."], "reversed": ["AI is a type of machine learning."],
            "incorrect": ["AI is robots and ML is computers."]},
    "cp2": {"correct": ["The labels give the correct answer for each example so the model can check its predictions."],
            "partial": ["They tell the model something about the data."], "nolabel": ["There are no labels in supervised learning."],
            "incorrect": ["Labels are the model's predictions."]},
    "cp3": {"correct": ["It can be unfair or less accurate for groups that are under-represented."],
            "partial": ["The model could be wrong."], "incorrect": ["It runs slower."]},
}


async def run():
    async with SessionLocal() as db:
        if await db.get(Setting, "seed_history"):
            print("history already seeded")
            return
        now = datetime.now(timezone.utc)
        pw = hash_password(demo_password())
        courses = {c.id: c for c in (await db.execute(select(Course))).scalars()}
        progs = [(p["id"], p["fac"]) for p in DATA["PROGRAMMES"] if p["years"]]
        # ---- extra students ----
        new_ids = []
        used = set()
        for i in range(150):
            while True:
                f, l = R.choice(FIRST), R.choice(LAST)
                if (f, l) not in used:
                    used.add((f, l)); break
            prog, fac = R.choice(progs)
            sid = f"x{i + 1:03d}"
            act = max(5, min(99, int(R.gauss(68, 18)))); avg = max(25, min(98, int(R.gauss(66, 13))))
            comp = max(5, min(100, int(R.gauss(60, 20)))); overdue = R.choices([0, 0, 0, 1, 2, 3], k=1)[0]
            db.add(User(id=sid, email=f"{f.lower().replace('é', 'e').replace('ç', 'c')}.{l.lower().replace(' ', '').replace('é', 'e').replace('-', '')}{i}@demo.student.example",
                        password_hash=pw, role="student", name=f"{f} {l}", first=f, faculty_id=fac, programme_id=prog,
                        student_no=f"DEMO-24{i + 200:05d}", year=R.choice([1, 1, 2, 2, 3]),
                        risk={"activity": act, "avg": avg, "completion": comp, "overdue": overdue,
                              "trend": R.choice(["up", "flat", "down", "flat"]), "lastActive": f"{R.randint(0, 20)} d ago"}))
            new_ids.append((sid, fac, prog))
        await db.flush()
        # ---- enrolments: fill courses towards the demo's cohort sizes ----
        size = DATA["COURSE_SIZE"]
        by_fac = {}
        for sid, fac, prog in new_ids:
            by_fac.setdefault(fac, []).append(sid)
        enrolled: dict[str, list[str]] = {cid: [] for cid in courses}
        for sid, cids in DATA["ENROL"].items():
            for cid in cids:
                enrolled[cid].append(sid)
        for cid, c in courses.items():
            pool = sorted(set(by_fac.get(c.faculty_id, []) + [s for s, _, _ in new_ids if R.random() < .12]))
            want = min(len(pool), max(0, int(size.get(cid, 40) * 0.6) - len(enrolled[cid])))
            for sid in R.sample(pool, want):
                if sid in enrolled[cid]:
                    continue
                db.add(Enrolment(user_id=sid, course_id=cid, progress=max(0, min(100, int(R.gauss(DATA["COURSE_COMPLETION"].get(cid, 60), 18))))))
                enrolled[cid].append(sid)
        await db.flush()
        # ---- graded submissions for distributions ----
        assessments = (await db.execute(select(Assessment))).scalars().all()
        have = {(s.assessment_id, s.user_id) for s in (await db.execute(select(Submission))).scalars()}
        for a in assessments:
            if a.due and a.due > now:
                continue
            for sid in enrolled.get(a.course_id, []):
                if (a.id, sid) in have or R.random() < 0.07:
                    continue
                mean = DATA["COURSE_AVG"].get(a.course_id, 68)
                score = round(max(0, min(a.max_score, R.gauss(mean, 12) / 100 * a.max_score)), 1)
                late = R.random() < 0.08
                db.add(Submission(assessment_id=a.id, user_id=sid, attempt=1, score=score, status="published", late=late,
                                  submitted_at=(a.due or now) - timedelta(hours=R.randint(-30 if late else 1, 72)),
                                  feedback="Synthetic feedback (demo history)."))
        # ---- virtual faculty sessions on L1 over six weeks ----
        lesson = await db.get(Lesson, "L1")
        avatars = [("henri", .39), ("elena", .23), ("arjun", .13), ("isabelle", .10), ("nalini", .09), ("lucas", .06)]
        learners = [s for s in enrolled.get("c1", []) if s not in ("s1",)]
        n_sessions = 0
        for wk in range(6):
            for _ in range([38, 52, 61, 70, 88, 103][wk]):
                sid = R.choice(learners)
                av = R.choices([a for a, _ in avatars], [w for _, w in avatars])[0]
                start = now - timedelta(days=(6 - wk) * 7 - R.randint(0, 6), hours=R.randint(0, 12), minutes=R.randint(0, 59))
                ses = VFSession(user_id=sid, lesson_id="L1", lesson_version=lesson.version, avatar_id=av, state="IDLE", trace=[],
                                started_at=start, status="active")
                db.add(ses)
                await db.flush()
                ev = [Event(ts=start, actor_id=sid, session_id=ses.id, course_id="c1", type="start", payload={})]
                outcome, hints, t, abandoned, techfail = {}, {}, start, False, False
                for seg_i, cp_id in enumerate(["cp1", "cp2", "cp3"]):
                    t += timedelta(minutes=R.uniform(3.5, 6.5))
                    if R.random() < (0.035 if seg_i else 0.05):
                        abandoned = True; break
                    p_first, mis_mix = CP_PROFILE[cp_id]
                    mandatory = cp_id != "cp3"
                    if not mandatory and R.random() < 0.18:
                        outcome[cp_id] = "skipped"; ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="skip", payload={"cp": cp_id}))
                        continue
                    passed = False
                    for n in range(1, 4):
                        if R.random() < 0.012:
                            techfail = True
                            ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="eval_error", payload={"cp": cp_id, "code": "upstream_503"}))
                        if n > 1 and R.random() < 0.5:
                            hints[cp_id] = hints.get(cp_id, 0) + 1
                            ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="hint", payload={"cp": cp_id, "level": hints[cp_id]}))
                        p = p_first if n == 1 else 0.62
                        if R.random() < p:
                            verdict, mis = "correct", []
                        else:
                            r = R.random(); acc = 0; mis = []
                            for m, w in mis_mix:
                                acc += w / (1 - p_first)
                                if r < acc:
                                    mis = [m]; break
                            verdict = "incorrect" if mis else R.choice(["partial", "partial", "incorrect", "unclear"])
                        bucket = SAMPLE[cp_id].get(mis[0] if mis else verdict) or SAMPLE[cp_id]["partial"]
                        found = {"correct": ["subset", "data"] if cp_id == "cp1" else ["answer"] if cp_id == "cp2" else ["unfair"],
                                 "partial": ["data"] if cp_id == "cp1" else ["compare"] if cp_id == "cp2" else []}.get(verdict, [])
                        db.add(VFAttempt(session_id=ses.id, checkpoint_id=cp_id, n=n, answer=R.choice(bucket), verdict=verdict, found=found,
                                         missing=[], mis=mis, engine=R.choice(["claude", "claude", "claude", "rubric"]), confidence="high",
                                         hints_before=hints.get(cp_id, 0)))
                        ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="eval",
                                        payload={"cp": cp_id, "verdict": verdict, "n": n, "mis": mis}))
                        t += timedelta(minutes=R.uniform(0.6, 1.8))
                        if verdict == "correct":
                            passed = True; break
                        if not mandatory and n >= 2:
                            break
                    if passed:
                        outcome[cp_id] = "passed"
                    elif mandatory:
                        outcome[cp_id] = "assisted"
                        db.add(ReviewItem(kind="assisted", session_id=ses.id, checkpoint_id=cp_id, course_id="c1", student_id=sid,
                                          note="Completed with assisted learning", status="resolved" if R.random() < .6 else "open"))
                        ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="assisted", payload={"cp": cp_id}))
                    else:
                        outcome[cp_id] = "skipped"
                ses.outcome, ses.hints, ses.seg = outcome, hints, min(2, len(outcome))
                if abandoned:
                    ses.status, ses.state = "saved", "TEACHING"
                    ev.append(Event(ts=t, actor_id=sid, session_id=ses.id, course_id="c1", type="abandon", payload={}))
                else:
                    ses.status, ses.state, ses.ended_at = "completed", "COMPLETED", t + timedelta(minutes=R.uniform(1, 2.5))
                    ev.append(Event(ts=ses.ended_at, actor_id=sid, session_id=ses.id, course_id="c1", type="complete", payload={"techfail": techfail}))
                db.add_all(ev)
                n_sessions += 1
        # ---- weekly engagement events for every enrolment ----
        for cid, sids in enrolled.items():
            for sid in sids:
                for wk in range(8):
                    for _ in range(R.choice([0, 1, 1, 2, 3])):
                        db.add(Event(ts=now - timedelta(days=wk * 7 + R.randint(0, 6), hours=R.randint(0, 23)), actor_id=sid, course_id=cid,
                                     type=R.choice(["lesson_view", "lesson_view", "resource_open", "forum_post", "quiz_attempt"]), payload={}))
        db.add(Setting(key="seed_history", value={"at": now.isoformat(), "students": len(new_ids), "vf_sessions": n_sessions}))
        await db.commit()
        print({"students": len(new_ids), "vf_sessions": n_sessions})


if __name__ == "__main__":
    asyncio.run(run())
