"""Shared helpers for the administrator portal (not a router: leading underscore skips auto-registration).

Metric definitions (shown verbatim in the UI and in every export):
- Completion % — average tracked progress per enrolment; where an enrolment has no tracked progress yet, the learner's
  cached completion indicator (User.risk.completion) is used.
- Mean mark % — graded/published submission marks (score ÷ max) per enrolment; where nothing is graded yet in that
  course, the learner's recorded average (User.risk.avg) is used.
- Weekly active — learners with at least one recorded activity event or sign-in in the last 7 days.
- Overdue — published assessments past their due date with no submitted/graded submission from an enrolled learner.
"""
from __future__ import annotations

import csv
import re
import io
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Setting

DEFS = {
    "learners": "Distinct learners with at least one active enrolment in a course in the selected scope.",
    "active": "Learners with at least one recorded learning activity or sign-in in the last 7 days.",
    "completion": "Average tracked progress per enrolment. Where an enrolment has no tracked progress yet, the learner's recorded completion indicator is used.",
    "mark": "Graded or published submission marks (score ÷ maximum) per enrolment. Where nothing is graded yet in a course, the learner's recorded average is used.",
    "overdue": "Published assessments past their due date with no submitted or graded submission from an enrolled learner.",
    "flagged": "Learners meeting at least one support rule (see Learners for follow-up). Requires human review — never an automatic decision.",
    "pass": "Share of marks at or above 40%.",
    "vf": "Virtual-faculty classroom sessions (excluding sessions replaced by a restart).",
}

RISK_DEFAULTS = {"activity_below": 35, "inactive_days": 9, "avg_below": 62, "overdue_min": 1, "completion_below": 25,
                 "vf_assisted": True}
FOLLOWUP_STATUSES = ["New", "Contacted", "Support in place", "Resolved", "Not needed"]


def now() -> datetime:
    return datetime.now(timezone.utc)


def scope_sql(faculty: str | None = None, programme: str | None = None, term: str | None = None,
              course: str | None = None, alias: str = "c") -> tuple[str, dict]:
    """WHERE fragment restricting courses (alias c) to the admin filter scope. Values are bound, never interpolated."""
    parts, p = [f"{alias}.status <> 'archived'"], {}
    if faculty and faculty != "all":
        parts.append(f"{alias}.faculty_id = :f_fac"); p["f_fac"] = faculty
    if programme and programme != "all":
        parts.append(f"{alias}.programme_id = :f_prog"); p["f_prog"] = programme
    if term and term != "all":
        parts.append(f"{alias}.term = :f_term"); p["f_term"] = term
    if course and course != "all":
        parts.append(f"{alias}.id = :f_course"); p["f_course"] = course
    return " AND ".join(parts), p


def enr_cte(where: str) -> str:
    """CTEs giving one row per active student enrolment in scope, with effective completion/mark/overdue/last-seen."""
    return f"""
    sc AS (SELECT c.id, c.code, c.title, c.faculty_id, c.programme_id, c.lecturer_id, c.vf_enabled FROM courses c WHERE {where}),
    gr AS (SELECT s.user_id, a.course_id, AVG(s.score * 100.0 / NULLIF(a.max_score, 0)) AS pct, COUNT(*) AS n
           FROM submissions s JOIN assessments a ON a.id = s.assessment_id
           WHERE s.status IN ('graded', 'published') AND s.score IS NOT NULL GROUP BY s.user_id, a.course_id),
    od AS (SELECT e.user_id, a.course_id, COUNT(*) AS n FROM enrolments e
           JOIN assessments a ON a.course_id = e.course_id
           WHERE a.status = 'published' AND a.due < now() AND NOT EXISTS (
             SELECT 1 FROM submissions s WHERE s.assessment_id = a.id AND s.user_id = e.user_id
             AND s.status IN ('submitted', 'graded', 'published'))
           GROUP BY e.user_id, a.course_id),
    ev AS (SELECT actor_id, MAX(ts) AS ts FROM events WHERE actor_id IS NOT NULL GROUP BY actor_id),
    enr AS (SELECT e.user_id, e.course_id, sc.faculty_id, sc.programme_id,
              COALESCE(NULLIF(e.progress, 0), CAST(u.risk->>'completion' AS FLOAT), 0) AS completion,
              COALESCE(gr.pct, CAST(u.risk->>'avg' AS FLOAT)) AS mark,
              gr.pct AS graded_pct, COALESCE(gr.n, 0) AS graded_n,
              COALESCE(CAST(u.risk->>'activity' AS FLOAT), 0) AS activity,
              COALESCE(od.n, 0) AS overdue,
              GREATEST(u.last_login_at, ev.ts) AS last_seen
            FROM enrolments e JOIN sc ON sc.id = e.course_id JOIN users u ON u.id = e.user_id
            LEFT JOIN gr ON gr.user_id = e.user_id AND gr.course_id = e.course_id
            LEFT JOIN od ON od.user_id = e.user_id AND od.course_id = e.course_id
            LEFT JOIN ev ON ev.actor_id = e.user_id
            WHERE u.role = 'student' AND u.status = 'active' AND e.status = 'active')"""


