"""Trial (customer demo) accounts: time-boxed logins that sellers can hand to prospects.

  python -m app.seed.trial create --email demo.student@uom-trial.example --role student \
      --like sagar.ramdin@demo.student.example --name "Demo Student" --expires 2026-12-05T18:29:59Z
  python -m app.seed.trial create --email demo.lecturer@uom-trial.example --role lecturer \
      --like m.lallchand@demo.uom.example --name "Demo Lecturer" --expires 2026-12-05T18:29:59Z
  python -m app.seed.trial list | extend --email E --expires ISO | expire --email E | delete --email E

The password comes from $TRIAL_PASSWORD (never argv). A student gets its own record enrolled in the same courses as
--like (fresh progress). A lecturer mirrors --like (acts_for): it sees that lecturer's courses and is view-only.
Expiry is enforced on sign-in and on every request (core/deps.py), so open sessions stop at expires_at too.
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone

from sqlalchemy import delete, func, select

from ..core.db import SessionLocal
from ..core.security import hash_password
from ..models import Enrolment, User


def _ts(s: str) -> datetime:
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def _get(db, email: str) -> User | None:
    return (await db.execute(select(User).where(func.lower(User.email) == email.lower()))).scalar_one_or_none()


async def create(a):
    pw = os.environ.get("TRIAL_PASSWORD")
    if not pw:
        sys.exit("set TRIAL_PASSWORD")
    async with SessionLocal() as db:
        like = await _get(db, a.like)
        if not like or like.role != a.role:
            sys.exit(f"--like {a.like} not found or not a {a.role}")
        u = await _get(db, a.email)
        first = a.name.split()[0]
        if not u:
            u = User(email=a.email.lower(), role=a.role, name=a.name, first=first)
            db.add(u)
        u.password_hash, u.role, u.name, u.first = hash_password(pw), a.role, a.name, first
        u.status, u.expires_at, u.failed_logins, u.locked_until = "active", _ts(a.expires), 0, None
        u.faculty_id, u.programme_id, u.year, u.title = like.faculty_id, like.programme_id, like.year, like.title
        if a.role == "lecturer":
            u.acts_for = like.id
        else:
            u.acts_for = None
            u.student_no = u.student_no or "TRIAL-" + a.email.split("@")[0][-6:].upper()
        await db.flush()
        if a.role == "student":
            have = set((await db.execute(select(Enrolment.course_id).where(Enrolment.user_id == u.id))).scalars())
            for e in (await db.execute(select(Enrolment).where(Enrolment.user_id == like.id))).scalars():
                if e.course_id not in have:
                    db.add(Enrolment(user_id=u.id, course_id=e.course_id, progress=0, status="active"))
        await db.commit()
        print(json.dumps({"ok": True, "id": u.id, "email": u.email, "role": u.role, "expires_at": u.expires_at.isoformat()}))


async def set_state(a, *, expires: str | None = None, suspend: bool = False):
    async with SessionLocal() as db:
        u = await _get(db, a.email)
        if not u or not u.expires_at:
            sys.exit(f"{a.email}: not a trial account")
        if expires:
            u.expires_at, u.status = _ts(expires), "active"
        if suspend:
            u.expires_at, u.status = min(u.expires_at, datetime.now(timezone.utc)), "suspended"
        await db.commit()
        print(json.dumps({"ok": True, "email": u.email, "status": u.status, "expires_at": u.expires_at.isoformat()}))


async def remove(a):
    async with SessionLocal() as db:
        u = await _get(db, a.email)
        if not u or not u.expires_at:
            sys.exit(f"{a.email}: not a trial account")
        await db.execute(delete(Enrolment).where(Enrolment.user_id == u.id))
        await db.delete(u)
        try:
            await db.commit()
            print(json.dumps({"ok": True, "deleted": a.email}))
        except Exception as e:  # activity rows reference the user: keep it, but locked out
            await db.rollback()
            await set_state(a, suspend=True)
            print(json.dumps({"ok": True, "suspended_instead": a.email, "why": type(e).__name__}))


async def listing(_a):
    async with SessionLocal() as db:
        now = datetime.now(timezone.utc)
        for u in (await db.execute(select(User).where(User.expires_at.is_not(None)).order_by(User.email))).scalars():
            print(json.dumps({"email": u.email, "role": u.role, "status": u.status, "acts_for": u.acts_for,
                              "expires_at": u.expires_at.isoformat(), "expired": now >= u.expires_at,
                              "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None}))


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("create")
    c.add_argument("--email", required=True); c.add_argument("--role", choices=["student", "lecturer"], required=True)
    c.add_argument("--like", required=True); c.add_argument("--name", required=True); c.add_argument("--expires", required=True)
    for n in ("extend", "expire", "delete"):
        x = sp.add_parser(n); x.add_argument("--email", required=True)
        if n == "extend":
            x.add_argument("--expires", required=True)
    sp.add_parser("list")
    a = p.parse_args()
    run = {"create": create, "list": listing, "delete": remove,
           "extend": lambda a: set_state(a, expires=a.expires), "expire": lambda a: set_state(a, suspend=True)}[a.cmd]
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
