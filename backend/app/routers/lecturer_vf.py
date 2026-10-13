"""Virtual Faculty management for lecturers and administrators: avatar & policy configuration (S36), media render requests,
the review queue (assisted completions and low-confidence evaluations) and Virtual Faculty analytics (S37)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..classroom import lines as L
from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import (Avatar, Course, Enrolment, Event, Lesson, MediaClip, ReviewItem, Setting, Source, User, VFAttempt,
                      VFSession)
from ._lecturer_common import csv_bytes, iso, my_course_ids, now, owned_course, owned_lesson, week_start

router = APIRouter(prefix="/api/lecturer/vf", tags=["lecturer-vf"])
STAFF = require("lecturer", "admin")
ADMIN = require("admin")
VF_DEFAULT = {"hints": True, "assisted": True, "threshold": "required", "engine": "auto", "memory": False, "max_attempts": 3}


def policy_of(lesson: Lesson) -> dict:
    return {"threshold": "required", "hints": True, "assisted": True, "simpler": True, **(lesson.policy or {})}


# ---------------------------------------------------------------- configuration
@router.get("/lessons")
async def vf_lessons(db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    cids = await my_course_ids(db, user)
    if not cids:
        return []
    rows = (await db.execute(select(Lesson, Course).join(Course, Course.id == Lesson.course_id).where(Lesson.course_id.in_(cids))
                             .order_by(Course.code, Lesson.id))).all()
    return [{"id": l.id, "title": l.title, "module": l.module, "course_id": c.id, "course_code": c.code, "status": l.status, "version": l.version,
             "avatars": l.avatars, "checkpoints": len(l.content.get("segments", []))} for l, c in rows]


@router.get("/lessons/{lid}/config")
async def get_config(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    lesson, course = await owned_lesson(db, user, lid)
    vf = await db.get(Setting, "vf")
    srcs = (await db.execute(select(Source).where(Source.course_id == course.id).order_by(Source.title))).scalars().all()
    cps = []
    for s in lesson.content.get("segments", []):
        cp = s["checkpoint"]
        cps.append({"id": cp["id"], "question": cp["question"], "mandatory": cp["mandatory"], "maxAttempts": cp["maxAttempts"],
                    "hints": len(cp.get("hints", [])), "concepts": [{"label": c["label"], "required": bool(c.get("required"))} for c in cp["concepts"]]})
    return {"id": lesson.id, "title": lesson.title, "module": lesson.module, "status": lesson.status, "version": lesson.version,
            "published_at": iso(lesson.published_at), "course": {"id": course.id, "code": course.code, "title": course.title, "vf_enabled": course.vf_enabled},
            "avatars": lesson.avatars or [], "policy": policy_of(lesson), "checkpoints": cps,
            "global": {**VF_DEFAULT, **(vf.value if vf else {})}, "can_edit_global": user.role == "admin",
            "sources": [{"id": s.id, "title": s.title, "kind": s.kind, "approved": s.approved} for s in srcs]}


class PolicyIn(BaseModel):
    threshold: Literal["required", "all"] = "required"
    hints: bool = True
    assisted: bool = True
    simpler: bool = True
    maxAttempts: int | None = Field(default=None, ge=2, le=5)


class ConfigIn(BaseModel):
    avatars: list[str] = Field(min_length=1, max_length=12)
    policy: PolicyIn


@router.put("/lessons/{lid}/config")
async def save_config(lid: str, body: ConfigIn, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    lesson, course = await owned_lesson(db, user, lid)
    valid = set((await db.execute(select(Avatar.id).where(Avatar.status == "active"))).scalars())
    av = list(dict.fromkeys(body.avatars))
    bad = [a for a in av if a not in valid]
    if bad:
        raise HTTPException(422, f"Unknown or inactive lecturer: {', '.join(bad)}.")
    old_pol, old_av = policy_of(lesson), lesson.avatars or []
    pol = body.policy.model_dump()
    if pol["maxAttempts"] is None:
        pol.pop("maxAttempts")
    lesson.avatars = av
    lesson.policy = pol
    # the retry-limit override applies to the live mandatory checkpoints (as in the concept demo) and to future publishes
    if pol.get("maxAttempts"):
        segs = []
        for s in lesson.content.get("segments", []):
            cp = dict(s["checkpoint"])
            if cp.get("mandatory"):
                cp["maxAttempts"] = pol["maxAttempts"]
            segs.append({**s, "checkpoint": cp})
        lesson.content = {**lesson.content, "segments": segs}
    changes = [f"{k}: {old_pol.get(k)} → {pol.get(k)}" for k in set(old_pol) | set(pol) if old_pol.get(k) != pol.get(k)]
    if av != old_av:
        changes.append(f"lecturers: {', '.join(old_av)} → {', '.join(av)}")
    await audit(db, user, "Changed virtual faculty rules", "content", f"{course.code} · {lesson.title}", detail={"changes": changes})
    await db.commit()
    return {"ok": True, "changes": changes}


class GlobalIn(BaseModel):
    hints: bool
    assisted: bool
    threshold: Literal["required", "all"]
    engine: Literal["auto", "claude", "rubric"]
    memory: bool
    max_attempts: int = Field(ge=2, le=5)


@router.get("/settings")
async def get_settings_(db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    vf = await db.get(Setting, "vf")
    return {**VF_DEFAULT, **(vf.value if vf else {})}


@router.put("/settings")
async def put_settings(body: GlobalIn, db: AsyncSession = Depends(get_db), user: User = Depends(ADMIN)):
    vf = await db.get(Setting, "vf")
    old = dict(vf.value) if vf else {}
    if vf:
        vf.value = {**old, **body.model_dump()}
    else:
        db.add(Setting(key="vf", value=body.model_dump()))
    await audit(db, user, "Changed virtual faculty defaults", "system", "Global virtual faculty settings",
                detail={"old": old, "new": body.model_dump()})
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- media
async def _inventory(db: AsyncSession, lesson: Lesson, avatar: Avatar) -> list[str]:
    names = sorted(set((await db.execute(select(User.first).join(Enrolment, Enrolment.user_id == User.id)
                                         .where(Enrolment.course_id == lesson.course_id))).scalars()))
    ad = {"id": avatar.id, "name": avatar.name, "short": avatar.short, "teach": avatar.teach, "subject": avatar.subject}
    return L.inventory(lesson.content, ad, names)


@router.get("/media-status")
async def media_status(lesson_id: str, avatar_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    lesson, _ = await owned_lesson(db, user, lesson_id)
    avatar = await db.get(Avatar, avatar_id)
    if not avatar:
        raise HTTPException(404, "Unknown lecturer")
    texts = await _inventory(db, lesson, avatar)
    hashes = {L.line_hash(avatar.id, t): t for t in texts}
    clips = {c.hash: c for c in (await db.execute(select(MediaClip).where(MediaClip.hash.in_(list(hashes))))).scalars()} if hashes else {}
    counts = {"missing": 0, "pending": 0, "audio": 0, "rendering": 0, "ready": 0, "failed": 0, "review": 0}
    rows = []
    for h, t in hashes.items():
        c = clips.get(h)
        st = c.status if c else "missing"
        counts[st] = counts.get(st, 0) + 1
        rows.append({"hash": h, "text": t, "status": st, "duration": c.duration if c else None, "audio_url": c.audio_url if c else None,
                     "video_url": c.video_url if c else None, "error": c.error if c else None, "engine": c.engine if c else None})
    order = {"failed": 0, "review": 1, "missing": 2, "pending": 3, "rendering": 4, "audio": 5, "ready": 6}
    rows.sort(key=lambda r: order.get(r["status"], 9))
    return {"total": len(rows), "counts": counts, "lines": rows[:200]}


class RenderIn(BaseModel):
    lesson_id: str = Field(max_length=32)
    avatar_id: str = Field(max_length=32)
    retry_failed: bool = True


@router.post("/render")
async def request_render(body: RenderIn, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    lesson, course = await owned_lesson(db, user, body.lesson_id)
    avatar = await db.get(Avatar, body.avatar_id)
    if not avatar:
        raise HTTPException(404, "Unknown lecturer")
    texts = await _inventory(db, lesson, avatar)
    hashes = {L.line_hash(avatar.id, t): t for t in texts}
    existing = {c.hash: c for c in (await db.execute(select(MediaClip).where(MediaClip.hash.in_(list(hashes))))).scalars()} if hashes else {}
    added = requeued = 0
    for h, t in hashes.items():
        c = existing.get(h)
        if not c:
            db.add(MediaClip(hash=h, avatar_id=avatar.id, text=t, kind="speech", status="pending"))
            added += 1
        elif c.status == "failed" and body.retry_failed:
            c.status, c.error = "pending", None
            requeued += 1
    await audit(db, user, "Requested media render", "content", f"{course.code} · {lesson.title} · {avatar.name}",
                detail={"lines": len(hashes), "queued": added, "requeued": requeued})
    await db.commit()
    return {"ok": True, "lines": len(hashes), "queued": added, "requeued": requeued}


# ---------------------------------------------------------------- review queue
@router.get("/review")
async def review(status: Literal["open", "resolved", "all"] = "open", course_id: str | None = None, kind: str | None = None,
                 db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    cids = [course_id] if course_id else await my_course_ids(db, user)
    if course_id:
        await owned_course(db, user, course_id)
    if not cids:
        return {"items": [], "counts": {"open": 0, "resolved": 0}}
    q = select(ReviewItem).where(ReviewItem.course_id.in_(cids))
    all_rows = (await db.execute(q.order_by(ReviewItem.created_at.desc()))).scalars().all()
    counts = {"open": sum(1 for r in all_rows if r.status == "open"), "resolved": sum(1 for r in all_rows if r.status == "resolved")}
    rows = [r for r in all_rows if (status == "all" or r.status == status) and (not kind or r.kind == kind)][:200]
    sids = list({r.session_id for r in rows})
    sessions = {s.id: s for s in (await db.execute(select(VFSession).where(VFSession.id.in_(sids)))).scalars()} if sids else {}
    lessons = {l.id: l for l in (await db.execute(select(Lesson).where(Lesson.id.in_({s.lesson_id for s in sessions.values()})))).scalars()} if sessions else {}
    users = {u.id: u for u in (await db.execute(select(User).where(User.id.in_({r.student_id for r in rows} | {r.resolved_by for r in rows if r.resolved_by})))).scalars()} if rows else {}
    atts: dict[tuple, list] = {}
    if sids:
        for a in (await db.execute(select(VFAttempt).where(VFAttempt.session_id.in_(sids)).order_by(VFAttempt.n))).scalars():
            atts.setdefault((a.session_id, a.checkpoint_id), []).append(a)
    codes = dict((await db.execute(select(Course.id, Course.code).where(Course.id.in_(cids)))).all())
    out = []
    for r in rows:
        s = sessions.get(r.session_id)
        l = lessons.get(s.lesson_id) if s else None
        cp = next((sg["checkpoint"] for sg in (l.content.get("segments", []) if l else []) if sg["checkpoint"]["id"] == r.checkpoint_id), None)
        labels = {c["id"]: c["label"] for c in (cp or {}).get("concepts", [])}
        mlabels = {m["id"]: m["label"] for m in (cp or {}).get("misconceptions", [])}
        st = users.get(r.student_id)
        out.append({"id": r.id, "kind": r.kind, "status": r.status, "note": r.note, "created_at": iso(r.created_at),
                    "resolved_at": iso(r.resolved_at), "resolved_by": users[r.resolved_by].name if r.resolved_by in users else None,
                    "course_code": codes.get(r.course_id), "lesson": l.title if l else None, "lesson_id": l.id if l else None,
                    "student": {"id": r.student_id, "name": st.name if st else "Unknown", "student_no": st.student_no if st else None},
                    "checkpoint": {"id": r.checkpoint_id, "question": cp["question"] if cp else None, "model": cp.get("model") if cp else None},
                    "session": {"id": s.id, "avatar_id": s.avatar_id, "status": s.status, "outcome": (s.outcome or {}).get(r.checkpoint_id)} if s else None,
                    "attempts": [{"n": a.n, "answer": a.answer, "verdict": a.verdict, "engine": a.engine, "confidence": a.confidence,
                                  "found": [labels.get(x, x) for x in a.found or []], "missing": [labels.get(x, x) for x in a.missing or []],
                                  "mis": [mlabels.get(x, x) for x in a.mis or []], "ai_feedback": a.ai_feedback, "hints_before": a.hints_before,
                                  "at": iso(a.created_at)} for a in atts.get((r.session_id, r.checkpoint_id), [])]})
    return {"items": out, "counts": counts}


class ResolveIn(BaseModel):
    note: str = Field(min_length=3, max_length=2000)


@router.post("/review/{rid}/resolve")
async def resolve(rid: int, body: ResolveIn, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    r = await db.get(ReviewItem, rid)
    if not r:
        raise HTTPException(404, "Review item not found")
    c = await owned_course(db, user, r.course_id)
    if r.status == "resolved":
        raise HTTPException(409, "This item is already resolved.")
    st = await db.get(User, r.student_id)
    r.status, r.note, r.resolved_by, r.resolved_at = "resolved", body.note.strip(), user.id, now()
    await audit(db, user, "Resolved virtual faculty review", "access", f"{c.code} · {r.checkpoint_id} · {st.name if st else r.student_id}",
                reason=body.note.strip(), detail={"kind": r.kind, "review_id": r.id})
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- analytics
async def vf_stats(db: AsyncSession, user: User, course_id: str | None, lesson_id: str | None, avatar_id: str | None,
                   frm: date | None, to: date | None) -> dict:
    cids = await my_course_ids(db, user)
    if course_id:
        await owned_course(db, user, course_id)
        cids = [course_id]
    lq = select(Lesson).where(Lesson.course_id.in_(cids)) if cids else None
    lessons = {l.id: l for l in (await db.execute(lq)).scalars()} if lq is not None else {}
    if lesson_id:
        if lesson_id not in lessons:
            raise HTTPException(404, "Lesson not found in your courses")
        lessons = {lesson_id: lessons[lesson_id]}
    empty = {"started": 0}
    if not lessons:
        return empty
    q = select(VFSession).where(VFSession.lesson_id.in_(list(lessons)), VFSession.status != "superseded", VFSession.started_at.is_not(None))
    if avatar_id:
        q = q.where(VFSession.avatar_id == avatar_id)
    t0 = datetime.combine(frm, time.min, timezone.utc) if frm else None
    t1 = datetime.combine(to, time.max, timezone.utc) if to else None
    if t0:
        q = q.where(VFSession.started_at >= t0)
    if t1:
        q = q.where(VFSession.started_at <= t1)
    ss = (await db.execute(q)).scalars().all()
    if not ss:
        return empty
    sids = [s.id for s in ss]
    atts = (await db.execute(select(VFAttempt).where(VFAttempt.session_id.in_(sids)).order_by(VFAttempt.n))).scalars().all()
    evq = select(Event.type, Event.session_id, Event.payload).where(Event.session_id.in_(sids), Event.type.in_(["eval_error", "abandon", "hint"]))
    evs = (await db.execute(evq)).all()
    t = now()
    completed = [s for s in ss if s.status == "completed"]
    saved = [s for s in ss if s.status in ("saved", "saved-after-error")]
    abandon_ev = {sid for typ, sid, _ in evs if typ == "abandon"}
    abandoned = [s for s in ss if s.id in abandon_ev or (s.status == "active" and s.updated_at and s.updated_at < t - timedelta(minutes=30))]
    durs = [((s.ended_at - s.started_at).total_seconds() / 60) for s in completed if s.ended_at and s.started_at]
    by_cp: dict[str, dict] = {}
    by_sess_cp: dict[tuple, list] = {}
    for a in atts:
        by_sess_cp.setdefault((a.session_id, a.checkpoint_id), []).append(a)
    sess = {s.id: s for s in ss}
    # checkpoint order and labels from lesson content
    cp_meta: dict[str, dict] = {}
    for l in lessons.values():
        for i, sg in enumerate(l.content.get("segments", [])):
            cp = sg["checkpoint"]
            cp_meta.setdefault(cp["id"], {"i": i, "label": f"{cp['id'].upper()} · {sg['title']}", "mandatory": cp["mandatory"], "lesson": l.id,
                                          "mis": {m["id"]: m["label"] for m in cp.get("misconceptions", [])}})
    reached = answered = 0
    for s in ss:
        segs = lessons[s.lesson_id].content.get("segments", [])
        for i, sg in enumerate(segs):
            cid = sg["checkpoint"]["id"]
            if s.status == "completed" or i <= s.seg:
                reached += 1
                d = by_cp.setdefault(cid, {"reached": 0, "answered": 0, "first_ok": 0, "attempts": 0, "hint": 0, "assisted": 0, "skipped": 0})
                d["reached"] += 1
                a = by_sess_cp.get((s.id, cid), [])
                if a:
                    answered += 1
                    d["answered"] += 1
                    d["attempts"] += len(a)
                    d["first_ok"] += 1 if a[0].verdict == "correct" else 0
                if (s.hints or {}).get(cid):
                    d["hint"] += 1
                oc = (s.outcome or {}).get(cid)
                if oc == "assisted":
                    d["assisted"] += 1
                if oc == "skipped":
                    d["skipped"] += 1
    first = [v for (sid, cid), v in by_sess_cp.items()]
    first_ok = sum(1 for v in first if v[0].verdict == "correct")
    hint_cps = sum(1 for s in ss for k, v in (s.hints or {}).items() if not k.startswith("_") and v)
    err_sessions = {sid for typ, sid, _ in evs if typ == "eval_error"}
    err_n = sum(1 for typ, _, _ in evs if typ == "eval_error")
    mis: dict[str, int] = {}
    for a in atts:
        cm = cp_meta.get(a.checkpoint_id, {"mis": {}})
        for m in a.mis or []:
            lab = cm["mis"].get(m, m)
            mis[lab] = mis.get(lab, 0) + 1
    # weekly
    w0 = week_start(min(s.started_at for s in ss))
    nweeks = min(26, (week_start(max(s.started_at for s in ss)) - w0).days // 7 + 1)
    weeks = [{"w": (w0 + timedelta(weeks=i)).strftime("%d %b"), "s": 0, "c": 0} for i in range(nweeks)]
    for s in ss:
        i = (week_start(s.started_at) - w0).days // 7
        if 0 <= i < nweeks:
            weeks[i]["s"] += 1
            weeks[i]["c"] += 1 if s.status == "completed" else 0
    weeks = weeks[-12:]
    # avatars
    av: dict[str, dict] = {}
    for s in ss:
        d = av.setdefault(s.avatar_id, {"id": s.avatar_id, "s": 0, "c": 0, "f": 0, "fn": 0})
        d["s"] += 1
        d["c"] += 1 if s.status == "completed" else 0
    for (sid, cid), v in by_sess_cp.items():
        d = av[sess[sid].avatar_id]
        d["fn"] += 1
        d["f"] += 1 if v[0].verdict == "correct" else 0
    names = {a.id: a.short for a in (await db.execute(select(Avatar))).scalars()}
    recent = sorted(ss, key=lambda s: s.updated_at or s.started_at, reverse=True)[:10]
    users = dict((await db.execute(select(User.id, User.name).where(User.id.in_({s.user_id for s in recent})))).all())
    cps_order = sorted(by_cp, key=lambda k: cp_meta.get(k, {}).get("i", 99))
    # matched pre/post lesson quiz, if the course runs one (events 'pre_quiz' / 'post_quiz' with payload.score in %)
    pp: dict[str, list] = {"pre_quiz": [], "post_quiz": []}
    for typ, p in (await db.execute(select(Event.type, Event.payload).where(Event.type.in_(["pre_quiz", "post_quiz"]), Event.course_id.in_(cids)))).all():
        if isinstance((p or {}).get("score"), (int, float)) and (not (p or {}).get("lesson_id") or p["lesson_id"] in lessons):
            pp[typ].append(float(p["score"]))
    prepost = ({"pre": round(sum(pp["pre_quiz"]) / len(pp["pre_quiz"])), "post": round(sum(pp["post_quiz"]) / len(pp["post_quiz"])),
                "n_pre": len(pp["pre_quiz"]), "n_post": len(pp["post_quiz"])} if pp["pre_quiz"] and pp["post_quiz"] else None)
    return {
        "started": len(ss), "completed": len(completed), "saved": len(saved), "abandoned": len(abandoned),
        "completion": round(100 * len(completed) / len(ss), 1),
        "avg_min": round(sum(durs) / len(durs), 1) if durs else None,
        "planned_min": round(sum(l.content.get("dur", 25) for l in lessons.values()) / len(lessons)),
        "response_rate": round(100 * answered / reached, 1) if reached else None,
        "first_attempt": round(100 * first_ok / len(first), 1) if first else None,
        "avg_attempts": round(len(atts) / len(first), 2) if first else None,
        "hint_use": round(100 * hint_cps / answered, 1) if answered else None,
        "abandon": round(100 * len(abandoned) / len(ss), 1),
        "tech_fail_n": err_n, "tech_fail": round(100 * len(err_sessions) / len(ss), 1),
        "by_week": weeks,
        "by_checkpoint": [{"id": k, "label": cp_meta.get(k, {}).get("label", k), "mandatory": cp_meta.get(k, {}).get("mandatory"),
                           "reached": v["reached"], "answered": v["answered"],
                           "first": round(100 * v["first_ok"] / v["answered"]) if v["answered"] else None,
                           "attempts": round(v["attempts"] / v["answered"], 2) if v["answered"] else None,
                           "hint": round(100 * v["hint"] / v["reached"]) if v["reached"] else None,
                           "assisted": v["assisted"], "skipped": v["skipped"]} for k, v in ((k, by_cp[k]) for k in cps_order)],
        "mis": sorted([{"label": k, "n": v} for k, v in mis.items()], key=lambda x: -x["n"]),
        "by_avatar": sorted([{"id": k, "name": names.get(k, k), "s": d["s"], "c": d["c"], "first": round(100 * d["f"] / d["fn"]) if d["fn"] else None}
                             for k, d in av.items()], key=lambda x: -x["s"]),
        "prepost": prepost,
        "recent": [{"id": s.id, "name": users.get(s.user_id, "Learner"), "avatar": names.get(s.avatar_id, s.avatar_id), "status": s.status,
                    "outcome": s.outcome or {}, "attempts": {cid: len(by_sess_cp.get((s.id, cid), [])) for cid in (s.outcome or {})},
                    "min": round((s.ended_at - s.started_at).total_seconds() / 60) if s.started_at and s.ended_at else None,
                    "at": iso(s.updated_at)} for s in recent],
    }


def _d(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(422, "Dates must be YYYY-MM-DD.")


@router.get("/analytics")
async def analytics(course_id: str | None = None, lesson_id: str | None = None, avatar_id: str | None = None, frm: str | None = None,
                    to: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    return await vf_stats(db, user, course_id or None, lesson_id or None, avatar_id or None, _d(frm), _d(to))


@router.get("/analytics.csv")
async def analytics_csv(course_id: str | None = None, lesson_id: str | None = None, avatar_id: str | None = None, frm: str | None = None,
                        to: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(STAFF)):
    s = await vf_stats(db, user, course_id or None, lesson_id or None, avatar_id or None, _d(frm), _d(to))
    rows = [["Metric", "Value", "Definition"],
            ["Filters", f"course={course_id or 'all'} lesson={lesson_id or 'all'} avatar={avatar_id or 'all'} from={frm or '-'} to={to or '-'}", ""],
            ["Sessions started", s.get("started", 0), "Sessions where the learner pressed Start"]]
    if s.get("started"):
        rows += [["Sessions completed", s["completed"], "Reached the recap"],
                 ["Avg duration (min)", s["avg_min"], "Start to recap, completed sessions"],
                 ["Checkpoint response rate %", s["response_rate"], "Checkpoints answered at least once / checkpoints reached"],
                 ["First-attempt correct %", s["first_attempt"], "Correct on first submission under the lecturer's pass rule"],
                 ["Avg attempts per question", s["avg_attempts"], ""],
                 ["Hint usage %", s["hint_use"], "Checkpoints with at least one hint / checkpoints answered"],
                 ["Abandonment %", s["abandon"], "Started and abandoned (closed without recap or Save & exit)"],
                 ["Technical failures", s["tech_fail_n"], "AI evaluation errors (eval_error events)"]]
        rows += [[f"{c['label']} first-attempt %", c["first"], f"avg attempts {c['attempts']}, hint use {c['hint']}%"] for c in s["by_checkpoint"]]
        rows += [[f"Misconception: {m['label']}", m["n"], "answers"] for m in s["mis"]]
        rows += [[f"Avatar {a['name']} sessions", a["s"], f"completed {a['c']}, first-try {a['first']}%"] for a in s["by_avatar"]]
        rows += [[], ["Week", "Started", "Completed"]] + [[w["w"], w["s"], w["c"]] for w in s["by_week"]]
    await audit(db, user, "Exported virtual faculty analytics", "export", "Virtual faculty analytics CSV",
                detail={"course": course_id, "lesson": lesson_id, "avatar": avatar_id, "from": frm, "to": to})
    await db.commit()
    return Response(csv_bytes(rows), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="virtual-faculty-analytics.csv"'})