def active_expr(alias: str = "enr") -> str:
    return f"({alias}.last_seen >= now() - interval '7 days')"


async def get_setting(db: AsyncSession, key: str, default: dict) -> dict:
    row = await db.get(Setting, key)
    return {**default, **((row.value if row else None) or {})}


async def risk_rules(db: AsyncSession) -> dict:
    return await get_setting(db, "risk", RISK_DEFAULTS)


def r1(v: Any) -> float | None:
    return None if v is None else round(float(v), 1)


def inactive_days(risk: dict, last_seen: datetime | None) -> int | None:
    """Days since last activity: tracked events/sign-ins first, else the imported 'lastActive' indicator."""
    if last_seen:
        return max(0, (now() - last_seen).days)
    la = str(risk.get("lastActive") or "").strip().lower()
    if not la:
        return None
    if la.startswith("today") or "h ago" in la or "min" in la:
        return 0
    if la.startswith("yesterday"):
        return 1
    m = re.match(r"(\d+)\s*(d|day|days|w|wk|week|weeks)\b", la)
    if m:
        n = int(m.group(1))
        return n * 7 if m.group(2).startswith("w") else n
    return None


def risk_reasons(risk: dict, rules: dict, last_seen: datetime | None, assisted: int, overdue_live: int = 0) -> list[dict]:
    """Transparent rule evaluation. Each reason names the rule that triggered it."""
    out = []
    od = max(int(risk.get("overdue") or 0), 0)
    if rules.get("overdue_min") and od >= rules["overdue_min"]:
        out.append({"k": "deadline", "t": f"{od} missed deadline{'s' if od != 1 else ''}",
                    "rule": f"Missed deadlines ≥ {rules['overdue_min']}"})
    act = risk.get("activity")
    if act is not None and rules.get("activity_below") and act < rules["activity_below"]:
        out.append({"k": "activity", "t": f"Low recent activity ({act}/100)", "rule": f"Activity score under {rules['activity_below']}"})
    days = inactive_days(risk, last_seen)
    if days is not None and rules.get("inactive_days"):
        if days >= rules["inactive_days"]:
            out.append({"k": "inactive", "t": f"No activity for {days} days", "rule": f"No activity for {rules['inactive_days']}+ days"})
    avg = risk.get("avg")
    if avg is not None and rules.get("avg_below") and risk.get("trend") == "down" and avg < rules["avg_below"]:
        out.append({"k": "marks", "t": f"Marks declining (avg {avg}%)", "rule": f"Falling marks with average under {rules['avg_below']}"})
    comp = risk.get("completion")
    if comp is not None and rules.get("completion_below") and comp < rules["completion_below"]:
        out.append({"k": "completion", "t": f"Low completion ({comp}%)", "rule": f"Completion under {rules['completion_below']}%"})
    if rules.get("vf_assisted") and assisted:
        out.append({"k": "vf", "t": f"Needed assisted path in a virtual lesson ({assisted})", "rule": "Assisted path needed in a virtual lesson"})
    return out


def suggested_action(reasons: list[dict]) -> str:
    ks = {r["k"] for r in reasons}
    if "deadline" in ks:
        return "Advisor check-in about workload and extensions"
    if ks & {"inactive", "activity"}:
        return "Friendly lecturer message; offer a study plan"
    if "vf" in ks:
        return "Lecturer revisits the checkpoint concept with the student"
    if "completion" in ks:
        return "Lecturer check-in on course progress"
    return "Refer to academic skills support"


async def assisted_counts(db: AsyncSession, user_ids: Iterable[str] | None = None) -> dict[str, int]:
    """Assisted virtual-faculty checkpoints per learner: review items of kind 'assisted' plus session outcomes."""
    q = """SELECT user_id, COUNT(*) FROM (
             SELECT student_id AS user_id, session_id, checkpoint_id FROM review_items WHERE kind = 'assisted'
             UNION
             SELECT s.user_id, s.id, o.key FROM vf_sessions s, json_each_text(s.outcome) o
             WHERE o.value = 'assisted' AND s.status <> 'superseded') x GROUP BY user_id"""
    rows = (await db.execute(text(q))).all()
    m = {r[0]: int(r[1]) for r in rows}
    if user_ids is not None:
        ids = set(user_ids)
        m = {k: v for k, v in m.items() if k in ids}
    return m


def parse_date(s: str | None, field: str) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(422, f"{field} must be a date (YYYY-MM-DD).")


def csv_bytes(rows: list[list[Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    return buf.getvalue()


def csv_stream(rows: Iterable[list[Any]]):
    """Yield CSV text chunk by chunk (row by row) for StreamingResponse."""
    buf = io.StringIO()
    w = csv.writer(buf)
    yield "﻿"
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)


def safe_name(s: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in s)[:80]


def iso(d: datetime | date | None) -> str | None:
    return d.isoformat() if d else None


def week_labels(start: date, end: date) -> list[date]:
    s = start - timedelta(days=start.weekday())
    out = []
    while s <= end:
        out.append(s); s += timedelta(days=7)
    return out[-16:]
