"""Administrator: webinar registrations portal — event settings, registrations, stats, CSV export.

Every settings change, status change and export is written to the audit log.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Date, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import User, Webinar, WebinarRegistration as R
from ._admin_common import csv_stream, now, safe_name
from .webinar import public_view

router = APIRouter(prefix="/api/admin/webinars", tags=["admin-webinar"])
ADMIN = Depends(require("admin"))
STATUSES = ("registered", "attended", "cancelled")
ROLE_LABEL = {"student": "Student", "faculty": "Faculty", "professional": "Working professional", "other": "Other"}


async def _w(db: AsyncSession, wid: str) -> Webinar:
    w = await db.get(Webinar, wid)
    if not w:
        raise HTTPException(404, "Webinar not found.")
    return w


def _admin_view(w: Webinar) -> dict:
    return {**public_view(w), "status": w.status, "capacity": w.capacity, "join_url": w.join_url,
            "created_at": w.created_at.isoformat() if w.created_at else None}


@router.get("")
async def list_webinars(db: AsyncSession = Depends(get_db), user: User = ADMIN):
    counts = dict((await db.execute(select(R.webinar_id, func.count()).where(R.status != "cancelled").group_by(R.webinar_id))).all())
    ws = (await db.execute(select(Webinar).order_by(Webinar.created_at.desc()))).scalars().all()
    return [{**_admin_view(w), "registrations": counts.get(w.id, 0)} for w in ws]


def _filtered(wid: str, q: str | None, status: str | None, role: str | None, programme: str | None, source: str | None):
    s = select(R).where(R.webinar_id == wid)
    if q:
        like = f"%{q.strip()[:100]}%"
        s = s.where(or_(R.name.ilike(like), R.email.ilike(like), R.institution.ilike(like), R.ref.ilike(like), R.phone.ilike(like)))
    if status and status != "all":
        s = s.where(R.status == status)
    if role and role != "all":
        s = s.where(R.role == role)
    if programme and programme != "all":
        s = s.where(R.programme == programme) if programme != "_none" else s.where(R.programme.is_(None))
    if source and source != "all":
        s = s.where(R.source == source)
    return s


def _row(r: R) -> dict:
    return {"id": r.id, "ref": r.ref, "name": r.name, "email": r.email, "phone": r.phone, "role": r.role,
            "institution": r.institution, "programme": r.programme, "year_of_study": r.year_of_study, "city": r.city,
            "question": r.question, "source": r.source, "utm": r.utm or {}, "consent_updates": r.consent_updates,
            "status": r.status, "notes": r.notes, "created_at": r.created_at.isoformat(),
            "updated_at": r.updated_at.isoformat() if r.updated_at else None}


@router.get("/{wid}")
async def detail(wid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid)
    base = select(R).where(R.webinar_id == wid, R.status != "cancelled").subquery()
    total = (await db.execute(select(func.count()).select_from(base))).scalar_one()
    t0 = now().replace(hour=0, minute=0, second=0, microsecond=0)
    today = (await db.execute(select(func.count()).select_from(base).where(base.c.created_at >= t0))).scalar_one()
    week = (await db.execute(select(func.count()).select_from(base).where(base.c.created_at >= now() - timedelta(days=7)))).scalar_one()
    cancelled = (await db.execute(select(func.count()).select_from(R).where(R.webinar_id == wid, R.status == "cancelled"))).scalar_one()
    attended = (await db.execute(select(func.count()).select_from(base).where(base.c.status == "attended"))).scalar_one()
    questions = (await db.execute(select(func.count()).select_from(base).where(base.c.question.is_not(None)))).scalar_one()

    async def by(col, limit=12):
        rows = (await db.execute(select(col, func.count()).select_from(base).group_by(col).order_by(func.count().desc()).limit(limit))).all()
        return [{"label": k if k is not None else "—", "value": v} for k, v in rows]

    day = cast(base.c.created_at, Date)
    daily = dict((await db.execute(select(day, func.count()).select_from(base)
                                   .where(base.c.created_at >= t0 - timedelta(days=29)).group_by(day))).all())
    series = [{"date": (t0 - timedelta(days=i)).date().isoformat(), "value": daily.get((t0 - timedelta(days=i)).date(), 0)}
              for i in range(29, -1, -1)]
    roles = [{**x, "label": ROLE_LABEL.get(x["label"], x["label"])} for x in await by(base.c.role)]
    sources = await by(base.c.source)
    return {"webinar": {**_admin_view(w), "summary": w.summary, "duration_min": w.duration_min},
            "kpis": {"total": total, "today": today, "week": week, "cancelled": cancelled, "attended": attended,
                     "questions": questions, "capacity": w.capacity},
            "by_programme": await by(base.c.programme), "by_role": roles, "by_source": sources,
            "by_institution": await by(base.c.institution, 10), "daily": series,
            "filters": {"programmes": sorted({x["label"] for x in await by(base.c.programme, 100)}),
                        "sources": sorted({x["label"] for x in sources})}}


@router.get("/{wid}/registrations")
async def registrations(wid: str, q: str | None = None, status: str | None = None, role: str | None = None,
                        programme: str | None = None, source: str | None = None,
                        page: int = Query(1, ge=1), size: int = Query(25, ge=1, le=200),
                        db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _w(db, wid)
    s = _filtered(wid, q, status, role, programme, source)
    total = (await db.execute(select(func.count()).select_from(s.subquery()))).scalar_one()
    rows = (await db.execute(s.order_by(R.created_at.desc()).offset((page - 1) * size).limit(size))).scalars().all()
    return {"items": [_row(r) for r in rows], "total": total}


class WebinarPatch(BaseModel):
    title: str | None = Field(None, min_length=4, max_length=200)
    presenters: str | None = Field(None, max_length=200)
    when_text: str | None = Field(None, min_length=2, max_length=120)
    starts_at: datetime | None = None
    clear_starts_at: bool = False
    duration_min: int | None = Field(None, ge=15, le=600)
    where_text: str | None = Field(None, min_length=2, max_length=120)
    join_url: str | None = Field(None, max_length=500)
    status: str | None = None
    capacity: int | None = Field(None, ge=0, le=100000)


@router.patch("/{wid}")
async def update_webinar(wid: str, body: WebinarPatch, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid)
    data = body.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in ("open", "closed"):
        raise HTTPException(422, "Status must be open or closed.")
    if data.get("join_url") and not str(data["join_url"]).startswith(("https://", "http://")):
        raise HTTPException(422, "The joining link must start with https://")
    if data.pop("clear_starts_at", False):
        data["starts_at"] = None
    if "capacity" in data and not data["capacity"]:
        data["capacity"] = None
    if "join_url" in data and not data["join_url"]:
        data["join_url"] = None
    changed = {}
    for k, v in data.items():
        if getattr(w, k) != v:
            changed[k] = str(v) if v is not None else None
            setattr(w, k, v)
    if changed:
        if set(changed) & {"when_text", "starts_at", "where_text", "join_url"}:  # starts the automatic-update hold
            w.meta = {**(w.meta or {}), "event_changed_at": datetime.now(timezone.utc).isoformat()}
        await audit(db, user, "Updated webinar", "system", w.title, detail=changed)
    await db.commit()
    return _admin_view(w)


class RegPatch(BaseModel):
    status: str | None = None
    notes: str | None = Field(None, max_length=2000)


@router.patch("/{wid}/registrations/{rid}")
async def update_registration(wid: str, rid: str, body: RegPatch, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    r = await db.get(R, rid)
    if not r or r.webinar_id != wid:
        raise HTTPException(404, "Registration not found.")
    if body.status is not None:
        if body.status not in STATUSES:
            raise HTTPException(422, "Unknown status.")
        if body.status != r.status:
            await audit(db, user, "Changed registration status", "data", f"{r.ref} · {r.name}", detail={"from": r.status, "to": body.status})
            r.status = body.status
    if body.notes is not None:
        r.notes = body.notes.strip() or None
    r.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return _row(r)


@router.get("/{wid}/registrations.csv")
async def export(wid: str, q: str | None = None, status: str | None = None, role: str | None = None,
                 programme: str | None = None, source: str | None = None,
                 db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid)
    rows = (await db.execute(_filtered(wid, q, status, role, programme, source).order_by(R.created_at))).scalars().all()
    await audit(db, user, "Exported webinar registrations", "export", w.title, detail={"rows": len(rows)})
    await db.commit()
    cols = ["Ref", "Registered at (UTC)", "Name", "Email", "Phone", "I am", "Institution", "Programme / track", "Year",
            "City", "Question for the speakers", "Source", "UTM", "Future updates", "Status", "Notes"]

    def it():
        yield cols
        for r in rows:
            yield [r.ref, r.created_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M"), r.name, r.email, r.phone,
                   ROLE_LABEL.get(r.role, r.role), r.institution, r.programme, r.year_of_study, r.city, r.question, r.source,
                   " ".join(f"{k}={v}" for k, v in (r.utm or {}).items()), "yes" if r.consent_updates else "no", r.status, r.notes]
    fn = f"{safe_name(w.id)}-registrations-{now().date().isoformat()}.csv"
    return StreamingResponse(csv_stream(it()), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{fn}"'})
