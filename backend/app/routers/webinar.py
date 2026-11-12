"""Public webinar pages: event details and self-registration (no sign-in).

Abuse controls: per-IP and per-email rate limits (Redis), a hidden honeypot field, strict field validation.
Registering again with the same email updates the earlier registration and returns the same reference.
"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import get_settings
from ..core.db import get_db
from ..core.ratelimit import hit
from ..models import Webinar, WebinarRegistration
from ..services import mail

router = APIRouter(prefix="/api/webinar", tags=["webinar-public"])
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
PHONE_RE = re.compile(r"^\+?[0-9 ()\-]{6,24}$")
ROLES = ("student", "faculty", "professional", "other")
REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _clean(s: str | None, n: int) -> str | None:
    if s is None:
        return None
    s = re.sub(r"[\x00-\x1f\x7f]", " ", s).strip()
    s = re.sub(r"\s{2,}", " ", s)
    return s[:n] or None


def public_view(w: Webinar, registered: int | None = None) -> dict:
    m = w.meta or {}
    full = bool(w.capacity and registered is not None and registered >= w.capacity)
    return {"id": w.id, "title": w.title, "presenters": w.presenters, "kicker": w.kicker, "summary": w.summary,
            "when": w.when_text, "starts_at": w.starts_at.isoformat() if w.starts_at else None,
            "duration_min": w.duration_min, "where": w.where_text,
            "open": w.status == "open" and not full, "full": full,
            "tracks": m.get("tracks", []), "videos": m.get("videos", {}), "posters": m.get("posters", {})}


async def _get(db: AsyncSession, wid: str) -> Webinar:
    w = await db.get(Webinar, wid)
    if not w:
        raise HTTPException(404, "This event doesn't exist or has been removed.")
    return w


async def _count(db: AsyncSession, wid: str) -> int:
    return (await db.execute(select(func.count()).select_from(WebinarRegistration)
                             .where(WebinarRegistration.webinar_id == wid, WebinarRegistration.status != "cancelled"))).scalar_one()


async def _unsub(db: AsyncSession, t: str) -> dict:
    rid = mail.check_token(t)
    r = await db.get(WebinarRegistration, rid) if rid else None
    if not r:
        raise HTTPException(404, "This unsubscribe link isn't valid.")
    if not r.unsubscribed_at:
        r.unsubscribed_at = datetime.now(timezone.utc)
        await db.commit()
    return {"ok": True, "email": r.email[:2] + "…@" + r.email.split("@")[-1]}


@router.post("/unsubscribe")
async def unsubscribe(t: str, db: AsyncSession = Depends(get_db)):
    """Used by the unsubscribe page and by mail clients' one-click unsubscribe (RFC 8058)."""
    return await _unsub(db, t)


@router.get("/unsubscribe")
async def unsubscribe_link(t: str):
    return RedirectResponse(f"/webinar/unsubscribe?t={t}", status_code=303)


@router.get("/{wid}")
async def info(wid: str, db: AsyncSession = Depends(get_db)):
    w = await _get(db, wid)
    return public_view(w, await _count(db, wid) if w.capacity else None)


class RegIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    email: str = Field(max_length=200)
    phone: str | None = Field(None, max_length=32)
    role: str
    institution: str = Field(min_length=2, max_length=200)
    programme: str | None = Field(None, max_length=120)
    year_of_study: str | None = Field(None, max_length=24)
    city: str | None = Field(None, max_length=120)
    question: str | None = Field(None, max_length=600)
    consent: bool
    consent_updates: bool = False
    source: str | None = Field(None, max_length=48)
    utm: dict[str, str] = Field(default_factory=dict)
    website: str | None = None  # honeypot: humans never fill it

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if not v:
            return None
        if not PHONE_RE.match(v) or sum(c.isdigit() for c in v) < 6:
            raise ValueError("Enter a valid phone number, with country code (e.g. +230 5xxx xxxx).")
        return v

    @field_validator("role")
    @classmethod
    def _role(cls, v: str) -> str:
        if v not in ROLES:
            raise ValueError("Choose who you are.")
        return v


def _ip(request: Request) -> str:
    return request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()


def _new_ref(prefix: str) -> str:
    return f"{prefix}-" + "".join(secrets.choice(REF_ALPHABET) for _ in range(6))


