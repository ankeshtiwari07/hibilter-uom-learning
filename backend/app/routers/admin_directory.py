"""Administrator: student directory (S23). Opening an individual record requires a reason and is audited."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Programme, User
from ._admin_common import assisted_counts, csv_stream, inactive_days, now, r1, risk_reasons, risk_rules

router = APIRouter(prefix="/api/admin", tags=["admin-directory"])
ADMIN = Depends(require("admin"))
REASONS = ["Academic support follow-up", "Programme progression review", "Student request", "Assessment or appeal review",
           "Welfare referral"]


def _filters(q, programme, faculty, course, activity, act_thr):
    parts, p = ["u.role = 'student'"], {"act_thr": act_thr}
    if q and q.strip():
        parts.append("(u.name ILIKE :q OR u.student_no ILIKE :q OR u.email ILIKE :q)")
        p["q"] = "%" + q.strip().replace("%", r"\%").replace("_", r"\_") + "%"
    if programme and programme != "all":
        parts.append("u.programme_id = :prog"); p["prog"] = programme
    if faculty and faculty != "all":
        parts.append("u.faculty_id = :fac"); p["fac"] = faculty
    if course and course != "all":
        parts.append("EXISTS (SELECT 1 FROM enrolments e2 WHERE e2.user_id = u.id AND e2.course_id = :course AND e2.status = 'active')")
        p["course"] = course
    if activity == "low":
        parts.append("COALESCE(CAST(u.risk->>'activity' AS FLOAT), 100) < :act_thr")
    elif activity == "over":
        parts.append("(COALESCE(CAST(u.risk->>'overdue' AS INT), 0) > 0 OR COALESCE(od.n, 0) > 0)")
    elif activity == "suspended":
        parts.append("u.status <> 'active'")
    return " AND ".join(parts), p


BASE = """
WITH ec AS (SELECT user_id, COUNT(*) AS n, AVG(NULLIF(progress, 0)) AS prog FROM enrolments WHERE status = 'active' GROUP BY user_id),
gr AS (SELECT s.user_id, AVG(s.score * 100.0 / NULLIF(a.max_score, 0)) AS pct FROM submissions s JOIN assessments a ON a.id = s.assessment_id
       WHERE s.status IN ('graded','published') AND s.score IS NOT NULL GROUP BY s.user_id),
od AS (SELECT e.user_id, COUNT(*) AS n FROM enrolments e JOIN assessments a ON a.course_id = e.course_id
       WHERE a.status = 'published' AND a.due < now() AND e.status = 'active' AND NOT EXISTS (SELECT 1 FROM submissions s
       WHERE s.assessment_id = a.id AND s.user_id = e.user_id AND s.status IN ('submitted','graded','published')) GROUP BY e.user_id),
ev AS (SELECT actor_id, MAX(ts) AS ts FROM events WHERE actor_id IS NOT NULL GROUP BY actor_id)
SELECT u.id, u.name, u.student_no, u.email, u.programme_id, p.name AS programme, u.year, u.status, COALESCE(ec.n, 0) AS courses,
       CAST(u.risk->>'activity' AS FLOAT) AS activity, COALESCE(gr.pct, CAST(u.risk->>'avg' AS FLOAT)) AS avg,
       GREATEST(u.last_login_at, ev.ts) AS last_seen, u.risk->>'lastActive' AS last_active_hint,
       COALESCE(od.n, 0) AS overdue_live, COALESCE(CAST(u.risk->>'overdue' AS INT), 0) AS overdue_rec
