"""Administrator: reporting centre (S26) — standard reports with definitions, preview, streamed CSV, saved presets."""
from __future__ import annotations

import re
import secrets
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Faculty, Setting, User
from ._admin_common import DEFS, csv_stream, now, parse_date, r1, safe_name, scope_sql, enr_cte, active_expr, risk_rules
from .admin_risk import _flagged

router = APIRouter(prefix="/api/admin", tags=["admin-reports"])
ADMIN = Depends(require("admin"))

REPORTS = {
    "eng": ("Engagement report", "Weekly active learners and activity by faculty",
            "Active learners = learners with at least one recorded learning activity or sign-in within the reporting period. "
            "Mean activity score = the learner's weekly activity indicator (0–100)."),
    "comp": ("Course completion report", "Completion by course", DEFS["completion"]),
    "assess": ("Assessment performance report", "Marks, distributions and pass rates",
               "Mean mark = average of graded or published submission marks (score ÷ maximum) submitted within the period. "
               "Pass rate = share of those marks at or above 40%."),
    "fac": ("Faculty & programme comparison", "Side-by-side indicators",
            f"Learners counted once per faculty. Completion: {DEFS['completion']} Mean mark: {DEFS['mark']}"),
    "sub": ("Outstanding submissions", "Overdue and missing work",
            "Overdue = published assessment with a due date inside the period and before today, with no submitted or graded submission from an enrolled learner."),
    "risk": ("At-risk learner report", "Learners meeting support rules",
             "Support rules as listed on the follow-up screen. These are prompts for human review — not predictions and never automatic decisions."),
    "vf": ("Virtual faculty report", "Sessions, checkpoints, assisted paths",
           "Sessions started in the period (excluding restarts). First-try correct = first attempts judged correct ÷ first attempts. "
           "Assisted = checkpoints completed through the assisted path, which a human lecturer reviews."),
}
PRESET_PREFIX = "report:"


def _period(frm: str | None, to: str | None) -> tuple[date, date]:
    d_to = parse_date(to, "To") or now().date()
    d_from = parse_date(frm, "From") or (d_to - timedelta(days=60))
    if d_from > d_to:
        raise HTTPException(422, "The start date is after the end date.")
    if (d_to - d_from).days > 1100:
        raise HTTPException(422, "Choose a period of three years or less.")
    return d_from, d_to


def _ts(d: date, end=False) -> datetime:
    return datetime.combine(d + timedelta(days=1) if end else d, time.min, tzinfo=timezone.utc)


