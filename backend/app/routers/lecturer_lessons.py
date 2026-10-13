"""Module & lesson editor (S16): Virtual Faculty lesson authoring, drafts, versioned publishing and checkpoint calibration.

Drafts live in a Setting row keyed `lesson_draft:<lesson id>` so students keep seeing the published content until the
lecturer publishes. Calibration samples live in Lesson.content['calibration'][cp_id] (lecturer-only; never sent to students)."""
from __future__ import annotations

import asyncio
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..evaluation import llm
from ..evaluation.service import EvaluationFailed, evaluate
from ..models import Lesson, LessonVersion, Module, Setting, User, VFSession
from ._lecturer_common import iso, my_course_ids, now, owned_course, owned_lesson

router = APIRouter(prefix="/api/lecturer", tags=["lecturer-lessons"])
LECT = require("lecturer", "admin")
ID = r"^[A-Za-z0-9_-]{1,32}$"
VERDICTS = ("correct", "partial", "incorrect", "unclear")
CALIB_MIN_SAMPLES = 5
CALIB_MIN_AGREEMENT = 80


# ---------------------------------------------------------------- lesson structure (validated server-side)
class RxIn(BaseModel):
    re: str = Field(min_length=1, max_length=400)
    flags: str = Field(default="i", pattern="^i?$")

    @field_validator("re")
    @classmethod
    def compiles(cls, v: str) -> str:
        try:
            re.compile(v)
        except re.error as e:
            raise ValueError(f"Pattern “{v[:40]}” is not a valid regular expression ({e.msg}).")
        return v


class ConceptIn(BaseModel):
    id: str = Field(pattern=ID)
    label: str = Field(min_length=2, max_length=200)
    required: bool = False
    rx: list[RxIn] = Field(min_length=1, max_length=20)


class MisconceptionIn(BaseModel):
    id: str = Field(pattern=ID)
    label: str = Field(min_length=2, max_length=200)
    rx: list[RxIn] = Field(default_factory=list, max_length=20)


class CheckpointIn(BaseModel):
    id: str = Field(pattern=ID)
    mandatory: bool = True
    maxAttempts: int = Field(default=3, ge=1, le=5)
    question: str = Field(min_length=5, max_length=500)
    concepts: list[ConceptIn] = Field(min_length=1, max_length=10)
    misconceptions: list[MisconceptionIn] = Field(default_factory=list, max_length=10)
    hints: list[str] = Field(min_length=1, max_length=5)
    model: str = Field(min_length=5, max_length=1200)
    reteach: str = Field(min_length=5, max_length=2000)
    ack: str | None = Field(default=None, max_length=600)

    @model_validator(mode="after")
    def check(self):
        ids = [c.id for c in self.concepts]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Checkpoint {self.id}: concept ids must be unique.")
        if not any(c.required for c in self.concepts):
            raise ValueError(f"Checkpoint {self.id}: mark at least one concept as required.")
        mids = [m.id for m in self.misconceptions]
        if len(mids) != len(set(mids)):
            raise ValueError(f"Checkpoint {self.id}: misconception ids must be unique.")
        for h in self.hints:
            if not h.strip() or len(h) > 500:
                raise ValueError(f"Checkpoint {self.id}: hints must be 1–500 characters.")
        return self


class SegmentIn(BaseModel):
    id: str = Field(pattern=ID)
    title: str = Field(min_length=2, max_length=200)
    slide: str | None = Field(default=None, max_length=32)
    speech: list[str] = Field(min_length=1, max_length=30)
    simpler: list[str] = Field(min_length=1, max_length=30)
    checkpoint: CheckpointIn

    @field_validator("speech", "simpler")
    @classmethod
    def lines(cls, v: list[str]) -> list[str]:
        v = [x.strip() for x in v]
        for x in v:
            if not x or len(x) > 600:
                raise ValueError("Each spoken line must be 1–600 characters.")
        return v


class LessonContentIn(BaseModel):
    title: str = Field(min_length=3, max_length=300)
    module: str = Field(default="", max_length=200)
    dur: int = Field(default=25, ge=1, le=240)
    objectives: list[str] = Field(default_factory=list, max_length=10)
    segments: list[SegmentIn] = Field(min_length=1, max_length=12)
    closing: list[str] = Field(min_length=1, max_length=10)
    side_answers: dict[str, str] = Field(default_factory=dict)
    concept_ask: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def unique(self):
        sids = [s.id for s in self.segments]
        cids = [s.checkpoint.id for s in self.segments]
        if len(sids) != len(set(sids)):
            raise ValueError("Segment ids must be unique.")
        if len(cids) != len(set(cids)):
            raise ValueError("Checkpoint ids must be unique across the lesson.")
        if not any(s.checkpoint.mandatory for s in self.segments):
            raise ValueError("At least one checkpoint must be mandatory.")
        return self