@router.post("/{wid}/register")
async def register(wid: str, body: RegIn, request: Request, db: AsyncSession = Depends(get_db)):
    w = await _get(db, wid)
    ip = _ip(request)
    if not await hit(f"webinar:ip:{ip}", 12, 600) or not await hit(f"webinar:em:{body.email}", 5, 600):
        raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")
    if not body.consent:
        raise HTTPException(422, "Please agree to be contacted about this webinar so we can send you the joining details.")
    if body.website:  # bot: pretend success, store nothing
        return {"ok": True, "ref": _new_ref((w.meta or {}).get("ref_prefix", "WB")), "name": body.name.strip(), "already": False}

    existing = (await db.execute(select(WebinarRegistration).where(WebinarRegistration.webinar_id == wid,
                                                                     WebinarRegistration.email == body.email))).scalar_one_or_none()
    if w.status != "open" and not existing:
        raise HTTPException(409, "Registration for this event is closed.")
    if w.capacity and not existing and await _count(db, wid) >= w.capacity:
        raise HTTPException(409, "This event is full. Thank you for your interest.")

    salt = get_settings().jwt_secret[:16]
    fields = dict(
        name=_clean(body.name, 200), phone=body.phone, role=body.role, institution=_clean(body.institution, 200),
        programme=_clean(body.programme, 120), year_of_study=_clean(body.year_of_study, 24), city=_clean(body.city, 120),
        question=_clean(body.question, 600), consent_updates=body.consent_updates,
        ip_hash=hashlib.sha256((salt + ip).encode()).hexdigest(),
        user_agent=(request.headers.get("user-agent") or "")[:300] or None,
    )
    if existing:
        for k, v in fields.items():
            setattr(existing, k, v)
        if existing.status == "cancelled":
            existing.status = "registered"
        if body.consent_updates:
            existing.unsubscribed_at = None
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        return {"ok": True, "ref": existing.ref, "name": existing.name, "already": True, "email": existing.email}

    source = re.sub(r"[^a-z0-9_\-]", "", (body.source or "direct").lower())[:48] or "direct"
    utm = {k[:24]: str(v)[:120] for k, v in list(body.utm.items())[:6] if k.startswith("utm_")}
    for _ in range(5):
        reg = WebinarRegistration(webinar_id=wid, email=body.email, ref=_new_ref((w.meta or {}).get("ref_prefix", "WB")),
                                  source=source, utm=utm, **fields)
        db.add(reg)
        try:
            await db.flush()
            if mail.configured():
                s_, h_, t_ = mail.confirmation(w, reg)
                mail.queue(db, "confirmation", reg.email, s_, h_, t_, registration_id=reg.id)
            await db.commit()
            return {"ok": True, "ref": reg.ref, "name": reg.name, "already": False, "email": reg.email}
        except IntegrityError:  # ref collision, or a double-submit raced us on the email
            await db.rollback()
            again = (await db.execute(select(WebinarRegistration).where(WebinarRegistration.webinar_id == wid,
                                                                          WebinarRegistration.email == body.email))).scalar_one_or_none()
            if again:
                return {"ok": True, "ref": again.ref, "name": again.name, "already": True, "email": again.email}
    raise HTTPException(500, "Couldn't save your registration. Try again.")


@router.get("/{wid}/calendar.ics")
async def ics(wid: str, db: AsyncSession = Depends(get_db)):
    w = await _get(db, wid)
    if not w.starts_at:
        raise HTTPException(404, "The date hasn't been announced yet.")
    f = lambda d: d.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")  # noqa: E731
    esc = lambda s: s.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")  # noqa: E731
    body = "\r\n".join([
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hibilter//Webinar//EN", "BEGIN:VEVENT",
        f"UID:{w.id}@hibilter-webinar", f"DTSTAMP:{f(datetime.now(timezone.utc))}",
        f"DTSTART:{f(w.starts_at)}", f"DTEND:{f(w.starts_at + timedelta(minutes=w.duration_min or 60))}",
        f"SUMMARY:{esc(w.title)}", f"DESCRIPTION:{esc((w.presenters + ' — ' if w.presenters else '') + w.where_text)}",
        f"LOCATION:{esc(w.where_text)}", "END:VEVENT", "END:VCALENDAR", ""])
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{w.id}.ics"'})

