"""Administrator: system settings and the audit log (S29)."""
from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit, verify_chain
from ..core.db import get_db
from ..core.deps import require
from ..models import AuditLog, Setting, User
from ._admin_common import RISK_DEFAULTS, csv_stream, now, parse_date
from ..core.db import SessionLocal

router = APIRouter(prefix="/api/admin", tags=["admin-settings"])
ADMIN = Depends(require("admin"))
KINDS = ("content", "grade", "access", "export", "system", "auth", "data")

AI_DEFAULTS = {"assistant": True, "label_ai": True, "retention_days": 365, "lecturer_see_answers": True, "ai_sets_grades": False}
VF_DEFAULTS = {"hints": True, "assisted": True, "threshold": "required", "engine": "auto", "memory": False, "max_attempts": 3}


class AiIn(BaseModel):
    assistant: bool
    retention_days: int = Field(ge=30, le=3650)
    lecturer_see_answers: bool = True


class VfIn(BaseModel):
    hints: bool
    assisted: bool
    threshold: str = Field(pattern="^(required|all)$")
    engine: str = Field(pattern="^(auto|rubric|claude)$")
    memory: bool
    max_attempts: int = Field(ge=1, le=5)


class RiskIn(BaseModel):
    activity_below: int = Field(ge=0, le=100)
    inactive_days: int = Field(ge=0, le=90)
    avg_below: int = Field(ge=0, le=100)
    overdue_min: int = Field(ge=0, le=20)
    completion_below: int = Field(ge=0, le=100)
    vf_assisted: bool


SCHEMAS = {"ai": (AiIn, AI_DEFAULTS), "vf": (VfIn, VF_DEFAULTS), "risk": (RiskIn, RISK_DEFAULTS)}


async def _all(db: AsyncSession) -> dict:
    rows = {s.key: s.value for s in (await db.execute(select(Setting).where(Setting.key.in_(list(SCHEMAS))))).scalars()}
    out = {k: {**d, **(rows.get(k) or {})} for k, (_, d) in SCHEMAS.items()}
    out["ai"]["label_ai"] = True       # policy: AI content is always labelled
    out["ai"]["ai_sets_grades"] = False  # policy: AI never sets official grades
    return out


@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    return await _all(db)


