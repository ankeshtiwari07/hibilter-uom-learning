"""Assessment builder (S17): quizzes, assignments and exams with explicit, lecturer-approved scoring rules."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.db import get_db
from ..core.deps import require
from ..models import Assessment, Submission, User
from ._lecturer_common import iso, my_course_ids, owned_assessment, owned_course

router = APIRouter(prefix="/api/lecturer", tags=["lecturer-assessments"])
LECT = require("lecturer")


class QuestionIn(BaseModel):
    q: str = Field(default="", max_length=1000)
    o: list[str] = Field(default_factory=lambda: ["", "", "", ""], min_length=2, max_length=6)
    a: int | None = Field(default=None, ge=0, le=5)
    ex: str = Field(default="", max_length=1000)
    m: float = Field(default=1, ge=0, le=100)


class CriterionIn(BaseModel):
    criterion: str = Field(default="", max_length=200)
    max: float = Field(default=10, ge=0, le=1000)
    desc: str = Field(default="", max_length=600)


class SettingsIn(BaseModel):
    time_limit: int | None = Field(default=None, ge=1, le=600)
    attempts: int = Field(default=1, ge=1, le=5)
    late_policy: Literal["accept", "penalty", "reject"] = "accept"
    late_penalty: int = Field(default=10, ge=0, le=100)
    shuffle: bool = True
    show_answers: bool = True
    accommodations: bool = True
    accepted_files: str = Field(default="PDF, DOCX", max_length=100)
    reminders: list[str] = Field(default_factory=list, max_length=3)


class AssessmentIn(BaseModel):
    course_id: str = Field(max_length=32)
    title: str = Field(min_length=3, max_length=300)
    type: Literal["quiz", "assignment", "exam", "lab"]
    due: datetime | None = None
    weight: int = Field(default=10, ge=0, le=100)
    max_score: int = Field(default=100, ge=1, le=1000)
    instructions: str = Field(default="", max_length=8000)
    questions: list[QuestionIn] = Field(default_factory=list, max_length=100)
    rubric: list[CriterionIn] = Field(default_factory=list, max_length=20)
    settings: SettingsIn = Field(default_factory=SettingsIn)
    status: Literal["draft", "published"] = "draft"

    @field_validator("title")
    @classmethod
    def t(cls, v: str) -> str:
        return v.strip()


def publish_errors(b: AssessmentIn, other_weight: int) -> list[str]:
    errs = []
    if b.due is None:
        errs.append("Set a due date.")
    if b.type == "quiz":
        if not b.questions:
            errs.append("Add at least one question.")
        for i, q in enumerate(b.questions, 1):
            if not q.q.strip():
                errs.append(f"Question {i} has no text.")
            if len(q.o) != 4:
                errs.append(f"Question {i} needs four options.")
            if any(not o.strip() for o in q.o):
                errs.append(f"Question {i} has an empty option.")
            if q.a is None or q.a >= len(q.o):
                errs.append(f"Question {i} needs a correct answer selected.")
    else:
        if len(b.instructions.strip()) < 20:
            errs.append("Write a brief of at least 20 characters.")
        if b.type in ("assignment", "lab"):
            if not b.rubric:
                errs.append("Add at least one rubric criterion.")
            for i, c in enumerate(b.rubric, 1):
                if not c.criterion.strip():
                    errs.append(f"Rubric criterion {i} has no name.")
                if c.max <= 0:
                    errs.append(f"Rubric criterion {i} needs marks above zero.")
            tot = sum(c.max for c in b.rubric)
            if b.rubric and abs(tot - b.max_score) > 1e-6:
                errs.append(f"Rubric marks add up to {tot:g}, but the assessment is out of {b.max_score}.")
    if other_weight + b.weight > 100:
        errs.append(f"Course weights would total {other_weight + b.weight}% (published assessments already use {other_weight}%).")
    return errs


def out(a: Assessment, counts: dict | None = None) -> dict:
    return {"id": a.id, "course_id": a.course_id, "title": a.title, "type": a.type, "due": iso(a.due), "weight": a.weight,
            "max_score": a.max_score, "status": a.status, "instructions": a.instructions, "questions": a.questions or [],
            "rubric": a.rubric or [], "settings": a.settings or {}, "created_at": iso(a.created_at), **(counts or {})}


@router.get("/assessments")
async def list_assessments(course_id: str | None = None, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    if course_id:
        await owned_course(db, user, course_id)
    cids = [course_id] if course_id else await my_course_ids(db, user)
    if not cids:
        return []
    rows = (await db.execute(select(Assessment).where(Assessment.course_id.in_(cids)).order_by(Assessment.due.desc().nulls_last()))).scalars().all()
    cnt = dict((await db.execute(select(Submission.assessment_id, func.count()).where(Submission.assessment_id.in_([a.id for a in rows]),
                                                                                    Submission.status != "draft").group_by(Submission.assessment_id))).all()) if rows else {}
    return [out(a, {"submissions": cnt.get(a.id, 0)}) for a in rows]


@router.get("/assessments/bank")
async def question_bank(course_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    """Multiple-choice questions already used in this course's quizzes."""
    await owned_course(db, user, course_id)
    rows = (await db.execute(select(Assessment).where(Assessment.course_id == course_id, Assessment.type == "quiz"))).scalars().all()
    seen, bank = set(), []
    for a in rows:
        for q in a.questions or []:
            if q.get("q") and q["q"] not in seen:
                seen.add(q["q"])
                bank.append({**q, "from": a.title})
    return bank


