"""Administrator: shared lookup data, institutional overview (S21) and performance analytics (S24)."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.db import get_db
from ..core.deps import require
from ..models import AcademicTerm, Course, Faculty, Programme, User
from ._admin_common import (DEFS, active_expr, assisted_counts, enr_cte, now, r1, risk_reasons, risk_rules,
                            scope_sql, week_labels)

router = APIRouter(prefix="/api/admin", tags=["admin"])
ADMIN = Depends(require("admin"))


@router.get("/meta")
async def meta(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    facs = (await db.execute(select(Faculty).order_by(Faculty.name))).scalars().all()
    progs = (await db.execute(select(Programme).order_by(Programme.name))).scalars().all()
    terms = (await db.execute(select(AcademicTerm).order_by(AcademicTerm.start.desc()))).scalars().all()
    courses = (await db.execute(select(Course).order_by(Course.code))).scalars().all()
    staff = (await db.execute(select(User).where(User.role.in_(["lecturer", "admin"])).order_by(User.name))).scalars().all()
    return {
        "faculties": [{"id": f.id, "name": f.name, "short": f.short} for f in facs],
        "programmes": [{"id": p.id, "faculty_id": p.faculty_id, "name": p.name, "level": p.level, "years": p.years} for p in progs],
        "terms": [{"id": t.id, "name": t.name, "start": t.start.isoformat(), "end": t.end.isoformat(), "current": t.current} for t in terms],
        "course_terms": sorted({c.term for c in courses}),
        "courses": [{"id": c.id, "code": c.code, "title": c.title, "faculty_id": c.faculty_id, "programme_id": c.programme_id,
                     "term": c.term, "status": c.status} for c in courses],
        "staff": [{"id": u.id, "name": u.name, "role": u.role, "faculty_id": u.faculty_id, "status": u.status} for u in staff],
        "definitions": DEFS,
    }


async def _scope_rows(db: AsyncSession, faculty, programme, term, course=None):
    where, p = scope_sql(faculty, programme, term, course)
    rules = await risk_rules(db)
    p["act_thr"] = rules["activity_below"]
    base = "WITH " + enr_cte(where)
    tot = (await db.execute(text(base + f"""
        SELECT COUNT(DISTINCT user_id), COUNT(DISTINCT user_id) FILTER (WHERE {active_expr()}),
               AVG(completion), AVG(mark), SUM(overdue), SUM(graded_n), AVG(graded_pct),
               COUNT(*) FILTER (WHERE mark IS NOT NULL AND mark >= 40) * 100.0 / NULLIF(COUNT(mark), 0),
               COUNT(*) FROM enr"""), p)).one()
    fac_rows = (await db.execute(text(base + f"""
        SELECT enr.faculty_id, f.short, COUNT(DISTINCT user_id),
               COUNT(DISTINCT user_id) FILTER (WHERE {active_expr()}) * 100.0 / NULLIF(COUNT(DISTINCT user_id), 0),
               AVG(completion), AVG(mark), SUM(overdue)
        FROM enr JOIN faculties f ON f.id = enr.faculty_id GROUP BY enr.faculty_id, f.short ORDER BY f.short"""), p)).all()
    course_rows = (await db.execute(text(base + f"""
        SELECT sc.id, sc.code, sc.title, sc.faculty_id, f.short, u.name, COUNT(enr.user_id),
               AVG(enr.completion), AVG(enr.mark), COALESCE(SUM(enr.overdue), 0), SUM(enr.graded_n),
               COUNT(enr.user_id) FILTER (WHERE {active_expr()}) * 100.0 / NULLIF(COUNT(enr.user_id), 0),
               COUNT(*) FILTER (WHERE enr.mark >= 40) * 100.0 / NULLIF(COUNT(enr.mark), 0), sc.vf_enabled
        FROM sc JOIN faculties f ON f.id = sc.faculty_id LEFT JOIN users u ON u.id = sc.lecturer_id
        LEFT JOIN enr ON enr.course_id = sc.id
        GROUP BY sc.id, sc.code, sc.title, sc.faculty_id, f.short, u.name, sc.vf_enabled ORDER BY sc.code"""), p)).all()
    stu = (await db.execute(text(base + """
        SELECT x.user_id, u.risk, x.seen FROM (SELECT user_id, MAX(last_seen) AS seen FROM enr GROUP BY user_id) x
        JOIN users u ON u.id = x.user_id"""), p)).all()
    return where, p, rules, tot, fac_rows, course_rows, stu


async def _flagged(db, rules, stu) -> int:
    assisted = await assisted_counts(db, [s[0] for s in stu])
    return sum(1 for uid, risk, seen in stu if risk_reasons(risk or {}, rules, seen, assisted.get(uid, 0)))


async def _term_window(db: AsyncSession, term: str | None) -> tuple[date, date, str]:
    t = (await db.execute(select(AcademicTerm).where(AcademicTerm.current.is_(True)))).scalars().first()
    if not t:
        t = (await db.execute(select(AcademicTerm).order_by(AcademicTerm.start.desc()))).scalars().first()
    today = now().date()
    if not t:
        return today - timedelta(days=56), today, "Last 8 weeks"
    return t.start, min(t.end, today), t.name


async def _weekly(db: AsyncSession, where: str, p: dict, start: date, end: date):
    """Per-week distinct active learners (sign-ins, classroom events, submissions) and submission counts in scope."""
    weeks = week_labels(start, end)
    rows = (await db.execute(text("WITH " + enr_cte(where) + """,
        learners AS (SELECT DISTINCT user_id FROM enr),
        acts AS (SELECT actor_id AS uid, ts FROM events WHERE ts >= :ws
                 UNION ALL SELECT actor_id, ts FROM audit_log WHERE kind = 'auth' AND ts >= :ws
                 UNION ALL SELECT s.user_id, s.submitted_at FROM submissions s JOIN assessments a ON a.id = s.assessment_id
                   JOIN sc ON sc.id = a.course_id WHERE s.submitted_at >= :ws)
        SELECT date_trunc('week', acts.ts)::date AS wk, COUNT(DISTINCT acts.uid)
        FROM acts JOIN learners l ON l.user_id = acts.uid GROUP BY wk"""), {**p, "ws": weeks[0]})).all()
    subs = (await db.execute(text("WITH " + enr_cte(where) + """
        SELECT date_trunc('week', s.submitted_at)::date AS wk, COUNT(*),
               AVG(s.score * 100.0 / NULLIF(a.max_score, 0)) FILTER (WHERE s.status IN ('graded','published'))
        FROM submissions s JOIN assessments a ON a.id = s.assessment_id JOIN sc ON sc.id = a.course_id
        WHERE s.submitted_at >= :ws GROUP BY wk"""), {**p, "ws": weeks[0]})).all()
    act = {r[0]: int(r[1]) for r in rows}
    sub = {r[0]: (int(r[1]), r1(r[2])) for r in subs}
    return [{"week": f"W{i + 1}", "start": w.isoformat(), "active": act.get(w, 0), "submissions": sub.get(w, (0, None))[0],
             "graded_mean": sub.get(w, (0, None))[1]} for i, w in enumerate(weeks)]


async def _vf(db: AsyncSession, where: str, p: dict) -> dict:
    r = (await db.execute(text(f"""
        WITH sc AS (SELECT c.id FROM courses c WHERE {where}),
        ss AS (SELECT s.* FROM vf_sessions s JOIN lessons l ON l.id = s.lesson_id JOIN sc ON sc.id = l.course_id
               WHERE s.status <> 'superseded')
        SELECT (SELECT COUNT(*) FROM ss), (SELECT COUNT(*) FROM ss WHERE status = 'completed'),
               (SELECT COUNT(DISTINCT user_id) FROM ss),
               (SELECT COUNT(*) FROM vf_attempts a JOIN ss ON ss.id = a.session_id WHERE a.n = 1),
               (SELECT COUNT(*) FROM vf_attempts a JOIN ss ON ss.id = a.session_id WHERE a.n = 1 AND a.verdict = 'correct'),
               (SELECT COUNT(*) FROM ss, json_each_text(ss.outcome) o WHERE o.value = 'assisted'),
               (SELECT COUNT(*) FROM review_items r JOIN sc ON sc.id = r.course_id WHERE r.status = 'open')"""), p)).one()
    started, completed, learners, first_n, first_ok, assisted, open_reviews = [int(x or 0) for x in r]
    return {"sessions": started, "completed": completed, "learners": learners,
            "completion": r1(completed * 100 / started) if started else None,
            "first_try": r1(first_ok * 100 / first_n) if first_n else None,
            "assisted": assisted, "open_reviews": open_reviews}


def _summary(k: dict, facs: list[dict], vf: dict) -> str:
    if not k["learners"]:
        return "There are no active enrolments in this scope yet, so no summary can be produced."
    parts = [f"Across {k['learners']} learners in scope, {round(k['active_pct'] or 0)}% are currently active and average course completion is {round(k['completion'] or 0)}%."]
    if len(facs) > 1:
        lo = min(facs, key=lambda f: f["completion"] or 0); hi = max(facs, key=lambda f: f["active"] or 0)
        parts.append(f"{hi['short']} shows the highest activity ({round(hi['active'] or 0)}%), while {lo['short']} has the lowest completion ({round(lo['completion'] or 0)}%) and may benefit from follow-up.")
    parts.append(f"{k['overdue']} submissions are overdue and {k['flagged']} learners meet a support rule awaiting human review.")
    if vf["sessions"]:
        parts.append(f"The virtual faculty recorded {vf['sessions']} sessions ({vf['completed']} completed)" +
                     (f", with {round(vf['first_try'])}% of first attempts correct." if vf["first_try"] is not None else "."))
    return " ".join(parts)


@router.get("/overview")
async def overview(faculty: str | None = None, programme: str | None = None, term: str | None = None,
                   db: AsyncSession = Depends(get_db), _: User = ADMIN):
    where, p, rules, tot, fac_rows, course_rows, stu = await _scope_rows(db, faculty, programme, term)
    learners, active, completion, mark, overdue, graded_n, graded_mean, pass_rate, enrolments = tot
    flagged = await _flagged(db, rules, stu)
    k = {"learners": int(learners or 0), "active": int(active or 0),
         "active_pct": r1(active * 100 / learners) if learners else None, "completion": r1(completion), "mark": r1(mark),
         "overdue": int(overdue or 0), "flagged": flagged, "graded_n": int(graded_n or 0), "graded_mean": r1(graded_mean),
         "enrolments": int(enrolments or 0)}
    facs = [{"id": r[0], "short": r[1], "learners": int(r[2]), "active": r1(r[3]), "completion": r1(r[4]), "mark": r1(r[5]),
             "overdue": int(r[6] or 0)} for r in fac_rows]
    courses = [{"id": r[0], "code": r[1], "title": r[2], "faculty_id": r[3], "faculty": r[4], "lecturer": r[5],
                "learners": int(r[6] or 0), "completion": r1(r[7]), "mark": r1(r[8]), "overdue": int(r[9] or 0),
                "graded_n": int(r[10] or 0), "active": r1(r[11]), "vf": bool(r[13])} for r in course_rows]
    start, end, tname = await _term_window(db, term)
    trend = await _weekly(db, where, p, start, end)
    for t in trend:
        t["active_pct"] = r1(t["active"] * 100 / k["learners"]) if k["learners"] else 0
    vf = await _vf(db, where, p)
    alerts = []
    for c in courses:
        if c["learners"] and c["completion"] is not None and c["completion"] < 50:
            alerts.append({"kind": "warn", "text": f"{c['code']} completion is {round(c['completion'])}% (below 50%).", "link": "/a-perf"})
        if c["overdue"] >= 5:
            alerts.append({"kind": "bad", "text": f"{c['code']} has {c['overdue']} overdue submissions.", "link": "/a-reports"})
        if not c["lecturer"]:
            alerts.append({"kind": "warn", "text": f"{c['code']} has no lecturer assigned.", "link": "/a-structure"})
    if flagged:
        alerts.append({"kind": "info", "text": f"{flagged} learners meet a support rule and await human review.", "link": "/a-risk"})
    if vf["open_reviews"]:
        alerts.append({"kind": "info", "text": f"{vf['open_reviews']} virtual-faculty checkpoints await lecturer review.", "link": None})
    return {"kpis": k, "faculties": facs, "courses": sorted(courses, key=lambda c: -(c["completion"] or 0)), "trend": trend,
            "term": tname, "vf": vf, "alerts": alerts, "summary": _summary(k, facs, vf), "definitions": DEFS,
            "generated_at": now().isoformat()}


@router.get("/performance")
async def performance(faculty: str | None = None, programme: str | None = None, term: str | None = None,
                      course: str | None = None, rng: str = Query("sem", alias="range", pattern="^(sem|30)$"),
                      db: AsyncSession = Depends(get_db), _: User = ADMIN):
    where, p, rules, tot, fac_rows, course_rows, stu = await _scope_rows(db, faculty, programme, term, course)
    learners, active, completion, mark, overdue, graded_n, graded_mean, pass_rate, _n = tot
    # Distribution of per-enrolment marks (labelled bins).
    bins = (await db.execute(text("WITH " + enr_cte(where) + """
        SELECT LEAST(FLOOR(mark / 10), 9)::int AS b, COUNT(*) FROM enr WHERE mark IS NOT NULL GROUP BY b"""), p)).all()
    bm = {int(b): int(n) for b, n in bins}
    dist = [{"label": f"{i * 10}–{i * 10 + 9 if i < 9 else 100}", "value": bm.get(i, 0)} for i in range(10)]
    start, end, tname = await _term_window(db, term)
    if rng == "30":
        start = max(start, end - timedelta(days=30))
    trend = await _weekly(db, where, p, start, end)
    facs = [{"id": r[0], "short": r[1], "learners": int(r[2]), "active": r1(r[3]), "completion": r1(r[4]), "mark": r1(r[5])}
            for r in fac_rows]
    courses = [{"id": r[0], "code": r[1], "title": r[2], "faculty": r[4], "lecturer": r[5], "learners": int(r[6] or 0),
                "completion": r1(r[7]), "mark": r1(r[8]), "overdue": int(r[9] or 0), "graded_n": int(r[10] or 0),
                "active": r1(r[11]), "pass": r1(r[12])} for r in course_rows]
    return {"kpis": {"mark": r1(mark), "pass": r1(pass_rate), "completion": r1(completion),
                     "active_pct": r1(active * 100 / learners) if learners else None, "learners": int(learners or 0),
                     "graded_n": int(graded_n or 0), "graded_mean": r1(graded_mean), "overdue": int(overdue or 0)},
            "distribution": dist, "courses": courses, "faculties": facs, "trend": trend, "term": tname,
            "range": rng, "definitions": DEFS}


@router.get("/performance/course/{course_id}")
async def course_drill(course_id: str, db: AsyncSession = Depends(get_db), _: User = ADMIN):
    c = await db.get(Course, course_id)
    if not c:
        raise HTTPException(404, "Course not found.")
    rules = await risk_rules(db)
    assess = (await db.execute(text("""
        SELECT a.id, a.title, a.type, a.due, a.max_score, a.weight,
          (SELECT COUNT(*) FROM enrolments e WHERE e.course_id = a.course_id AND e.status = 'active') AS enrolled,
          COUNT(s.id) FILTER (WHERE s.status IN ('submitted','graded','published')) AS submitted,
          COUNT(s.id) FILTER (WHERE s.status IN ('graded','published') AND s.score IS NOT NULL) AS graded,
          AVG(s.score * 100.0 / NULLIF(a.max_score, 0)) FILTER (WHERE s.status IN ('graded','published')) AS mean,
          COUNT(s.id) FILTER (WHERE s.status IN ('graded','published') AND s.score * 100.0 / NULLIF(a.max_score,0) >= 40) AS passed,
          COUNT(s.id) FILTER (WHERE s.late) AS late
        FROM assessments a LEFT JOIN submissions s ON s.assessment_id = a.id
        WHERE a.course_id = :cid GROUP BY a.id ORDER BY a.due NULLS LAST"""), {"cid": course_id})).all()
    where, p = scope_sql(course=course_id)
    p["act_thr"] = rules["activity_below"]
    bands = (await db.execute(text("WITH " + enr_cte(where) + """
        SELECT CASE WHEN completion < 25 THEN '0–24%' WHEN completion < 50 THEN '25–49%'
                    WHEN completion < 75 THEN '50–74%' ELSE '75–100%' END AS b, COUNT(*)
        FROM enr GROUP BY b"""), p)).all()
    bm = dict(bands)
    lec = await db.get(User, c.lecturer_id) if c.lecturer_id else None
    return {"course": {"id": c.id, "code": c.code, "title": c.title, "lecturer": lec.name if lec else None, "term": c.term},
            "assessments": [{"id": r[0], "title": r[1], "type": r[2], "due": r[3].isoformat() if r[3] else None, "max": r[4],
                             "weight": r[5], "enrolled": int(r[6]), "submitted": int(r[7]), "graded": int(r[8]), "mean": r1(r[9]),
                             "pass": r1(int(r[10]) * 100 / int(r[8])) if r[8] else None, "late": int(r[11])} for r in assess],
            "progress_bands": [{"label": k, "value": int(bm.get(k, 0))} for k in ["0–24%", "25–49%", "50–74%", "75–100%"]]}