async def build(db: AsyncSession, rid: str, faculty: str | None, d_from: date, d_to: date) -> tuple[list[str], list[list]]:
    if rid not in REPORTS:
        raise HTTPException(404, "Unknown report.")
    where, p = scope_sql(faculty=faculty)
    rules = await risk_rules(db)
    p.update({"act_thr": rules["activity_below"], "t0": _ts(d_from), "t1": _ts(d_to, True)})
    base = "WITH " + enr_cte(where)
    if rid == "eng":
        rows = (await db.execute(text(base + """,
            evp AS (SELECT actor_id, COUNT(*) AS n FROM events WHERE ts >= :t0 AND ts < :t1 GROUP BY actor_id)
            SELECT f.short, COUNT(DISTINCT enr.user_id), COUNT(DISTINCT enr.user_id) FILTER (WHERE evp.n > 0),
                   0, AVG(enr.activity)
            FROM enr JOIN faculties f ON f.id = enr.faculty_id
            LEFT JOIN evp ON evp.actor_id = enr.user_id GROUP BY f.short ORDER BY f.short"""), p)).all()
        return (["Faculty", "Learners", "Active in period", "Active %", "Mean activity score"],
                [[r[0], r[1], r[2], r1(r[2] * 100 / r[1]) if r[1] else None, r1(r[4])] for r in rows])
    if rid == "comp":
        rows = (await db.execute(text(base + """
            SELECT sc.code || ' ' || sc.title, f.short, COUNT(enr.user_id), AVG(enr.completion),
                   COUNT(*) FILTER (WHERE enr.completion >= 75)
            FROM sc JOIN faculties f ON f.id = sc.faculty_id LEFT JOIN enr ON enr.course_id = sc.id
            GROUP BY sc.code, sc.title, f.short ORDER BY sc.code"""), p)).all()
        return (["Course", "Faculty", "Learners", "Completion %", "Learners ≥ 75% complete"],
                [[r[0], r[1], r[2], r1(r[3]), r[4] if r[2] else 0] for r in rows])
    if rid == "assess":
        rows = (await db.execute(text(f"""
            WITH sc AS (SELECT c.id, c.code, c.title FROM courses c WHERE {where})
            SELECT sc.code, a.title, COUNT(s.id), AVG(s.score * 100.0 / NULLIF(a.max_score, 0)),
                   COUNT(s.id) FILTER (WHERE s.score * 100.0 / NULLIF(a.max_score, 0) >= 40) * 100.0 / NULLIF(COUNT(s.id), 0),
                   MIN(s.score * 100.0 / NULLIF(a.max_score, 0)), MAX(s.score * 100.0 / NULLIF(a.max_score, 0))
            FROM sc JOIN assessments a ON a.course_id = sc.id
            JOIN submissions s ON s.assessment_id = a.id AND s.status IN ('graded','published') AND s.score IS NOT NULL
              AND COALESCE(s.submitted_at, s.created_at) >= :t0 AND COALESCE(s.submitted_at, s.created_at) < :t1
            GROUP BY sc.code, a.title, a.due ORDER BY sc.code, a.due"""), p)).all()
        return (["Course", "Assessment", "Marks", "Mean mark %", "Pass rate %", "Lowest %", "Highest %"],
                [[r[0], r[1], r[2], r1(r[3]), r1(r[4]), r1(r[5]), r1(r[6])] for r in rows])
    if rid == "fac":
        rows = (await db.execute(text(base + f"""
            SELECT f.short, COUNT(DISTINCT enr.user_id),
                   COUNT(DISTINCT enr.user_id) FILTER (WHERE {active_expr()}) * 100.0 / NULLIF(COUNT(DISTINCT enr.user_id), 0),
                   AVG(enr.completion), AVG(enr.mark), SUM(enr.overdue), COUNT(DISTINCT enr.course_id)
            FROM enr JOIN faculties f ON f.id = enr.faculty_id GROUP BY f.short ORDER BY f.short"""), p)).all()
        return (["Faculty", "Courses", "Learners", "Weekly active %", "Completion %", "Mean mark %", "Overdue submissions"],
                [[r[0], r[6], r[1], r1(r[2]), r1(r[3]), r1(r[4]), int(r[5] or 0)] for r in rows])
    if rid == "sub":
        rows = (await db.execute(text(f"""
            WITH sc AS (SELECT c.id, c.code, c.faculty_id FROM courses c WHERE {where})
            SELECT sc.code, a.title, a.due, COUNT(e.id),
                   COUNT(e.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assessment_id = a.id
                     AND s.user_id = e.user_id AND s.status IN ('submitted','graded','published')))
            FROM sc JOIN assessments a ON a.course_id = sc.id AND a.status = 'published'
            JOIN enrolments e ON e.course_id = sc.id AND e.status = 'active'
            JOIN users u ON u.id = e.user_id AND u.role = 'student' AND u.status = 'active'
            WHERE a.due >= :t0 AND a.due < :t1 AND a.due < now()
            GROUP BY sc.code, a.title, a.due ORDER BY a.due"""), p)).all()
        return (["Course", "Assessment", "Due", "Enrolled", "Overdue (no submission)", "Overdue %"],
                [[r[0], r[1], r[2].date().isoformat() if r[2] else None, r[3], r[4], r1(r[4] * 100 / r[3]) if r[3] else None] for r in rows])
    if rid == "risk":
        items, _ = await _flagged(db, faculty, None)
        return (["Student", "Student ID", "Programme", "Reasons", "Suggested support", "Assigned to", "Status"],
                [[i["name"], i["student_no"], i["programme"], "; ".join(r["t"] for r in i["reasons"]), i["action"],
                  i["owner_name"] or "", i["status"]] for i in items])
    # vf
    rows = (await db.execute(text(f"""
        WITH sc AS (SELECT c.id, c.code FROM courses c WHERE {where}),
        ss AS (SELECT s.*, sc.code FROM vf_sessions s JOIN lessons l ON l.id = s.lesson_id JOIN sc ON sc.id = l.course_id
               WHERE s.status <> 'superseded' AND s.created_at >= :t0 AND s.created_at < :t1)
        SELECT ss.code, COUNT(DISTINCT ss.id), COUNT(DISTINCT ss.id) FILTER (WHERE ss.status = 'completed'), COUNT(DISTINCT ss.user_id),
               COUNT(a.id) FILTER (WHERE a.n = 1), COUNT(a.id) FILTER (WHERE a.n = 1 AND a.verdict = 'correct'),
               COALESCE(SUM(a.hints_before), 0),
               (SELECT COUNT(*) FROM ss s2, json_each_text(s2.outcome) o WHERE o.value = 'assisted' AND s2.code = ss.code)
        FROM ss LEFT JOIN vf_attempts a ON a.session_id = ss.id GROUP BY ss.code ORDER BY ss.code"""), p)).all()
    return (["Course", "Sessions", "Completed", "Completion %", "Learners", "First-try correct %", "Hints used", "Assisted checkpoints"],
            [[r[0], r[1], r[2], r1(r[2] * 100 / r[1]) if r[1] else None, r[3], r1(r[5] * 100 / r[4]) if r[4] else None, int(r[6]), int(r[7])]
             for r in rows])


