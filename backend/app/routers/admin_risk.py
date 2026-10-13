"""Administrator: learners for follow-up (S25). Transparent rules → human review. Never an automatic decision.

Follow-up state lives in User.risk['followup'] = {owner_id, owner_name, status, notes:[{text, by, at}], updated_at, updated_by}.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import User
from ._admin_common import (FOLLOWUP_STATUSES, assisted_counts, csv_stream, now, risk_reasons, risk_rules,
                            suggested_action)

router = APIRouter(prefix="/api/admin", tags=["admin-risk"])
ADMIN = Depends(require("admin"))
TEAMS = ["Academic advisor", "Student Welfare Office", "Academic skills support"]


async def _owners(db: AsyncSession) -> list[dict]:
    staff = (await db.execute(select(User).where(User.role.in_(["lecturer", "admin"]), User.status == "active").order_by(User.name))).scalars()
    return [{"id": u.id, "name": u.name, "kind": u.role} for u in staff] + [{"id": f"team:{t}", "name": t, "kind": "team"} for t in TEAMS]


async def _flagged(db: AsyncSession, faculty: str | None, programme: str | None) -> tuple[list[dict], dict]:
    rules = await risk_rules(db)
    where, p = ["u.role = 'student'", "u.status = 'active'"], {}
    if faculty and faculty != "all":
        where.append("u.faculty_id = :fac"); p["fac"] = faculty
    if programme and programme != "all":
        where.append("u.programme_id = :prog"); p["prog"] = programme
    rows = (await db.execute(text(f"""
        WITH ev AS (SELECT actor_id, MAX(ts) AS ts FROM events WHERE actor_id IS NOT NULL GROUP BY actor_id)
        SELECT u.id, u.name, u.student_no, u.year, u.risk, p.name AS programme, f.short AS faculty,
               GREATEST(u.last_login_at, ev.ts) AS last_seen
        FROM users u LEFT JOIN programmes p ON p.id = u.programme_id LEFT JOIN faculties f ON f.id = u.faculty_id
        LEFT JOIN ev ON ev.actor_id = u.id WHERE {' AND '.join(where)} ORDER BY u.name"""), p)).all()
    assisted = await assisted_counts(db)
    out = []
    for r in rows:
        risk = r.risk or {}
        reasons = risk_reasons(risk, rules, r.last_seen, assisted.get(r.id, 0))
        fu = risk.get("followup") or {}
        if not reasons and not fu:
            continue
        out.append({"id": r.id, "name": r.name, "student_no": r.student_no, "programme": r.programme, "faculty": r.faculty,
                    "year": r.year, "reasons": reasons, "action": suggested_action(reasons) if reasons else "No rule currently met — review whether follow-up can close",
                    "owner_id": fu.get("owner_id"), "owner_name": fu.get("owner_name"), "status": fu.get("status") or "New",
                    "notes": len(fu.get("notes") or []), "updated_at": fu.get("updated_at"), "still_flagged": bool(reasons)})
    order = {s: i for i, s in enumerate(FOLLOWUP_STATUSES)}
    out.sort(key=lambda x: (order.get(x["status"], 0) >= 3, -len(x["reasons"]), x["name"]))
    return out, rules


@router.get("/risk")
async def risk_list(faculty: str | None = None, programme: str | None = None, status: str | None = None,
                    rule: str | None = Query(None, pattern="^(deadline|activity|inactive|marks|completion|vf)$"),
                    db: AsyncSession = Depends(get_db), _: User = ADMIN):
    items, rules = await _flagged(db, faculty, programme)
    counts = {s: sum(1 for i in items if i["status"] == s) for s in FOLLOWUP_STATUSES}
    by_rule: dict[str, int] = {}
    for i in items:
        for r in i["reasons"]:
            by_rule[r["k"]] = by_rule.get(r["k"], 0) + 1
    if status and status != "all":
        items = [i for i in items if i["status"] == status] if status != "open" else [i for i in items if i["status"] in FOLLOWUP_STATUSES[:3]]
    if rule:
        items = [i for i in items if any(r["k"] == rule for r in i["reasons"])]
    return {"items": items, "rules": rules, "statuses": FOLLOWUP_STATUSES, "owners": await _owners(db), "counts": counts,
            "by_rule": by_rule}


class FollowupIn(BaseModel):
    owner_id: str | None = Field(None, max_length=80)
    status: str | None = None


@router.patch("/risk/{sid}")
async def update_followup(sid: str, body: FollowupIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    u = await db.get(User, sid)
    if not u or u.role != "student":
        raise HTTPException(404, "Student not found.")
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(422, "Nothing to update.")
    risk = dict(u.risk or {}); fu = dict(risk.get("followup") or {})
    changes = []
    if "status" in data:
        if data["status"] not in FOLLOWUP_STATUSES:
            raise HTTPException(422, f"Status must be one of: {', '.join(FOLLOWUP_STATUSES)}.")
        if fu.get("status", "New") != data["status"]:
            changes.append(f"status → {data['status']}")
        fu["status"] = data["status"]
    if "owner_id" in data:
        oid = data["owner_id"] or None
        if oid is None:
            name = None
        else:
            owner = next((o for o in await _owners(db) if o["id"] == oid), None)
            if not owner:
                raise HTTPException(422, "Choose an active staff member or support team.")
            name = owner["name"]
        if fu.get("owner_id") != oid:
            changes.append(f"assigned to {name or 'Unassigned'}")
        fu["owner_id"], fu["owner_name"] = oid, name
    if not changes:
        return {"ok": True, "followup": fu}
    fu.setdefault("status", "New")
    fu["updated_at"], fu["updated_by"] = now().isoformat(), user.name
    risk["followup"] = fu
    u.risk = risk
    await audit(db, user, "Updated follow-up", "access", f"{u.name}: {'; '.join(changes)}")
    await db.commit()
    return {"ok": True, "followup": fu}


@router.get("/risk/{sid}/notes")
async def notes(sid: str, db: AsyncSession = Depends(get_db), _: User = ADMIN):
    u = await db.get(User, sid)
    if not u or u.role != "student":
        raise HTTPException(404, "Student not found.")
    return ((u.risk or {}).get("followup") or {}).get("notes") or []


class NoteIn(BaseModel):
    text: str = Field(min_length=3, max_length=1000)


@router.post("/risk/{sid}/notes", status_code=201)
async def add_note(sid: str, body: NoteIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    u = await db.get(User, sid)
    if not u or u.role != "student":
        raise HTTPException(404, "Student not found.")
    t = body.text.strip()
    if len(t) < 3:
        raise HTTPException(422, "Write a note of at least 3 characters.")
    risk = dict(u.risk or {}); fu = dict(risk.get("followup") or {})
    fu["notes"] = [*(fu.get("notes") or []), {"text": t, "by": user.name, "by_id": user.id, "at": now().isoformat()}]
    fu.setdefault("status", "New"); fu["updated_at"], fu["updated_by"] = now().isoformat(), user.name
    risk["followup"] = fu; u.risk = risk
    await audit(db, user, "Added follow-up note", "access", u.name)
    await db.commit()
    return fu["notes"]


@router.get("/risk.csv")
async def risk_csv(faculty: str | None = None, programme: str | None = None, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    items, rules = await _flagged(db, faculty, programme)
    await audit(db, user, "Exported learners for follow-up", "export", f"{len(items)} learners", detail={"faculty": faculty, "programme": programme})
    await db.commit()
    gen = now().isoformat(timespec="seconds")

    def it():
        yield ["Learners for follow-up", f"Generated {gen}", "Prompts for human review — not predictions or decisions", "Synthetic demo data"]
        yield ["Student", "Student ID", "Programme", "Reasons", "Rules", "Suggested support", "Assigned to", "Status", "Notes"]
        for i in items:
            yield [i["name"], i["student_no"], i["programme"], "; ".join(r["t"] for r in i["reasons"]),
                   "; ".join(r["rule"] for r in i["reasons"]), i["action"], i["owner_name"] or "", i["status"], i["notes"]]
    return StreamingResponse(csv_stream(it()), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="learners-for-follow-up.csv"'})