def clean_content(body: LessonContentIn, base: dict) -> dict:
    """Validated content + server-held keys (id, course, calibration) from the stored lesson."""
    c = body.model_dump(exclude_none=True)
    for k in ("id", "course"):
        if k in base:
            c[k] = base[k]
    return c


# ---------------------------------------------------------------- drafts
def draft_key(lid: str) -> str:
    return f"lesson_draft:{lid}"


async def get_draft(db: AsyncSession, lid: str) -> Setting | None:
    return await db.get(Setting, draft_key(lid))


def _editable(lesson: Lesson, draft: Setting | None) -> dict:
    content = (draft.value["content"] if draft else lesson.content) or {}
    return {k: v for k, v in content.items() if k != "calibration"}


def default_policy(p: dict | None) -> dict:
    return {"threshold": "required", "hints": True, "assisted": True, "simpler": True, **(p or {})}


@router.get("/lessons")
async def list_lessons(course_id: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    cids = [course_id] if course_id else await my_course_ids(db, user)
    if course_id:
        await owned_course(db, user, course_id)
    if not cids:
        return []
    rows = (await db.execute(select(Lesson).where(Lesson.course_id.in_(cids)).order_by(Lesson.course_id, Lesson.id))).scalars().all()
    drafts = {s.key.split(":", 1)[1]: s.value for s in (await db.execute(select(Setting).where(Setting.key.in_([draft_key(l.id) for l in rows])))).scalars()} if rows else {}
    out = []
    for l in rows:
        d = drafts.get(l.id)
        out.append({"id": l.id, "course_id": l.course_id, "title": l.title, "module": l.module, "status": l.status, "version": l.version,
                    "published_at": iso(l.published_at), "checkpoints": len(l.content.get("segments", [])), "avatars": l.avatars,
                    "draft": {"no": d["no"], "at": d["at"], "by": d.get("by_name")} if d else None})
    return out


TEMPLATE_SEG = {
    "id": "seg1", "title": "Introduction", "slide": None,
    "speech": ["Write the first thing the digital lecturer says here."],
    "simpler": ["Write a simpler version of the explanation here."],
    "checkpoint": {"id": "cp1", "mandatory": True, "maxAttempts": 3, "question": "Ask a short question that checks the main idea?",
                   "concepts": [{"id": "main", "label": "States the main idea", "required": True, "rx": [{"re": "\\bmain idea\\b", "flags": "i"}]}],
                   "misconceptions": [], "hints": ["Give a gentle hint here."], "model": "Write the model answer here.",
                   "reteach": "Explain the idea a different way here.", "ack": ""},
}


class NewLessonIn(BaseModel):
    course_id: str = Field(max_length=32)
    title: str = Field(min_length=3, max_length=300)
    module: str = Field(default="", max_length=200)


@router.post("/lessons")
async def create_lesson(body: NewLessonIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    course = await owned_course(db, user, body.course_id)
    n = (await db.execute(select(func.count()).select_from(Lesson))).scalar() or 0
    lid = f"{course.code.replace('-', '')}-L{n + 1}-{now().strftime('%m%d%H%M%S')}"[:32]
    content = {"id": lid, "course": course.id, "title": body.title.strip(), "module": body.module.strip(), "dur": 20,
               "objectives": [], "segments": [TEMPLATE_SEG], "closing": ["Well done today, {name}.", "That brings us to the end of this lesson."]}
    db.add(Lesson(id=lid, course_id=course.id, title=body.title.strip(), module=body.module.strip(), version=0, status="draft",
                  content=content, policy=default_policy(None), avatars=["henri"]))
    await audit(db, user, "Created lesson", "content", f"{course.code} · {body.title.strip()}")
    await db.commit()
    return {"id": lid}


@router.get("/lessons/{lid}")
async def get_lesson(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    draft = await get_draft(db, lid)
    versions = (await db.execute(select(LessonVersion, User.name).outerjoin(User, User.id == LessonVersion.author_id)
                                 .where(LessonVersion.lesson_id == lid).order_by(LessonVersion.version.desc()))).all()
    sessions = (await db.execute(select(func.count()).select_from(VFSession).where(VFSession.lesson_id == lid))).scalar() or 0
    return {"id": lesson.id, "course_id": course.id, "course_code": course.code, "course_title": course.title,
            "title": lesson.title, "module": lesson.module, "status": lesson.status, "version": lesson.version,
            "published_at": iso(lesson.published_at), "policy": default_policy(lesson.policy), "avatars": lesson.avatars,
            "content": _editable(lesson, draft),
            "draft": {"no": draft.value["no"], "at": draft.value["at"], "by": draft.value.get("by_name")} if draft else None,
            "calibration": (lesson.content or {}).get("calibration", {}),
            "versions": [{"version": v.version, "at": iso(v.created_at), "by": name} for v, name in versions],
            "sessions": sessions, "llm": llm.available()}


@router.put("/lessons/{lid}/draft")
async def save_draft(lid: str, body: LessonContentIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    content = clean_content(body, lesson.content or {})
    draft = await get_draft(db, lid)
    no = (draft.value.get("no", 0) + 1) if draft else 1
    val = {"content": content, "no": no, "at": iso(now()), "by": user.id, "by_name": user.name, "base_version": lesson.version}
    if draft:
        draft.value = val
    else:
        db.add(Setting(key=draft_key(lid), value=val))
    await audit(db, user, "Saved lesson draft", "content", f"{course.code} · {content['title']} (draft {no})")
    await db.commit()
    return {"ok": True, "draft": {"no": no, "at": val["at"], "by": user.name}}


@router.delete("/lessons/{lid}/draft")
async def discard_draft(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    draft = await get_draft(db, lid)
    if not draft:
        raise HTTPException(404, "There is no draft to discard.")
    await db.delete(draft)
    await audit(db, user, "Discarded lesson draft", "content", f"{course.code} · {lesson.title}")
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- calibration
class SampleIn(BaseModel):
    answer: str = Field(min_length=1, max_length=1200)
    expected: Literal["correct", "partial", "incorrect", "unclear"]


class SamplesIn(BaseModel):
    samples: list[SampleIn] = Field(max_length=50)


def _cps(content: dict) -> dict[str, dict]:
    return {s["checkpoint"]["id"]: s["checkpoint"] for s in content.get("segments", [])}


@router.put("/lessons/{lid}/calibration/{cp_id}")
async def save_samples(lid: str, cp_id: str, body: SamplesIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    draft = await get_draft(db, lid)
    if cp_id not in _cps(_editable(lesson, draft)) and cp_id not in _cps(lesson.content or {}):
        raise HTTPException(404, "Checkpoint not found in this lesson.")
    cal = dict((lesson.content or {}).get("calibration", {}))
    cal[cp_id] = [s.model_dump() for s in body.samples]
    lesson.content = {**lesson.content, "calibration": cal}
    await audit(db, user, "Updated calibration answers", "content", f"{course.code} · {lesson.title} · {cp_id}", detail={"samples": len(body.samples)})
    await db.commit()
    return {"ok": True, "n": len(body.samples)}


async def run_calibration(content: dict, calibration: dict, threshold: str, engine: str, only: str | None = None) -> dict:
    out = {}
    sem = asyncio.Semaphore(4)
    for cp_id, cp in _cps(content).items():
        if only and cp_id != only:
            continue
        samples = calibration.get(cp_id, [])

        async def one(s):
            async with sem:
                try:
                    r, _ = await evaluate(cp, s["answer"], "Student", 1, threshold, engine=engine)
                    return {"answer": s["answer"], "expected": s["expected"], "got": r["verdict"], "engine": r["engine"],
                            "found": r["found"], "missing": r["missing"], "mis": r["mis"], "ok": r["verdict"] == s["expected"]}
                except EvaluationFailed as e:
                    return {"answer": s["answer"], "expected": s["expected"], "got": None, "error": e.code, "ok": False}

        rows = await asyncio.gather(*(one(s) for s in samples))
        n = len(rows)
        agree = sum(1 for r in rows if r["ok"])
        pct = round(100 * agree / n) if n else None
        out[cp_id] = {"n": n, "agree": agree, "pct": pct, "rows": rows,
                      "gated": n >= CALIB_MIN_SAMPLES, "blocking": n >= CALIB_MIN_SAMPLES and pct is not None and pct < CALIB_MIN_AGREEMENT}
    return out


class CalibrateIn(BaseModel):
    engine: Literal["rubric", "auto", "claude"] = "rubric"
    cp_id: str | None = Field(default=None, max_length=32)


@router.post("/lessons/{lid}/calibrate")
async def calibrate(lid: str, body: CalibrateIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, _ = await owned_lesson(db, user, lid)
    if body.engine == "claude" and not llm.available():
        raise HTTPException(422, "The Claude evaluator isn't configured on this server. Use the rubric engine.")
    content = _editable(lesson, await get_draft(db, lid))
    res = await run_calibration(content, (lesson.content or {}).get("calibration", {}), default_policy(lesson.policy)["threshold"], body.engine, body.cp_id)
    return {"engine": body.engine, "min_samples": CALIB_MIN_SAMPLES, "min_agreement": CALIB_MIN_AGREEMENT, "checkpoints": res}


# ---------------------------------------------------------------- publish
def publish_engine() -> str:
    return "auto" if llm.available() else "rubric"


@router.post("/lessons/{lid}/publish")
async def publish(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    draft = await get_draft(db, lid)
    content = _editable(lesson, draft)
    try:
        valid = LessonContentIn.model_validate(content)
    except ValidationError as e:
        first = e.errors()[0]
        raise HTTPException(422, f"Fix the lesson before publishing: {first.get('msg', 'invalid structure')} ({'.'.join(str(x) for x in first.get('loc', []))}).")
    content = clean_content(valid, lesson.content or {})
    calibration = (lesson.content or {}).get("calibration", {})
    res = await run_calibration(content, calibration, default_policy(lesson.policy)["threshold"], publish_engine())
    blocking = [f"{cp} ({r['pct']}% on {r['n']} answers)" for cp, r in res.items() if r["blocking"]]
    if blocking:
        raise HTTPException(422, f"Publishing is blocked: evaluator agreement is below {CALIB_MIN_AGREEMENT}% for {', '.join(blocking)}. "
                                 "Adjust the concepts or patterns and run calibration again.")
    # bake an explicit retry-limit override from the lesson policy into mandatory checkpoints
    pol = default_policy(lesson.policy)
    if pol.get("maxAttempts"):
        for s in content["segments"]:
            if s["checkpoint"]["mandatory"]:
                s["checkpoint"]["maxAttempts"] = int(pol["maxAttempts"])
    content["calibration"] = calibration
    old = lesson.version
    lesson.version = (lesson.version or 0) + 1
    lesson.content = content
    lesson.title = content["title"]
    lesson.module = content.get("module", lesson.module)
    lesson.status = "published"
    lesson.published_at = now()
    db.add(LessonVersion(lesson_id=lid, version=lesson.version, content=content, policy=lesson.policy or {}, author_id=user.id))
    if draft:
        await db.delete(draft)
    await audit(db, user, "Published lesson", "content", f"{course.code} · {lesson.title} v{lesson.version}",
                detail={"from_version": old, "to_version": lesson.version, "calibration": {k: v["pct"] for k, v in res.items() if v["n"]}})
    await db.commit()
    return {"ok": True, "version": lesson.version, "published_at": iso(lesson.published_at)}


@router.post("/lessons/{lid}/unpublish")
async def unpublish(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    if lesson.status != "published":
        raise HTTPException(409, "This lesson is not published.")
    lesson.status = "draft"
    await audit(db, user, "Unpublished lesson", "content", f"{course.code} · {lesson.title} v{lesson.version}")
    await db.commit()
    return {"ok": True}


@router.delete("/lessons/{lid}")
async def delete_lesson(lid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    lesson, course = await owned_lesson(db, user, lid)
    used = (await db.execute(select(func.count()).select_from(VFSession).where(VFSession.lesson_id == lid))).scalar() or 0
    if used:
        raise HTTPException(409, "Students have already taken this lesson, so it can't be deleted. Unpublish it instead.")
    for v in (await db.execute(select(LessonVersion).where(LessonVersion.lesson_id == lid))).scalars():
        await db.delete(v)
    draft = await get_draft(db, lid)
    if draft:
        await db.delete(draft)
    for m in (await db.execute(select(Module).where(Module.course_id == course.id))).scalars():
        if any(it.get("lesson_id") == lid or it.get("id") == lid for it in (m.items or [])):
            m.items = [it for it in m.items if it.get("lesson_id") != lid and it.get("id") != lid]
    await db.flush()
    await db.delete(lesson)
    await audit(db, user, "Deleted lesson", "content", f"{course.code} · {lesson.title}")
    await db.commit()
    return {"ok": True}