@router.put("/settings/{key}")
async def put_setting(key: str, body: dict, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    if key not in SCHEMAS:
        raise HTTPException(404, "Unknown settings group.")
    model, defaults = SCHEMAS[key]
    try:
        val = model(**body).model_dump()
    except Exception as e:  # pydantic ValidationError → plain message
        msg = getattr(e, "errors", lambda: [{"msg": str(e)}])()[0]
        raise HTTPException(422, f"{'.'.join(str(x) for x in msg.get('loc', []))}: {msg.get('msg')}".strip(": "))
    row = await db.get(Setting, key)
    before = {**defaults, **((row.value if row else None) or {})}
    if key == "ai":
        val.update({"label_ai": True, "ai_sets_grades": False})
    new = {**before, **val}
    diff = {k: [before.get(k), v] for k, v in new.items() if before.get(k) != v}
    if not diff:
        return (await _all(db))[key]
    if row:
        row.value = new
    else:
        db.add(Setting(key=key, value=new))
    await audit(db, user, "Changed settings", "system", {"ai": "AI & data", "vf": "Virtual faculty defaults", "risk": "Support rules"}[key],
                detail={k: [str(a), str(b)] for k, (a, b) in diff.items()})
    await db.commit()
    return (await _all(db))[key]


# ---------- audit log ----------
def _conds(kind, actor, frm, to, q):
    c = []
    if kind and kind != "all":
        if kind not in KINDS:
            raise HTTPException(422, "Unknown event type.")
        c.append(AuditLog.kind == kind)
    if actor and actor.strip():
        c.append(AuditLog.actor_name.ilike("%" + actor.strip().replace("%", r"\%") + "%"))
    d0, d1 = parse_date(frm, "From"), parse_date(to, "To")
    if d0 and d1 and d0 > d1:
        raise HTTPException(422, "The start date is after the end date.")
    if d0:
        c.append(AuditLog.ts >= d0)
    if d1:
        c.append(AuditLog.ts < d1 + timedelta(days=1))
    if q and q.strip():
        like = "%" + q.strip().replace("%", r"\%") + "%"
        c.append(or_(AuditLog.action.ilike(like), AuditLog.obj.ilike(like), AuditLog.reason.ilike(like)))
    return c


def _row(a: AuditLog) -> dict:
    return {"id": a.id, "ts": a.ts.isoformat(), "actor": a.actor_name, "actor_id": a.actor_id, "action": a.action, "kind": a.kind,
            "obj": a.obj, "reason": a.reason, "detail": a.detail or {}, "hash": a.hash}


@router.get("/audit")
async def audit_log(kind: str | None = None, actor: str | None = Query(None, max_length=100), frm: str | None = Query(None, alias="from"),
                    to: str | None = None, q: str | None = Query(None, max_length=100), page: int = Query(1, ge=1, le=100000),
                    size: int = Query(25, ge=5, le=200), db: AsyncSession = Depends(get_db), _: User = ADMIN):
    c = _conds(kind, actor, frm, to, q)
    total = (await db.execute(select(func.count()).select_from(AuditLog).where(*c))).scalar()
    rows = (await db.execute(select(AuditLog).where(*c).order_by(AuditLog.id.desc()).limit(size).offset((page - 1) * size))).scalars().all()
    kinds = dict((await db.execute(select(AuditLog.kind, func.count()).group_by(AuditLog.kind))).all())
    return {"items": [_row(a) for a in rows], "total": int(total), "page": page, "size": size, "kinds": kinds}


@router.get("/audit.csv")
async def audit_csv(kind: str | None = None, actor: str | None = Query(None, max_length=100), frm: str | None = Query(None, alias="from"),
                    to: str | None = None, q: str | None = Query(None, max_length=100), db: AsyncSession = Depends(get_db),
                    user: User = ADMIN):
    c = _conds(kind, actor, frm, to, q)
    n = (await db.execute(select(func.count()).select_from(AuditLog).where(*c))).scalar()
    last_id = (await db.execute(select(func.max(AuditLog.id)))).scalar() or 0
    await audit(db, user, "Exported audit log", "export", f"{n} entries", detail={"kind": kind, "actor": actor, "from": frm, "to": to, "q": q})
    await db.commit()
    gen = now().isoformat(timespec="seconds")
    stmt = select(AuditLog).where(*c, AuditLog.id <= last_id).order_by(AuditLog.id)

    async def it():
        for chunk in csv_stream([["Audit log export", f"Generated {gen}", f"{n} entries"],
                                 ["ID", "Time (UTC)", "Who", "Action", "Object", "Type", "Reason", "Detail", "Hash"]]):
            yield chunk
        # Fresh session: the request-scoped one is closed once the response starts streaming.
        async with SessionLocal() as s2:
            res = await s2.stream(stmt.execution_options(yield_per=500))
            async for (a,) in res:
                line = [a.id, a.ts.isoformat(), a.actor_name, a.action, a.obj, a.kind, a.reason or "",
                        "; ".join(f"{k}={v}" for k, v in (a.detail or {}).items()), a.hash]
                yield "".join(list(csv_stream([line]))[1:])
    return StreamingResponse(it(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="audit-log-{now().date()}.csv"'})


@router.get("/audit/verify")
async def verify(db: AsyncSession = Depends(get_db), _: User = ADMIN):
    ok, n = await verify_chain(db)
    total = (await db.execute(select(func.count()).select_from(AuditLog))).scalar()
    return {"ok": ok, "checked": n if ok else None, "first_broken_id": None if ok else n, "total": int(total),
            "verified_at": now().isoformat()}
