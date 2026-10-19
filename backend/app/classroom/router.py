import os
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
    if os.environ.get("STUDIO_ONLY") == "1":  # demo: the animated-portrait classroom is closed to everyone
        raise HTTPException(403, "Interactive lessons aren't open in the demo yet.")
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
    # Make sure this learner's personalised lines (their name in greetings/feedback) get rendered for this lecturer.
    try:
        from ..services.render_enqueue import enqueue
        await enqueue(lesson.id, [avatar_id], [user.first])
    except Exception:
        pass
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


def public_lesson(lesson: Lesson, course_code: str | None) -> dict:
    c = lesson.content
    segs = []
    for sg in c["segments"]:
        cp = sg["checkpoint"]
        segs.append({"id": sg["id"], "title": sg["title"], "slide": sg.get("slide"), "speech": sg["speech"],
                     "checkpoint": {"id": cp["id"], "question": cp["question"], "mandatory": cp["mandatory"],
                                    "maxAttempts": int((lesson.policy or {}).get("maxAttempts") or cp["maxAttempts"]) if cp["mandatory"] else cp["maxAttempts"],
                                    "concepts": [{"id": x["id"], "label": x["label"], "required": bool(x.get("required"))} for x in cp["concepts"]],
                                    "misconceptions": [{"id": m["id"], "label": m["label"]} for m in cp.get("misconceptions", [])],
                                    "hint_count": len(cp["hints"])}})
    return {"id": lesson.id, "course_id": lesson.course_id, "course_code": course_code, "title": lesson.title, "module": lesson.module,
            "dur": c.get("dur", 25), "version": lesson.version, "objectives": c.get("objectives", []), "summary": c.get("summary", []), "chips": c.get("chips", []), "segments": segs,
            "avatars": lesson.avatars, "policy": {"threshold": "required", "hints": True, "assisted": True, "simpler": True, **(lesson.policy or {})}}


@router.get("/lessons/{lesson_id}")
async def get_lesson(lesson_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    from ..models import Course
    lesson = await db.get(Lesson, lesson_id)
    if not lesson or (lesson.status != "published" and user.role == "student"):
        raise HTTPException(404, "Lesson not found")
    course = await db.get(Course, lesson.course_id)
    return public_lesson(lesson, course.code if course else None)


@router.get("/lessons")
async def list_lessons(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    from ..models import Course
    q = select(Lesson, Course).join(Course, Course.id == Lesson.course_id)
    if user.role == "student" and os.environ.get("STUDIO_ONLY") == "1":
        return []  # demo: interactive lessons are closed to students until their lecturers are produced
    if user.role == "student":
        q = q.join(Enrolment, Enrolment.course_id == Course.id).where(Enrolment.user_id == user.id, Lesson.status == "published")
    elif user.role == "lecturer":
        q = q.where(Course.lecturer_id == user.id)
    rows = (await db.execute(q)).all()
    out = []
    for l, c in rows:
        last = (await db.execute(select(VFSession).where(VFSession.user_id == user.id, VFSession.lesson_id == l.id).order_by(VFSession.updated_at.desc()))).scalars().first()
        out.append({"id": l.id, "title": l.title, "module": l.module, "course_id": c.id, "course_code": c.code, "course_title": c.title,
                    "dur": l.content.get("dur", 25), "status": l.status, "version": l.version, "avatars": l.avatars,
                    "checkpoints": len(l.content["segments"]),
                    "my_status": last.status if last else None, "my_seg": last.seg if last else None})
    return out


class AskIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)


@router.post("/sessions/{sid}/ask")
async def ask(sid: str, body: AskIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    from ..services.assistant import side_answer
    try:
        c = await engine.load(db, sid, user)
    except LookupError:
        raise HTTPException(404, "Session not found")
    res = await side_answer(db, c, body.q)
    c.event("side_question", q=body.q[:200], grounded=res["grounded"], engine=res["engine"])
    await db.commit()
    from .lines import SIDE_AI, line_hash
    say_lines = SIDE_AI if res["engine"] == "claude" else [res["answer"]]
    res["say"] = [{"id": line_hash(c.avatar.id, t), "text": t, "kind": "speech"} for t in say_lines]
    return res


@router.get("/media/{avatar_id}")
async def media_manifest(avatar_id: str, lesson_id: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    from ..models import MediaClip
    rows = (await db.execute(select(MediaClip).where(MediaClip.avatar_id == avatar_id, MediaClip.status.in_(["audio", "ready"])))).scalars()
    return {r.hash: {"audio_url": r.audio_url, "video_url": r.video_url if r.status == "ready" else None, "envelope": r.envelope,
                     "duration": r.duration} for r in rows}


@router.get("/sessions/{sid}/summary")
async def summary(sid: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    from ..models import Module
    try:
        c = await engine.load(db, sid, user)
    except LookupError:
        raise HTTPException(404, "Session not found")
    rows = []
    for sg in c.segs:
        cp = sg["checkpoint"]
        a = c.atts(cp["id"])
        outcome = (c.s.outcome or {}).get(cp["id"]) or ("passed" if a and a[-1].verdict == "correct" else "open")
        rows.append({"id": cp["id"], "question": cp["question"], "attempts": len(a), "first": a[0].verdict if a else None,
                     "final": a[-1].verdict if a else None, "hints": (c.s.hints or {}).get(cp["id"], 0), "outcome": outcome,
                     "concepts": "; ".join(x["label"] for x in cp["concepts"] if x.get("required"))})
    mods = (await db.execute(select(Module).where(Module.course_id == c.lesson.course_id).order_by(Module.ord))).scalars().all()
    items = [dict(it, module=m.title) for m in mods for it in (m.items or [])]
    idx = next((i for i, it in enumerate(items) if it.get("id") == c.lesson.id), -1)
    nxt = [it for it in items[idx + 1: idx + 3]] if idx >= 0 else []
    return {"checkpoints": rows, "status": c.s.status, "next": nxt,
            "minutes": max(1, int(((c.s.ended_at or c.s.updated_at) - (c.s.started_at or c.s.created_at)).total_seconds() // 60)) if c.s.started_at else 0}