FROM users u LEFT JOIN programmes p ON p.id = u.programme_id LEFT JOIN ec ON ec.user_id = u.id LEFT JOIN gr ON gr.user_id = u.id
LEFT JOIN od ON od.user_id = u.id LEFT JOIN ev ON ev.actor_id = u.id
WHERE {where}"""

SORTS = {"name": "u.name", "activity": "activity NULLS LAST", "avg": "avg NULLS LAST", "last": "last_seen DESC NULLS LAST",
         "year": "u.year NULLS LAST, u.name"}


def _row(r) -> dict:
    return {"id": r.id, "name": r.name, "student_no": r.student_no, "email": r.email, "programme_id": r.programme_id,
            "programme": r.programme, "year": r.year, "status": r.status, "courses": int(r.courses), "activity": r1(r.activity),
            "avg": r1(r.avg), "last_seen": r.last_seen.isoformat() if r.last_seen else None, "last_active_hint": r.last_active_hint,
            "overdue": max(int(r.overdue_live), int(r.overdue_rec))}


@router.get("/students")
async def students(q: str | None = Query(None, max_length=100), programme: str | None = None, faculty: str | None = None,
                   course: str | None = None, activity: str = Query("all", pattern="^(all|low|over|suspended)$"),
                   sort: str = Query("name", pattern="^(name|activity|avg|last|year)$"),
                   page: int = Query(1, ge=1, le=10000), size: int = Query(25, ge=5, le=100),
                   db: AsyncSession = Depends(get_db), _: User = ADMIN):
    rules = await risk_rules(db)
    where, p = _filters(q, programme, faculty, course, activity, rules["activity_below"])
    sql = BASE.format(where=where)
    total = (await db.execute(text(f"SELECT COUNT(*) FROM ({sql}) t"), p)).scalar()
    rows = (await db.execute(text(f"{sql} ORDER BY {SORTS[sort]}, u.id LIMIT :lim OFFSET :off"),
                             {**p, "lim": size, "off": (page - 1) * size})).all()
    all_students = (await db.execute(text("SELECT COUNT(*) FROM users WHERE role = 'student'"))).scalar()
    return {"items": [_row(r) for r in rows], "total": int(total), "page": page, "size": size, "all": int(all_students),
            "reasons": REASONS}


@router.get("/students.csv")
async def students_csv(q: str | None = Query(None, max_length=100), programme: str | None = None, faculty: str | None = None,
                       course: str | None = None, activity: str = Query("all", pattern="^(all|low|over|suspended)$"),
                       db: AsyncSession = Depends(get_db), user: User = ADMIN):
    rules = await risk_rules(db)
    where, p = _filters(q, programme, faculty, course, activity, rules["activity_below"])
    rows = (await db.execute(text(BASE.format(where=where) + " ORDER BY u.name"), p)).all()
    await audit(db, user, "Exported student directory", "export", f"{len(rows)} learners",
                detail={"q": q, "programme": programme, "faculty": faculty, "course": course, "activity": activity})
    await db.commit()
    gen = now().isoformat(timespec="seconds")

    def it():
        yield ["Student directory export", f"Generated {gen}", "Synthetic demo data"]
        yield ["Name", "Student ID", "Email", "Programme", "Year", "Courses", "Activity score", "Average mark %", "Last active", "Overdue", "Status"]
        for r in rows:
            d = _row(r)
            yield [d["name"], d["student_no"], d["email"], d["programme"], d["year"], d["courses"], d["activity"], d["avg"],
                   d["last_seen"] or d["last_active_hint"], d["overdue"], d["status"]]
    return StreamingResponse(csv_stream(it()), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="student-directory.csv"'})


class OpenRecord(BaseModel):
    reason: str = Field(min_length=3, max_length=120)
    detail: str | None = Field(None, max_length=500)


@router.post("/students/{sid}/record")
async def open_record(sid: str, body: OpenRecord, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    reason = body.reason.strip()
    detail = (body.detail or "").strip()
    if reason not in REASONS and reason != "Other":
        raise HTTPException(422, "Choose a reason for access from the list.")
    if reason == "Other" and len(detail) < 10:
        raise HTTPException(422, "Describe the reason for access (at least 10 characters).")
    u = await db.get(User, sid)
    if not u or u.role != "student":
        raise HTTPException(404, "Student not found.")
    full_reason = f"{reason}: {detail}" if detail else reason
    await audit(db, user, "Viewed student record", "data", f"{u.name} ({u.student_no or u.id})", reason=full_reason)
    await db.commit()

    prog = await db.get(Programme, u.programme_id) if u.programme_id else None
    enrol = (await db.execute(text("""
        SELECT c.id, c.code, c.title, c.term, l.name AS lecturer, e.progress, e.status, e.created_at
        FROM enrolments e JOIN courses c ON c.id = e.course_id LEFT JOIN users l ON l.id = c.lecturer_id
        WHERE e.user_id = :u ORDER BY c.code"""), {"u": sid})).all()
    risk = u.risk or {}
    grades = (await db.execute(text("""
        SELECT a.id, c.code, a.title, a.type, a.due, a.max_score, s.status, s.score, s.submitted_at, s.late
        FROM assessments a JOIN courses c ON c.id = a.course_id
        JOIN enrolments e ON e.course_id = a.course_id AND e.user_id = :u
        LEFT JOIN LATERAL (SELECT * FROM submissions s WHERE s.assessment_id = a.id AND s.user_id = :u
                           ORDER BY s.attempt DESC LIMIT 1) s ON TRUE
        WHERE a.status = 'published' ORDER BY a.due NULLS LAST"""), {"u": sid})).all()
    vf = (await db.execute(text("""
        SELECT s.id, l.title, c.code, s.status, s.started_at, s.ended_at, s.created_at, s.outcome,
          (SELECT COUNT(*) FROM vf_attempts a WHERE a.session_id = s.id) AS attempts,
          (SELECT COUNT(*) FROM vf_attempts a WHERE a.session_id = s.id AND a.n = 1) AS first_n,
          (SELECT COUNT(*) FROM vf_attempts a WHERE a.session_id = s.id AND a.n = 1 AND a.verdict = 'correct') AS first_ok,
          (SELECT COALESCE(SUM(a.hints_before), 0) FROM vf_attempts a WHERE a.session_id = s.id) AS hints
        FROM vf_sessions s JOIN lessons l ON l.id = s.lesson_id JOIN courses c ON c.id = l.course_id
        WHERE s.user_id = :u AND s.status <> 'superseded' ORDER BY s.created_at DESC LIMIT 50"""), {"u": sid})).all()
    reviews = (await db.execute(text("""
        SELECT r.kind, r.checkpoint_id, r.status, c.code, r.created_at FROM review_items r JOIN courses c ON c.id = r.course_id
        WHERE r.student_id = :u ORDER BY r.created_at DESC"""), {"u": sid})).all()
    last = (await db.execute(text("SELECT MAX(ts) FROM events WHERE actor_id = :u"), {"u": sid})).scalar()
    last_seen = max([d for d in (last, u.last_login_at) if d], default=None)
    rules = await risk_rules(db)
    assisted = (await assisted_counts(db, [sid])).get(sid, 0)
    outcomes: dict[str, int] = {}
    for s in vf:
        for v in (s.outcome or {}).values():
            outcomes[v] = outcomes.get(v, 0) + 1
    first_n = sum(int(s.first_n) for s in vf); first_ok = sum(int(s.first_ok) for s in vf)
    graded = [g for g in grades if g.status in ("graded", "published") and g.score is not None]
    return {
        "profile": {"id": u.id, "name": u.name, "email": u.email, "student_no": u.student_no, "programme": prog.name if prog else None,
                    "year": u.year, "status": u.status, "last_seen": last_seen.isoformat() if last_seen else None,
                    "last_active_hint": risk.get("lastActive"), "inactive_days": inactive_days(risk, last_seen)},
        "indicators": {k: risk.get(k) for k in ("activity", "avg", "completion", "overdue", "trend")},
        "enrolments": [{"course_id": e.id, "code": e.code, "title": e.title, "term": e.term, "lecturer": e.lecturer,
                        "progress": e.progress or risk.get("completion"), "progress_tracked": bool(e.progress), "status": e.status}
                       for e in enrol],
        "grades": [{"code": g.code, "title": g.title, "type": g.type, "due": g.due.isoformat() if g.due else None, "max": g.max_score,
                    "status": g.status or ("missing" if g.due and g.due < now() else "not started"),
                    "score": g.score if g.status in ("graded", "published") else None,
                    "pct": r1(g.score * 100 / g.max_score) if g.score is not None and g.max_score and g.status in ("graded", "published") else None,
                    "submitted_at": g.submitted_at.isoformat() if g.submitted_at else None, "late": bool(g.late)} for g in grades],
        "grade_mean": r1(sum(g.score * 100 / g.max_score for g in graded) / len(graded)) if graded else None,
        "vf": {"sessions": len(vf), "completed": sum(1 for s in vf if s.status == "completed"),
               "first_try": r1(first_ok * 100 / first_n) if first_n else None, "hints": sum(int(s.hints) for s in vf),
               "outcomes": outcomes, "assisted": assisted,
               "recent": [{"lesson": s.title, "code": s.code, "status": s.status,
                           "at": (s.started_at or s.created_at).isoformat() if (s.started_at or s.created_at) else None,
                           "outcome": s.outcome or {}, "attempts": int(s.attempts)} for s in vf[:8]],
               "reviews": [{"kind": r.kind, "checkpoint": r.checkpoint_id, "status": r.status, "code": r.code,
                            "at": r.created_at.isoformat() if r.created_at else None} for r in reviews[:10]]},
        "signals": risk_reasons(risk, rules, last_seen, assisted),
        "followup": risk.get("followup"),
        "access": {"reason": full_reason, "at": now().isoformat(), "by": user.name},
    }
