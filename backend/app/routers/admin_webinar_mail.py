"""Administrator: webinar emails — date/time updates to registrants and the weekly newsletter (draft → approve → send).

Date/time updates go out automatically (services/event_updates) once the details are saved; the admin can also send
one now with a custom message. Newsletters never reach anyone without an explicit admin approval. Sends are audited.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.deps import require
from ..models import EmailCampaign as C, EmailMessage as M, User, Webinar, WebinarRegistration as R
from ..services import event_updates as eu, mail, newsletter

router = APIRouter(prefix="/api/admin/webinars", tags=["admin-webinar-mail"])
ADMIN = Depends(require("admin"))


async def _w(db: AsyncSession, wid: str) -> Webinar:
    w = await db.get(Webinar, wid)
    if not w:
        raise HTTPException(404, "Webinar not found.")
    return w


def _audience(wid: str, kind: str, edition: str | None):
    q = select(R).where(R.webinar_id == wid, R.status != "cancelled")
    if kind == "newsletter":
        q = q.where(R.consent_updates.is_(True), R.unsubscribed_at.is_(None))
        mba = R.programme.ilike("MBA%")
        q = q.where(mba) if edition == "mba" else q.where(or_(R.programme.is_(None), ~mba))
    return q


async def _count(db, q) -> int:
    return (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()


def _next_newsletter() -> str:
    s = get_settings(); now = datetime.now(timezone.utc)
    d = now.replace(hour=s.newsletter_hour_utc, minute=0, second=0, microsecond=0) + timedelta(days=(s.newsletter_weekday - now.weekday()) % 7)
    if d <= now:
        d += timedelta(days=7)
    return d.isoformat()


def _summary(c: C, stats: dict) -> dict:
    return {"id": c.id, "kind": c.kind, "edition": c.edition, "subject": c.subject, "status": c.status,
            "created_at": c.created_at.isoformat(), "created_by": c.created_by, "approved_by": c.approved_by,
            "approved_at": c.approved_at.isoformat() if c.approved_at else None, "recipients": c.recipients,
            "sent": stats.get((c.id, "sent"), 0), "queued": stats.get((c.id, "queued"), 0), "failed": stats.get((c.id, "failed"), 0),
            "week": (c.content or {}).get("week"), "articles": sum(len([i for i in s.get("items", []) if i.get("include", True)])
                                                                    for s in (c.content or {}).get("sections", []))}


@router.get("/{wid}/mail")
async def status(wid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid)
    s = get_settings()
    camps = (await db.execute(select(C).where(C.webinar_id == wid, C.status != "discarded").order_by(C.created_at.desc()).limit(30))).scalars().all()
    stats = {(a, b): n for a, b, n in (await db.execute(select(M.campaign_id, M.status, func.count())
                                                        .where(M.campaign_id.in_([c.id for c in camps] or [""])).group_by(M.campaign_id, M.status))).all()}
    totals = dict((await db.execute(select(M.status, func.count()).group_by(M.status))).all())
    last_upd = await eu.last_update(db, wid)
    told = (last_upd.content or {}).get("event") if last_upd else None
    needed = eu.date_set(w) and bool(eu.changed_fields(w, told))
    failed = (await db.execute(select(M).where(M.status == "failed").order_by(M.id.desc()).limit(10))).scalars().all()
    return {
        "configured": mail.configured(), "sender": mail.sender() or None, "owner_notify": s.owner_notify_email,
        "totals": {k: totals.get(k, 0) for k in ("queued", "sent", "failed")},
        "audience": {"registered": await _count(db, _audience(wid, "event_update", None)),
                     "newsletter_mba": await _count(db, _audience(wid, "newsletter", "mba")),
                     "newsletter_general": await _count(db, _audience(wid, "newsletter", "general")),
                     "unsubscribed": await _count(db, select(R).where(R.webinar_id == wid, R.unsubscribed_at.is_not(None)))},
        "update_needed": needed,
        "auto_updates": (w.meta or {}).get("auto_event_updates", True) is not False,
        "auto_at": eu.auto_at(w).isoformat() if needed else None,
        "last_update": {"at": last_upd.approved_at.isoformat() if last_upd and last_upd.approved_at else None, "event": told,
                        "by": last_upd.approved_by if last_upd else None, "recipients": last_upd.recipients if last_upd else None},
        "campaigns": [_summary(c, stats) for c in camps],
        "company": await newsletter.company(db), "next_newsletter": _next_newsletter(),
        "failed": [{"to": m.to_email, "kind": m.kind, "error": m.error, "at": m.created_at.isoformat()} for m in failed],
    }


class AnnounceIn(BaseModel):
    subject: str = Field(min_length=4, max_length=200)
    note: str | None = Field(None, max_length=3000)
    dry_run: bool = True


@router.post("/{wid}/mail/announce")
async def announce(wid: str, body: AnnounceIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid)
    regs = (await db.execute(_audience(wid, "event_update", None))).scalars().all()
    sample = regs[0] if regs else R(id="preview", name="Priya Sharma", ref="AQ-PREVIEW", email="")
    subj, html, _ = mail.event_update(w, sample, body.subject.strip(), body.note)
    if body.dry_run:
        return {"recipients": len(regs), "subject": subj, "html": html, "configured": mail.configured()}
    if not mail.configured():
        raise HTTPException(409, "Email sending isn’t connected yet.")
    if not regs:
        raise HTTPException(409, "Nobody is registered yet.")
    c, _ = await eu.queue_update(db, w, body.subject, body.note, user.name)
    await audit(db, user, "Sent webinar update", "data", w.title, detail={"recipients": len(regs), "when": w.when_text})
    await db.commit()
    return {"ok": True, "recipients": len(regs), "campaign": c.id}


async def _camp(db, wid: str, cid: str) -> C:
    c = await db.get(C, cid)
    if not c or c.webinar_id != wid:
        raise HTTPException(404, "Email not found.")
    return c


@router.get("/{wid}/campaigns/{cid}")
async def campaign(wid: str, cid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid); c = await _camp(db, wid, cid)
    if c.kind == "newsletter":
        _, html, _ = mail.newsletter(w, R(id="preview", name="Priya Sharma"), c.content or {}, c.subject)
        n = await _count(db, _audience(wid, "newsletter", c.edition))
    else:
        _, html, _ = mail.event_update(w, R(id="preview", name="Priya Sharma", ref="AQ-PREVIEW"), c.subject, (c.content or {}).get("note"))
        n = c.recipients
    return {"id": c.id, "kind": c.kind, "edition": c.edition, "subject": c.subject, "content": c.content, "status": c.status,
            "html": html, "audience": n, "label": newsletter.EDITIONS.get(c.edition or "", {}).get("label")}


class CampaignIn(BaseModel):
    subject: str = Field(min_length=4, max_length=200)
    content: dict


@router.put("/{wid}/campaigns/{cid}")
async def edit_campaign(wid: str, cid: str, body: CampaignIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    c = await _camp(db, wid, cid)
    if c.status != "draft":
        raise HTTPException(409, "Only drafts can be edited.")
    cont = dict(c.content or {})
    b = body.content
    cont["headline"] = str(b.get("headline", cont.get("headline", "")))[:120]
    cont["intro"] = str(b.get("intro", cont.get("intro", "")))[:2000]
    cont["outro"] = str(b.get("outro", cont.get("outro", "")))[:1000]
    if isinstance(b.get("sections"), list):
        old = {i["url"]: i for s in cont.get("sections", []) for i in s.get("items", [])}
        secs = []
        for s in b["sections"][:10]:
            items = [{**old[i["url"]], "note": str(i.get("note") or "")[:400], "include": bool(i.get("include", True))}
                     for i in s.get("items", [])[:10] if i.get("url") in old]  # admins curate, they can't inject links
            secs.append({"title": str(s.get("title") or "")[:100], "items": items})
        cont["sections"] = secs
    if isinstance(b.get("company"), list):
        cont["company"] = [{"name": str(x.get("name") or "")[:80], "url": str(x.get("url") or "")[:200] if str(x.get("url") or "").startswith("https://") else "",
                            "text": str(x.get("text") or "")[:1200]} for x in b["company"][:4]]
    c.content = cont
    c.subject = body.subject.strip()
    await db.commit()
    return await campaign(wid, cid, db, user)


class TestIn(BaseModel):
    to: str = Field(min_length=5, max_length=200)


@router.post("/{wid}/campaigns/{cid}/test")
async def test(wid: str, cid: str, body: TestIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid); c = await _camp(db, wid, cid)
    if not mail.configured():
        raise HTTPException(409, "Email isn’t set up yet.")
    fake = R(id="preview", name=user.name, ref="AQ-TEST00")
    s, h, t = (mail.newsletter(w, fake, c.content or {}, c.subject) if c.kind == "newsletter"
               else mail.event_update(w, fake, c.subject, (c.content or {}).get("note")))
    mail.queue(db, "test", body.to.strip(), "[Test] " + s, h, t)
    await db.commit()
    return {"ok": True}


@router.post("/{wid}/campaigns/{cid}/send")
async def send(wid: str, cid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    w = await _w(db, wid); c = await _camp(db, wid, cid)
    if c.kind != "newsletter" or c.status != "draft":
        raise HTTPException(409, "This email has already been sent or discarded.")
    if not mail.configured():
        raise HTTPException(409, "Email isn’t set up yet — add the events@hibilter.com mailbox details first.")
    regs = (await db.execute(_audience(wid, "newsletter", c.edition))).scalars().all()
    if not regs:
        raise HTTPException(409, "Nobody has opted in to this edition yet.")
    for r in regs:
        s, h, t = mail.newsletter(w, r, c.content or {}, c.subject)
        mail.queue(db, "newsletter", r.email, s, h, t, campaign_id=c.id, registration_id=r.id, unsub=mail.unsub_api_url(r.id))
    c.status, c.approved_by, c.approved_at, c.recipients = "sending", user.name, datetime.now(timezone.utc), len(regs)
    await audit(db, user, "Sent newsletter", "data", f"{c.subject} ({c.edition})", detail={"recipients": len(regs)})
    await db.commit()
    return {"ok": True, "recipients": len(regs)}


@router.post("/{wid}/campaigns/{cid}/discard")
async def discard(wid: str, cid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    c = await _camp(db, wid, cid)
    if c.status != "draft":
        raise HTTPException(409, "Only drafts can be discarded.")
    c.status = "discarded"
    await db.commit()
    return {"ok": True}


@router.post("/{wid}/newsletter/generate")
async def generate(wid: str, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _w(db, wid)
    made = await newsletter.generate_drafts(db, wid, by=user.name)
    return {"ok": True, "drafts": [c.id for c in made]}


class CompanyIn(BaseModel):
    items: list[dict] = Field(max_length=4)


@router.put("/{wid}/newsletter/company")
async def company(wid: str, body: CompanyIn, db: AsyncSession = Depends(get_db), user: User = ADMIN):
    await _w(db, wid)
    items = [{"name": str(x.get("name") or "")[:80], "url": str(x.get("url") or "")[:200] if str(x.get("url") or "").startswith("https://") else "",
              "text": str(x.get("text") or "")[:1200]} for x in body.items if str(x.get("name") or "").strip()]
    await newsletter.set_company(db, items)
    await audit(db, user, "Updated newsletter company section", "content", "AI × Quantum Brief")
    await db.commit()
    return {"ok": True, "items": items}
