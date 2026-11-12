"""Date/time updates to registrants: sent automatically once the event details are finalised or changed.

The admin saves the date in Event details → after a short hold (EVENT_UPDATE_HOLD_MIN, so typos can be fixed)
the mailer emails every registered (not cancelled) person. Any later change to the date, time, place or joining
link sends a fresh update the same way. The admin can also send immediately, or with a custom message.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import get_settings
from ..models import EmailCampaign as C, Webinar, WebinarRegistration as R
from . import mail

log = logging.getLogger("uom.event_updates")
FIELDS = ("when", "where", "starts_at", "join_url")
TBA = re.compile(r"announc|\btba\b|\btbd\b|soon|to be (confirmed|decided)", re.I)


def snapshot(w: Webinar) -> dict:
    return {"when": w.when_text, "where": w.where_text, "starts_at": w.starts_at.isoformat() if w.starts_at else None,
            "join_url": w.join_url}


def date_set(w: Webinar) -> bool:
    return bool(w.starts_at) or not TBA.search(w.when_text or "")


def audience(wid: str):
    return select(R).where(R.webinar_id == wid, R.status != "cancelled")


async def last_update(db: AsyncSession, wid: str) -> C | None:
    return (await db.execute(select(C).where(C.webinar_id == wid, C.kind == "event_update",
                                             or_(C.status == "sending", C.status == "sent"))
                             .order_by(C.created_at.desc()).limit(1))).scalars().first()


def changed_fields(w: Webinar, told: dict | None) -> list[str]:
    snap = snapshot(w)
    return [k for k in FIELDS if (told or {}).get(k) != snap[k]] if told else [k for k in FIELDS if snap[k]]


def changed_at(w: Webinar) -> datetime | None:
    raw = (w.meta or {}).get("event_changed_at")
    try:
        return datetime.fromisoformat(raw) if raw else None
    except ValueError:
        return None


def auto_at(w: Webinar) -> datetime:
    """When the automatic update goes out: HOLD minutes after the last edit of the event details."""
    return (changed_at(w) or datetime(2000, 1, 1, tzinfo=timezone.utc)) + timedelta(minutes=get_settings().event_update_hold_min)


def default_subject(w: Webinar, told: dict | None) -> str:
    if not told:
        return f"It’s confirmed: {w.title} — {w.when_text}"[:200]
    if told.get("when") != w.when_text or told.get("starts_at") != (w.starts_at.isoformat() if w.starts_at else None):
        return f"Date update: {w.title} is now {w.when_text}"[:200]
    return f"Updated details for {w.title}"[:200]


async def queue_update(db: AsyncSession, w: Webinar, subject: str, note: str | None, by: str,
                       registered_before: datetime | None = None) -> tuple[C, int]:
    q = audience(w.id)
    if registered_before:  # people who signed up after the change already got these details in their confirmation
        q = q.where(R.created_at <= registered_before)
    regs = (await db.execute(q)).scalars().all()
    c = C(webinar_id=w.id, kind="event_update", subject=subject.strip(), content={"note": note, "event": snapshot(w)},
          status="sending" if regs else "sent", created_by=by, approved_by=by, approved_at=datetime.now(timezone.utc), recipients=len(regs))
    db.add(c)
    await db.flush()
    for r in regs:
        s, h, t = mail.event_update(w, r, c.subject, note)
        mail.queue(db, "event_update", r.email, s, h, t, campaign_id=c.id, registration_id=r.id)
    return c, len(regs)


async def auto_send(db: AsyncSession) -> None:
    """Mailer step: email registrants once finalised/changed event details have settled for the hold period."""
    if not mail.configured():
        return
    now = datetime.now(timezone.utc)
    for w in (await db.execute(select(Webinar))).scalars().all():
        if (w.meta or {}).get("auto_event_updates", True) is False or not date_set(w):
            continue
        last = await last_update(db, w.id)
        told = (last.content or {}).get("event") if last else None
        if not changed_fields(w, told) or now < auto_at(w):
            continue
        if not (await db.execute(audience(w.id).limit(1))).first():
            continue
        c, n = await queue_update(db, w, default_subject(w, told), None, "Automatic", registered_before=changed_at(w))
        await db.commit()
        log.info("automatic event update for %s queued to %d registrants (campaign %s)", w.id, n, c.id)