async def _scope_name(db: AsyncSession, faculty: str | None) -> str:
    if not faculty or faculty == "all":
        return "All faculties & centres"
    f = await db.get(Faculty, faculty)
    if not f:
        raise HTTPException(422, "Unknown faculty.")
    return f.name


@router.get("/reports")
async def catalogue(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    presets = (await db.execute(select(Setting).where(Setting.key.like(PRESET_PREFIX + "%")))).scalars().all()
    return {"reports": [{"id": k, "title": t, "desc": d, "definition": df} for k, (t, d, df) in REPORTS.items()],
            "presets": sorted([{"id": s.key[len(PRESET_PREFIX):], **(s.value or {})} for s in presets], key=lambda x: x.get("name", "")),
            "default_period": {"from": (now().date() - timedelta(days=60)).isoformat(), "to": now().date().isoformat()}}


@router.get("/reports/{rid}")
async def preview(rid: str, faculty: str | None = None, frm: str | None = Query(None, alias="from"), to: str | None = None,
                  db: AsyncSession = Depends(get_db), _: User = ADMIN):
    d_from, d_to = _period(frm, to)
    cols, rows = await build(db, rid, faculty, d_from, d_to)
    t, desc, df = REPORTS[rid]
    return {"id": rid, "title": t, "desc": desc, "definition": df, "columns": cols, "rows": rows,
            "generated_at": now().isoformat(), "period": {"from": d_from.isoformat(), "to": d_to.isoformat()},
            "scope": await _scope_name(db, faculty)}


@router.get("/reports/{rid}/csv")
async def export(rid: str, faculty: str | None = None, frm: str | None = Query(None, alias="from"), to: str | None = None,
                 db: AsyncSession = Depends(get_db), user: User = ADMIN):
    d_from, d_to = _period(frm, to)
    cols, rows = await build(db, rid, faculty, d_from, d_to)
    t, _, df = REPORTS[rid]
    scope = await _scope_name(db, faculty)
    await audit(db, user, "Exported report", "export", f"{t} · {scope} · {d_from} to {d_to}", detail={"rows": len(rows)})
    await db.commit()
    gen = now().isoformat(timespec="seconds")

    def it():
        yield ["Report", t]; yield ["Generated", gen]; yield ["Period", f"{d_from} to {d_to}"]; yield ["Scope", scope]
        yield ["Definition", df]; yield ["Note", "Synthetic demo data — not official University of Mauritius figures"]; yield []
        yield cols
        yield from rows
    fn = f"{safe_name(rid)}-report-{d_from}-to-{d_to}.csv"
    return StreamingResponse(csv_stream(it()), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{fn}"'})


class PresetIn(BaseModel):
    name: str = Field(min_length=3, max_length=80)
    report: str
    faculty: str | None = Field(None, max_length=16)
    from_: str | None = Field(None, alias="from")
    to: str | None = None
    relative_days: int | None = Field(None, ge=1, le=1100)


@router.post("/report-presets", status_code=201)
async def save_preset(body: PresetIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    if body.report not in REPORTS:
        raise HTTPException(422, "Unknown report.")
    if body.from_ or body.to:
        _period(body.from_, body.to)
    await _scope_name(db, body.faculty)
    existing = (await db.execute(select(Setting).where(Setting.key.like(PRESET_PREFIX + "%")))).scalars().all()
    name = re.sub(r"\s+", " ", body.name).strip()
    if any((s.value or {}).get("name", "").lower() == name.lower() for s in existing):
        raise HTTPException(409, "A saved report with this name already exists.")
    if len(existing) >= 50:
        raise HTTPException(422, "You can keep up to 50 saved reports. Delete one first.")
    pid = secrets.token_hex(6)
    db.add(Setting(key=PRESET_PREFIX + pid, value={"name": name, "report": body.report, "faculty": body.faculty or "all",
                                                    "from": body.from_, "to": body.to, "relative_days": body.relative_days,
                                                    "created_by": user.name, "created_at": now().isoformat()}))
    await audit(db, user, "Saved report preset", "system", f"{name} ({REPORTS[body.report][0]})")
    await db.commit()
    return {"id": pid}


@router.delete("/report-presets/{pid}")
async def delete_preset(pid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    s = await db.get(Setting, PRESET_PREFIX + pid)
    if not s:
        raise HTTPException(404, "Saved report not found.")
    await db.execute(delete(Setting).where(Setting.key == s.key))
    await audit(db, user, "Deleted report preset", "system", (s.value or {}).get("name", pid))
    await db.commit()
    return {"ok": True}
