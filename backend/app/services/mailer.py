"""Mailer worker: delivers the email outbox at a capped rate with retries, and prepares the weekly newsletter drafts.

  python -m app.services.mailer      (compose service "mailer")
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from ..core.config import get_settings
from ..core.db import SessionLocal
from ..models import EmailCampaign, EmailMessage, Setting, Webinar
from . import event_updates, mail, newsletter

log = logging.getLogger("uom.mailer")
TICK = 10
MAX_ATTEMPTS = 4
SCHED_KEY = "newsletter_last_week"


async def deliver() -> int:
    s = get_settings()
    if not mail.configured():
        return 0
    batch = max(1, s.mail_rate_per_min * TICK // 60)
    now = datetime.now(timezone.utc)
    sent = 0
    async with SessionLocal() as db:
        rows = (await db.execute(select(EmailMessage).where(
            EmailMessage.status == "queued",
            (EmailMessage.next_attempt_at.is_(None)) | (EmailMessage.next_attempt_at <= now))
            .order_by(EmailMessage.id).limit(batch).with_for_update(skip_locked=True))).scalars().all()
        for m in rows:
            m.attempts += 1
            try:
                await asyncio.to_thread(mail.smtp_send, m.to_email, m.subject, m.html, m.text, m.headers)
                m.status, m.sent_at, m.error = "sent", datetime.now(timezone.utc), None
                sent += 1
            except smtplib.SMTPAuthenticationError as e:
                m.attempts -= 1  # not this message's fault
                m.next_attempt_at = now + timedelta(minutes=5)
                m.error = f"SMTP login failed: {e.smtp_code}"
                log.error("SMTP authentication failed — check SMTP_USER/SMTP_PASSWORD")
                break
            except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused) as e:
                m.status, m.error = "failed", str(e)[:500]
            except Exception as e:
                m.error = f"{type(e).__name__}: {e}"[:500]
                if m.attempts >= MAX_ATTEMPTS:
                    m.status = "failed"
                else:
                    m.next_attempt_at = now + timedelta(minutes=2 ** m.attempts)
        await db.commit()
        # campaigns with nothing left in the queue are done
        sending = (await db.execute(select(EmailCampaign).where(EmailCampaign.status == "sending"))).scalars().all()
        for c in sending:
            left = (await db.execute(select(func.count()).select_from(EmailMessage)
                                     .where(EmailMessage.campaign_id == c.id, EmailMessage.status == "queued"))).scalar_one()
            if not left:
                c.status = "sent"
        await db.commit()
    return sent


async def weekly() -> None:
    s = get_settings()
    now = datetime.now(timezone.utc)
    if now.weekday() != s.newsletter_weekday or now.hour < s.newsletter_hour_utc:
        return
    tag = newsletter.week_tag(now)
    async with SessionLocal() as db:
        st = await db.get(Setting, SCHED_KEY)
        if st and (st.value or {}).get("week") == tag:
            return
        if st:
            st.value = {"week": tag}
        else:
            db.add(Setting(key=SCHED_KEY, value={"week": tag}))
        await db.commit()
        webinars = (await db.execute(select(Webinar))).scalars().all()
        for w in webinars:
            if (w.meta or {}).get("newsletter", True) is False:
                continue
            made = await newsletter.generate_drafts(db, w.id)
            log.info("newsletter drafts for %s: %s", w.id, [c.id for c in made])
            if s.owner_notify_email and mail.configured() and made:
                url = f"{mail.base()}/a-webinar"
                auto = s.newsletter_auto_send
                when = (datetime.now(timezone.utc) + timedelta(minutes=s.newsletter_auto_hold_min)).astimezone(timezone(timedelta(hours=5, minutes=30)))
                line = (f"They will be sent automatically at <b>{when:%H:%M} IST</b>. To change or stop one, edit or discard it before then."
                        if auto else "Nothing is sent until you review and approve them.")
                body = (f"<p>This week’s AI × Quantum Brief is ready for <b>{mail.esc(w.title)}</b>: "
                        f"{len(made)} editions (MBA and general).</p><p>{line}</p><p>{mail.button('Review the drafts', url)}</p>")
                notice(db, "Newsletter: this week’s brief " + ("sends at " + f"{when:%H:%M} IST" if auto else "is ready for review"),
                       body, f"This week's newsletter drafts are ready. Review: {url}")
                await db.commit()


def notice(db, subject: str, body: str, text: str) -> None:
    s = get_settings()
    if s.owner_notify_email and mail.configured():
        db.add(EmailMessage(kind="notice", to_email=s.owner_notify_email, subject=subject,
                            html=mail.layout(subject, body, "Sent to the webinar administrator."), text=text, headers={}, status="queued"))


async def auto_newsletters() -> None:
    async with SessionLocal() as db:
        notes = await newsletter.auto_send(db)
        if notes:
            url = f"{mail.base()}/a-webinar"
            notice(db, "Newsletter: this week’s sending report", "".join(f"<p>{mail.esc(n)}</p>" for n in notes)
                   + f"<p>{mail.button('Open the portal', url)}</p>", "\n".join(notes) + f"\n{url}")
            await db.commit()

async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    log.info("mailer up (smtp configured: %s)", mail.configured())
    while True:
        try:
            await weekly()
        except Exception:
            log.exception("weekly newsletter step failed")
        try:
            await auto_newsletters()
        except Exception:
            log.exception("automatic newsletter step failed")
        try:
            async with SessionLocal() as db:
                await event_updates.auto_send(db)
        except Exception:
            log.exception("automatic event update step failed")
        try:
            n = await deliver()
            if n:
                log.info("delivered %d", n)
        except Exception:
            log.exception("delivery step failed")
        await asyncio.sleep(TICK)


if __name__ == "__main__":
    asyncio.run(main())
