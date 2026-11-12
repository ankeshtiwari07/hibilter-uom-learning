"""Webinar email: branded templates, SMTP delivery, unsubscribe tokens and the outbox.

Messages are rendered once (personalised) and stored in email_messages; the mailer worker
(app.services.mailer) delivers them at a capped rate with retries.
"""
from __future__ import annotations

import hashlib
import hmac
import html as H
import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage as Mime
from email.utils import formataddr, make_msgid

from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import get_settings
from ..models import EmailMessage, Webinar, WebinarRegistration

NAVY, INK, MUTED, CYAN, VIOLET, GOLD = "#0A1530", "#132030", "#5B697B", "#22B8CF", "#7C5CFF", "#C69A3A"


def configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and s.smtp_user and s.smtp_password)


def sender() -> str:
    s = get_settings()
    return s.mail_from_email or s.smtp_user or ""


def base() -> str:
    return get_settings().public_base_url.rstrip("/")


# ---------- tokens ----------
def token(reg_id: str, purpose: str = "unsub") -> str:
    key = get_settings().jwt_secret.encode()
    sig = hmac.new(key, f"{purpose}:{reg_id}".encode(), hashlib.sha256).hexdigest()[:24]
    return f"{reg_id}.{sig}"


def check_token(tok: str, purpose: str = "unsub") -> str | None:
    rid, _, _ = (tok or "").partition(".")
    return rid if rid and hmac.compare_digest(token(rid, purpose), tok) else None


def unsub_url(reg_id: str) -> str:
    """Link in the email body (a friendly page)."""
    return f"{base()}/webinar/unsubscribe?t={token(reg_id)}"


def unsub_api_url(reg_id: str) -> str:
    """List-Unsubscribe header target (RFC 8058 one-click POST)."""
    return f"{base()}/api/webinar/unsubscribe?t={token(reg_id)}"


# ---------- layout ----------
def esc(s) -> str:
    return H.escape(str(s or ""), quote=True)


def button(label: str, url: str, gold: bool = False) -> str:
    bg = GOLD if gold else VIOLET
    return (f'<a href="{esc(url)}" style="display:inline-block;background:{bg};color:#ffffff;text-decoration:none;'
            f'font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">{esc(label)}</a>')


