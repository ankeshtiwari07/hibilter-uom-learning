"""Tamper-evident audit log: each row's hash covers the previous row's hash."""
import hashlib
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AuditLog

GENESIS = "0" * 64


def _digest(prev: str, row: dict) -> str:
    return hashlib.sha256((prev + json.dumps(row, sort_keys=True, default=str)).encode()).hexdigest()


async def audit(db: AsyncSession, actor, action: str, kind: str, obj: str, reason: str | None = None, detail: dict | None = None):
    last = (await db.execute(select(AuditLog.hash).order_by(AuditLog.id.desc()).limit(1).with_for_update())).scalar()
    prev = last or GENESIS
    row = {"actor_id": getattr(actor, "id", None), "actor_name": getattr(actor, "name", None) or "System",
           "action": action, "kind": kind, "obj": obj, "reason": reason, "detail": detail or {}}
    db.add(AuditLog(**row, prev_hash=prev, hash=_digest(prev, row)))


async def verify_chain(db: AsyncSession) -> tuple[bool, int]:
    prev = GENESIS
    rows = (await db.execute(select(AuditLog).order_by(AuditLog.id))).scalars().all()
    for r in rows:
        row = {"actor_id": r.actor_id, "actor_name": r.actor_name, "action": r.action, "kind": r.kind,
               "obj": r.obj, "reason": r.reason, "detail": r.detail or {}}
        if r.prev_hash != prev or r.hash != _digest(prev, row):
            return False, r.id
        prev = r.hash
    return True, len(rows)
