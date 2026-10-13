"""Class analytics (S19), computed from real enrolments, events, VF sessions and submissions."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Assessment, Event, Lesson, Module, Submission, User, VFSession
from ._lecturer_common import (csv_bytes, enrolled_students, iso, last_active, now, overdue_counts, owned_course, risk_reasons,
                               week_start)

router = APIRouter(prefix="/api/lecturer/analytics", tags=["lecturer-analytics"])
LECT = require("lecturer")
BUCKETS = [(0, 40, "<40"), (40, 50, "40–49"), (50, 60, "50–59"), (60, 70, "60–69"), (70, 80, "70–79"), (80, 90, "80–89"), (90, 101, "90+")]


async def compute(db: AsyncSession, cid: str, weeks: int = 8) -> dict:
    roster = await enrolled_students(db, [cid])
    uids = [u.id for u, _ in roster]
    n = len(uids)
    t = now()
    w0 = week_start(t) - timedelta(weeks=weeks - 1)
    labels = [(w0 + timedelta(weeks=i)) for i in range(weeks)]
    active: list[set] = [set() for _ in range(weeks)]
    posts = [0] * weeks
    vf_w = [0] * weeks
    subs_w = [0] * weeks

    def wi(ts):
        if not ts or ts < w0:
            return None
        i = (ts - w0).days // 7
        return i if 0 <= i < weeks else None

    if uids:
        for actor, ts, typ in (await db.execute(select(Event.actor_id, Event.ts, Event.type)
                                                .where(Event.course_id == cid, Event.actor_id.in_(uids), Event.ts >= w0))).all():
            i = wi(ts)
            if i is not None:
                active[i].add(actor)
                if typ == "forum_post":
                    posts[i] += 1
    lessons = {l.id: l for l in (await db.execute(select(Lesson).where(Lesson.course_id == cid))).scalars()}
    sessions = (await db.execute(select(VFSession).where(VFSession.lesson_id.in_(list(lessons)), VFSession.status != "superseded"))).scalars().all() if lessons else []
    for s in sessions:
        i = wi(s.started_at or s.created_at)
        if i is not None:
            active[i].add(s.user_id)
            vf_w[i] += 1
    ass = (await db.execute(select(Assessment).where(Assessment.course_id == cid).order_by(Assessment.due))).scalars().all()
    subs = (await db.execute(select(Submission).where(Submission.assessment_id.in_([a.id for a in ass])))).scalars().all() if ass else []
    for sb in subs:
        i = wi(sb.submitted_at)
        if i is not None and sb.user_id in set(uids):
            active[i].add(sb.user_id)
            subs_w[i] += 1
    weekly_active = [round(100 * len(s) / n) if n else 0 for s in active]
    # grades
    by_a: dict[str, list] = {}
    for sb in subs:
        by_a.setdefault(sb.assessment_id, []).append(sb)
    graded = []
    for a in ass:
        rows = by_a.get(a.id, [])
        sc = [sb.score / a.max_score * 100 for sb in rows if sb.status in ("graded", "published") and sb.score is not None and a.max_score]
        handed = [sb for sb in rows if sb.submitted_at and sb.status != "draft"]
        graded.append({"id": a.id, "title": a.title, "type": a.type, "status": a.status, "due": iso(a.due), "max_score": a.max_score,
                       "submitted": len(handed), "graded": len(sc), "avg_pct": round(sum(sc) / len(sc), 1) if sc else None,
                       "median_pct": sorted(sc)[len(sc) // 2] if sc else None,
                       "dist": [{"label": l, "value": sum(1 for v in sc if lo <= v < hi)} for lo, hi, l in BUCKETS]})
    # item analysis for quizzes with structured answers
    items = []
    for a in ass:
        if a.type != "quiz" or not a.questions:
            continue
        stats = [{"q": q.get("q"), "correct": 0, "n": 0, "choices": [0] * len(q.get("o") or [])} for q in a.questions]
        for sb in by_a.get(a.id, []):
            ans = {k: v for k, v in (sb.answers or {}).items()}
            res = ans.get("result") or []
            ch = ans.get("choices") or ans.get("answers") or []
            for i, st in enumerate(stats):
                if i < len(res) and res[i] is not None:
                    st["n"] += 1
                    st["correct"] += 1 if res[i] else 0
                if i < len(ch) and isinstance(ch[i], int) and 0 <= ch[i] < len(st["choices"]):
                    st["choices"][ch[i]] += 1
        if any(s["n"] for s in stats):
            items.append({"id": a.id, "title": a.title, "questions": [{**s, "pct": round(100 * s["correct"] / s["n"]) if s["n"] else None,
                                                                         "answer": a.questions[i].get("a")} for i, s in enumerate(stats)]})
    # completion
    prog = [e.progress for _, e in roster]
    comp_dist = [{"label": l, "value": sum(1 for v in prog if lo <= v < hi)} for lo, hi, l in [(0, 25, "0–24%"), (25, 50, "25–49%"), (50, 75, "50–74%"), (75, 101, "75–100%")]]
    mods = (await db.execute(select(Module).where(Module.course_id == cid).order_by(Module.ord))).scalars().all()
    vf_done = {}
    for s in sessions:
        if s.status == "completed":
            vf_done.setdefault(s.lesson_id, set()).add(s.user_id)
    vf_lessons = [{"label": lessons[lid].title, "value": round(100 * len(us & set(uids)) / n) if n else 0} for lid, us in vf_done.items()]
    # at risk + missing
    last = await last_active(db, uids)
    od = await overdue_counts(db, [cid])
    at_risk = []
    for u, e in roster:
        rs = risk_reasons(u, od.get(u.id, 0), last.get(u.id))
        if rs:
            at_risk.append({"id": u.id, "name": u.name, "first": u.first, "reasons": rs, "progress": e.progress, "last_active": iso(last.get(u.id))})
    missing = []
    names = {u.id: u for u, _ in roster}
    sub_by = {(sb.assessment_id, sb.user_id): sb for sb in subs}
    for a in ass:
        if a.status != "published" or a.type == "exam" or not a.due:
            continue
        if a.due < t - timedelta(days=21):
            continue
        for uid in uids:
            sb = sub_by.get((a.id, uid))
            if not sb or not sb.submitted_at or sb.status == "draft":
                missing.append({"student_id": uid, "name": names[uid].name, "assessment_id": a.id, "assessment": a.title, "due": iso(a.due),
                                "status": "late" if a.due < t else "pending", "last_active": iso(last.get(uid))})
    avg_prog = round(sum(prog) / len(prog)) if prog else None
    quiz_avgs = [g for g in graded if g["type"] == "quiz" and g["avg_pct"] is not None]
    return {
        "n": n,
        "kpis": {"weekly_active": weekly_active[-1] if weekly_active else None, "weekly_active_prev": weekly_active[-2] if len(weekly_active) > 1 else None,
                 "completion": avg_prog, "quiz": quiz_avgs[-1] if quiz_avgs else None,
                 "late": sum(1 for m in missing if m["status"] == "late"), "pending": sum(1 for m in missing if m["status"] == "pending"),
                 "at_risk": len(at_risk)},
        "weeks": [d.strftime("%d %b") for d in labels],
        "weekly_active": weekly_active, "forum_posts": posts, "vf_sessions": vf_w, "submissions": subs_w,
        "assessments": graded, "items": items, "completion_dist": comp_dist, "vf_lessons": vf_lessons,
        "modules": [{"id": m.id, "title": m.title, "items": len(m.items or [])} for m in mods],
        "at_risk": at_risk, "missing": missing,
        "roster": [{"name": u.name, "student_no": u.student_no, "progress": e.progress, "avg": (u.risk or {}).get("avg"),
                    "activity": (u.risk or {}).get("activity"), "overdue": od.get(u.id, 0), "last_active": iso(last.get(u.id))} for u, e in roster],
    }


@router.get("/{cid}")
async def analytics(cid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, cid)
    d = await compute(db, cid)
    d.pop("roster")
    d["course"] = {"id": c.id, "code": c.code, "title": c.title}
    return d


@router.get("/{cid}/report.csv")
async def report(cid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, cid)
    d = await compute(db, cid)
    rows = [["Generated", now().strftime("%Y-%m-%d %H:%M UTC")], ["Course", f"{c.code} {c.title}"], ["Note", "Synthetic demo data"], [],
            ["Student", "Student ID", "Progress %", "Average %", "Activity score", "Overdue", "Last active", "Support flags"]]
    flags = {r["name"]: "; ".join(r["reasons"]) for r in d["at_risk"]}
    for r in d["roster"]:
        rows.append([r["name"], r["student_no"], r["progress"], r["avg"], r["activity"], r["overdue"], (r["last_active"] or "")[:10], flags.get(r["name"], "")])
    rows += [[], ["Assessment", "Type", "Submitted", "Graded", "Average %"]]
    for a in d["assessments"]:
        rows.append([a["title"], a["type"], a["submitted"], a["graded"], a["avg_pct"]])
    await audit(db, user, "Exported course report", "export", f"{c.code} class analytics CSV", detail={"rows": len(d["roster"])})
    await db.commit()
    return Response(csv_bytes(rows), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{c.code}-course-report.csv"'})