def layout(preheader: str, body_html: str, footer_html: str) -> str:
    b = base()
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>{esc(preheader)}</title></head>
<body style="margin:0;padding:0;background:#EEF2F6;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:{INK}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">{esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{NAVY};padding:18px 24px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="background:#F6F7FB;border-radius:8px;padding:6px 10px"><img src="{b}/brand/hib_mark.png" width="24" height="24" alt="" style="vertical-align:middle;border:0">
      <img src="{b}/brand/hib_word.png" height="15" alt="Hibilter IT Systems" style="vertical-align:middle;border:0;margin-left:6px"></td>
    <td style="color:#9FB4D8;font-family:Georgia,serif;font-style:italic;font-size:18px;padding:0 10px">&amp;</td>
    <td><img src="{b}/brand/tuquant.png" height="32" alt="TuQuant" style="vertical-align:middle;border:0"></td>
  </tr></table>
</td></tr>
<tr><td style="padding:26px 28px 8px 28px;font-size:15px;line-height:1.6">{body_html}</td></tr>
<tr><td style="padding:18px 28px 24px 28px;border-top:1px solid #E4EAF1;font-size:12px;line-height:1.5;color:{MUTED}">{footer_html}
  <div style="margin-top:8px">Hibilter IT Systems &amp; TuQuant · <a href="https://www.hibilter.com" style="color:{MUTED}">hibilter.com</a> · <a href="https://tuquant.si" style="color:{MUTED}">tuquant.si</a></div></td></tr>
</table></td></tr></table></body></html>"""


def event_box(w: Webinar, ref: str | None = None) -> str:
    rows = ([("Registration", f'<b style="font-family:Menlo,monospace;letter-spacing:.05em">{esc(ref)}</b>')] if ref else []) + [
        ("When", f"<b>{esc(w.when_text)}</b>"), ("Where", f"<b>{esc(w.where_text)}</b>")]
    cells = "".join(f'<tr><td style="padding:4px 0;color:{MUTED};font-size:12px;letter-spacing:.06em;text-transform:uppercase;width:120px">{k}</td>'
                    f'<td style="padding:4px 0;font-size:15px">{v}</td></tr>' for k, v in rows)
    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px dashed #C5CFDB;'
            f'border-radius:10px;background:#F6F8FF"><tr><td style="padding:12px 16px"><table role="presentation" cellpadding="0" cellspacing="0">{cells}</table></td></tr></table>')


def event_actions(w: Webinar) -> tuple[str, str]:
    """(html, text) — joining link and calendar, when known."""
    h, t = [], []
    if w.join_url:
        h.append(button("Join the webinar", w.join_url, gold=True)); t.append(f"Join: {w.join_url}")
    if w.starts_at:
        cal = f"{base()}/api/webinar/{w.id}/calendar.ics"
        h.append(f'<a href="{cal}" style="display:inline-block;margin-left:{8 if h else 0}px;color:{VIOLET};font-weight:600;font-size:14px;padding:12px 6px">Add to calendar</a>')
        t.append(f"Add to calendar: {cal}")
    return (f'<p style="margin:18px 0">{"".join(h)}</p>' if h else ""), "\n".join(t)


def event_footer() -> str:
    return ("You’re receiving this because you registered for this webinar. To cancel your registration or stop webinar emails, "
            "just reply to this email.")


def first_name(name: str) -> str:
    return (name or "").split()[0] if name else "there"


# ---------- message builders ----------
def confirmation(w: Webinar, r: WebinarRegistration) -> tuple[str, str, str]:
    subj = f"You’re registered: {w.title}"
    acts_h, acts_t = event_actions(w)
    later = "" if w.starts_at else "<p>The date and time are being finalised — we’ll email you as soon as they’re confirmed, along with the joining link.</p>"
    body = (f'<p style="font-size:20px;font-weight:600;margin:0 0 8px">You’re in, {esc(first_name(r.name))}!</p>'
            f'<p>Your seat is reserved for <b>{esc(w.title)}</b>{" — " + esc(w.presenters) if w.presenters else ""}.</p>'
            f'{event_box(w, r.ref)}{later}{acts_h}'
            f'<p>Delivered by expert faculty, brought to life as AI lecturers who teach, explain and answer your questions.</p>'
            f'<p style="color:{MUTED};font-size:13px">Know someone who should join? Share <a href="{base()}/webinar?src=friend" style="color:{VIOLET}">{base()}/webinar</a></p>')
    text = (f"You’re in, {first_name(r.name)}!\n\nYour seat is reserved for {w.title}.\nRegistration: {r.ref}\nWhen: {w.when_text}\n"
            f"Where: {w.where_text}\n{acts_t}\n\n" + ("" if w.starts_at else "We’ll email you the confirmed date, time and joining link.\n"))
    return subj, layout(f"Your registration code is {r.ref}", body, event_footer()), text


def event_update(w: Webinar, r: WebinarRegistration, subject: str, note: str | None) -> tuple[str, str, str]:
    acts_h, acts_t = event_actions(w)
    note_h = "".join(f"<p>{esc(p)}</p>" for p in (note or "").split("\n\n") if p.strip())
    body = (f'<p style="font-size:20px;font-weight:600;margin:0 0 8px">{esc(first_name(r.name))}, it’s confirmed.</p>'
            f'<p><b>{esc(w.title)}</b>{" — " + esc(w.presenters) if w.presenters else ""}.</p>'
            f'{event_box(w, r.ref)}{note_h}{acts_h}'
            f'<p>See you there. Bring your questions — the AI lecturers will answer them live.</p>')
    text = (f"{first_name(r.name)}, it’s confirmed.\n\n{w.title}\nWhen: {w.when_text}\nWhere: {w.where_text}\nRegistration: {r.ref}\n"
            f"{acts_t}\n\n{note or ''}\n")
    return subject, layout(f"{w.when_text} · {w.where_text}", body, event_footer()), text


def newsletter(w: Webinar, r: WebinarRegistration | None, c: dict, subject: str) -> tuple[str, str, str]:
    """c = {intro, sections:[{title, items:[{title,url,source,note,include}]}], company:[{name,url,text}], outro}"""
    name = first_name(r.name) if r else "there"
    parts = [f'<p style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:{CYAN};font-weight:700;margin:0">The AI × Quantum Brief</p>',
             f'<p style="font-size:20px;font-weight:600;margin:6px 0 12px">{esc(c.get("headline") or "This week in AI and quantum")}</p>',
             f"<p>Hi {esc(name)},</p>"]
    text = [f"THE AI × QUANTUM BRIEF\n{c.get('headline') or ''}\n\nHi {name},\n"]
    for p in (c.get("intro") or "").split("\n\n"):
        if p.strip():
            parts.append(f"<p>{esc(p)}</p>"); text.append(p + "\n")
    for sec in c.get("sections", []):
        items = [i for i in sec.get("items", []) if i.get("include", True)]
        if not items:
            continue
        parts.append(f'<p style="margin:22px 0 6px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:{VIOLET};font-weight:700">{esc(sec["title"])}</p>')
        text.append(f"\n{sec['title'].upper()}")
        for i in items:
            note = f'<div style="color:{INK};font-size:14px;margin-top:3px">{esc(i["note"])}</div>' if i.get("note") else ""
            parts.append(f'<div style="margin:0 0 12px;padding-left:12px;border-left:3px solid #E4EAF1"><a href="{esc(i["url"])}" style="color:{INK};font-weight:600;text-decoration:none">{esc(i["title"])}</a>'
                         f'<div style="color:{MUTED};font-size:12px">{esc(i.get("source") or "")}</div>{note}</div>')
            text.append(f"- {i['title']} ({i.get('source') or ''})\n  {i['url']}" + (f"\n  {i['note']}" if i.get("note") else ""))
    comp = [x for x in c.get("company", []) if (x.get("text") or "").strip()]
    if comp:
        parts.append(f'<p style="margin:24px 0 6px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:{GOLD};font-weight:700">What we’re building</p>')
        text.append("\nWHAT WE’RE BUILDING")
        for x in comp:
            paras = "".join(f'<p style="margin:4px 0">{esc(p)}</p>' for p in x["text"].split("\n") if p.strip())
            link = f' <a href="{esc(x["url"])}" style="color:{VIOLET};font-size:13px">{esc(x["url"].replace("https://", ""))}</a>' if x.get("url") else ""
            parts.append(f'<div style="margin:0 0 12px"><b>{esc(x["name"])}</b>{link}{paras}</div>')
            text.append(f"{x['name']} {x.get('url') or ''}\n{x['text']}")
    if w.status == "open":
        parts.append(f'<p style="margin:24px 0 8px">Join us live: <b>{esc(w.title)}</b> — {esc(w.when_text)}.</p>'
                     f'<p>{button("Your webinar details" if r else "Register for the webinar", base() + "/webinar")}</p>')
        text.append(f"\nJoin us live: {w.title} — {w.when_text}. {base()}/webinar")
    if c.get("outro"):
        parts.append(f"<p>{esc(c['outro'])}</p>"); text.append(c["outro"])
    unsub = unsub_url(r.id) if r else f"{base()}/webinar/unsubscribe"
    footer = (f"You’re receiving the AI × Quantum Brief because you asked for updates when you registered for our webinar. "
              f'<a href="{unsub}" style="color:{MUTED}">Unsubscribe</a> — one click, no questions asked. '
              f"Articles link to their original publishers; Hibilter and TuQuant are not responsible for third-party content.")
    text.append(f"\n—\nUnsubscribe: {unsub}")
    return subject, layout(c.get("headline") or subject, "".join(parts), footer), "\n".join(text)


# ---------- outbox ----------
def queue(db: AsyncSession, kind: str, to: str, subject: str, html: str, text: str, *, campaign_id: str | None = None,
          registration_id: str | None = None, unsub: str | None = None) -> EmailMessage:
    headers = {}
    if unsub:
        headers = {"List-Unsubscribe": f"<{unsub}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}
    m = EmailMessage(kind=kind, to_email=to, subject=subject, html=html, text=text, headers=headers,
                     campaign_id=campaign_id, registration_id=registration_id, status="queued")
    db.add(m)
    return m


def smtp_send(to: str, subject: str, html: str, text: str, headers: dict | None = None) -> str:
    """Blocking SMTP send; returns the Message-ID. Raises on failure."""
    s = get_settings()
    msg = Mime()
    frm = sender()
    msg["From"] = formataddr((s.mail_from_name, frm))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Reply-To"] = s.mail_reply_to or frm
    msg["Date"] = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    mid = make_msgid(domain=frm.split("@")[-1] if "@" in frm else None)
    msg["Message-ID"] = mid
    for k, v in (headers or {}).items():
        msg[k] = v
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    ctx = ssl.create_default_context()
    if s.smtp_starttls:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=30) as c:
            c.starttls(context=ctx); c.login(s.smtp_user, s.smtp_password); c.send_message(msg)
    else:
        with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=30, context=ctx) as c:
            c.login(s.smtp_user, s.smtp_password); c.send_message(msg)
    return mid
