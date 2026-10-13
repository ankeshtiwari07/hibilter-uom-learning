from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.db import get_db
from ..core.deps import current_user
from ..models import Avatar, Enrolment, Lesson, User, VFSession
from . import engine
from .fsm import Blocked

router = APIRouter(prefix="/api/vf", tags=["virtual-faculty"])


class StartIn(BaseModel):
    lesson_id: str
    avatar_id: str | None = None
    resume: bool = False


class ActionIn(BaseModel):
    action: str = Field(max_length=32)
    version: int | None = None
    payload: dict = Field(default_factory=dict)


@router.get("/avatars")
async def avatars(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    rows = (await db.execute(select(Avatar).where(Avatar.status == "active").order_by(Avatar.id))).scalars()
    return [{"id": a.id, "name": a.name, "short": a.short, "subject": a.subject, "teach": a.teach, "gender": a.gender,
             "voice": a.voice, "style": a.style, "portrait": a.portrait, "listen_portrait": a.listen_portrait, "calib": a.calib}
            for a in rows]


@router.post("/sessions")
async def start(body: StartIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    lesson = await db.get(Lesson, body.lesson_id)
    if not lesson or lesson.status != "published":
        raise HTTPException(404, "Lesson not found")
    if user.role == "student":
        enrolled = (await db.execute(select(Enrolment).where(Enrolment.user_id == user.id, Enrolment.course_id == lesson.course_id))).scalar_one_or_none()
        if not enrolled:
            raise HTTPException(403, "You're not enrolled in this course.")
    prev = (await db.execute(select(VFSession).where(VFSession.user_id == user.id, VFSession.lesson_id == lesson.id,
                                                     VFSession.status.in_(["active", "saved", "saved-after-error"]))
                             .order_by(VFSession.created_at.desc()))).scalars().first()
    avatar_id = body.avatar_id or (prev.avatar_id if prev else None) or (lesson.avatars or ["henri"])[0]
    if not await db.get(Avatar, avatar_id):
        raise HTTPException(400, "Unknown lecturer")
    seg = 0
    outcome, hints = {}, {}
    if body.resume and prev and prev.lesson_version == lesson.version:
        # resume from the last completed checkpoint
        seg, outcome = prev.seg, prev.outcome or {}
        hints = {k: v for k, v in (prev.hints or {}).items() if not k.startswith("_")}
    if prev and prev.status != "completed":
        prev.status = "superseded"
    s = VFSession(user_id=user.id, lesson_id=lesson.id, lesson_version=lesson.version, avatar_id=avatar_id, seg=seg,
                  outcome=outcome, hints=hints, trace=["IDLE"], status="active")
    db.add(s)
    await db.commit()
    c = await engine.load(db, s.id, user)
    return engine.snapshot(c)


@router.get("/sessions/resumable")
async def resumable(lesson_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    s = (await db.execute(select(VFSession).where(VFSession.user_id == user.id, VFSession.lesson_id == lesson_id,
                                                  VFSession.status.in_(["saved", "saved-after-error", "active"]), VFSession.seg > 0)
                          .order_by(VFSession.updated_at.desc()))).scalars().first()
    if not s:
        return None
    lesson = await db.get(Lesson, lesson_id)
    seg = lesson.content["segments"][s.seg] if s.seg < len(lesson.content["segments"]) else None
    return {"id": s.id, "seg": s.seg, "title": seg["title"] if seg else None, "avatar_id": s.avatar_id,
            "at": s.updated_at.isoformat() if s.updated_at else None}


@router.get("/sessions/{sid}")
async def get_session(sid: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    try:
        return engine.snapshot(await engine.load(db, sid, user))
    except LookupError:
        raise HTTPException(404, "Session not found")


@router.post("/sessions/{sid}/actions")
async def action(sid: str, body: ActionIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    uid = user.id
    try:
        return await engine.act(db, sid, user, body.action, body.payload, body.version)
    except LookupError:
        raise HTTPException(404, "Session not found")
    except engine.Conflict as e:
        await db.rollback()  # snapshot was built before rollback
        return JSONResponse(status_code=409, content={"detail": "This lesson changed in another tab. Showing the latest state.", "session": e.args[0]})
    except Blocked as e:
        await db.rollback()
        user = await db.get(User, uid, populate_existing=True)
        c = await engine.load(db, sid, user)
        snap = engine.snapshot(c)
        snap["blocked"] = e.msg
        return JSONResponse(status_code=422, content={"detail": e.msg, "session": snap})