@router.get("/assessments/{aid}")
async def get_assessment(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    a, _ = await owned_assessment(db, user, aid)
    n = (await db.execute(select(func.count()).select_from(Submission).where(Submission.assessment_id == aid, Submission.status != "draft"))).scalar()
    return out(a, {"submissions": n})


async def _other_weight(db: AsyncSession, course_id: str, exclude: str | None) -> int:
    q = select(func.coalesce(func.sum(Assessment.weight), 0)).where(Assessment.course_id == course_id, Assessment.status == "published")
    if exclude:
        q = q.where(Assessment.id != exclude)
    return int((await db.execute(q)).scalar() or 0)


def _apply(a: Assessment, b: AssessmentIn):
    a.title, a.type, a.due, a.weight, a.max_score = b.title, b.type, b.due, b.weight, b.max_score
    a.instructions = b.instructions
    a.questions = [q.model_dump() for q in b.questions] if b.type == "quiz" else []
    a.rubric = [c.model_dump() for c in b.rubric] if b.type != "quiz" else []
    a.settings = b.settings.model_dump()
    a.status = b.status


@router.post("/assessments")
async def create_assessment(body: AssessmentIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    c = await owned_course(db, user, body.course_id)
    if body.status == "published":
        errs = publish_errors(body, await _other_weight(db, c.id, None))
        if errs:
            raise HTTPException(422, " ".join(errs))
    a = Assessment(course_id=c.id, title=body.title, type=body.type)
    _apply(a, body)
    db.add(a)
    await db.flush()
    await audit(db, user, "Published assessment" if body.status == "published" else "Created assessment draft", "content",
                f"{c.code} · {a.title}", detail={"type": a.type, "weight": a.weight, "max": a.max_score})
    await db.commit()
    return out(a, {"submissions": 0})


@router.put("/assessments/{aid}")
async def update_assessment(aid: str, body: AssessmentIn, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    a, c = await owned_assessment(db, user, aid)
    if body.course_id != a.course_id:
        raise HTTPException(422, "An assessment can't be moved to another course.")
    subs = (await db.execute(select(func.count()).select_from(Submission).where(Submission.assessment_id == aid, Submission.status != "draft"))).scalar() or 0
    if subs and (body.type != a.type or body.max_score != a.max_score):
        raise HTTPException(409, "Students have already submitted, so the type and maximum score can't change.")
    if body.status == "published":
        errs = publish_errors(body, await _other_weight(db, c.id, aid))
        if errs:
            raise HTTPException(422, " ".join(errs))
    if a.status == "published" and body.status == "draft" and subs:
        raise HTTPException(409, "Students have already submitted, so this assessment can't go back to draft.")
    was = a.status
    _apply(a, body)
    action = ("Published assessment" if was != "published" and a.status == "published"
              else "Unpublished assessment" if was == "published" and a.status == "draft" else "Updated assessment")
    await audit(db, user, action, "content", f"{c.code} · {a.title}", detail={"type": a.type, "weight": a.weight, "max": a.max_score})
    await db.commit()
    return out(a, {"submissions": subs})


@router.delete("/assessments/{aid}")
async def delete_assessment(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(LECT)):
    a, c = await owned_assessment(db, user, aid)
    n = (await db.execute(select(func.count()).select_from(Submission).where(Submission.assessment_id == aid))).scalar() or 0
    if n:
        raise HTTPException(409, "This assessment has submissions and can't be deleted.")
    await db.delete(a)
    await audit(db, user, "Deleted assessment", "content", f"{c.code} · {a.title}")
    await db.commit()
    return {"ok": True}
