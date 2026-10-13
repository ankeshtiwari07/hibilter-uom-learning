"""Student portal: AI study assistant (S06). Answers come only from approved course material via
app.services.assistant.grounded_answer; every turn is stored in AssistantTurn."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.db import get_db
from ..core.deps import require
from ..core.ratelimit import hit
from ..evaluation import llm
from ..models import Assessment, AssistantTurn, Course, Source, User
from ..services.assistant import grounded_answer, toks
from ._student_util import enrolled_ids, iso, now, require_enrolled

router = APIRouter(prefix="/api/student/assistant", tags=["student"])
student = require("student")

MODES = {
    "lesson": "",
    "simple": " (Explain in very simple language with an everyday example.)",
    "summ": " (Give a short summary as numbered points.)",
    "rev": " (Write three revision questions on this topic, without answers.)",
    "quiz": " (Write a three-question multiple-choice practice quiz on this topic, with the answer after each question.)",
}
SOLVE = re.compile(r"\b(answer|solve|do|write|complete|finish)\b.{0,40}\b(my|the|this)\b.{0,30}\b(assignment|quiz|exam|test|coursework|homework|lab report)\b", re.I)
REFUSAL = ("I can’t help complete graded assessment questions. I can explain the ideas behind them from your approved course "
           "material — try asking about the concept instead, or ask your lecturer.")


def turn_out(t: AssistantTurn) -> dict:
    return {"id": t.id, "course_id": t.course_id, "question": t.question, "answer": t.answer, "citations": t.citations or [],
            "grounded": t.grounded, "engine": t.engine, "rating": t.rating, "at": iso(t.created_at)}


async def _is_assessment_question(db: AsyncSession, course_id: str, q: str) -> bool:
    if SOLVE.search(q):
        return True
    qt = set(toks(q))
    if len(qt) < 4:
        return False
    rows = (await db.execute(select(Assessment).where(Assessment.course_id == course_id, Assessment.status == "published",
                                                      Assessment.type.in_(["quiz", "exam"])))).scalars()
    for a in rows:
        if a.due and a.due < now():
            continue  # closed assessments can be discussed
        for item in a.questions or []:
            it = set(toks(item.get("q", "")))
            if len(it) >= 4 and len(qt & it) / len(it) >= 0.7:
                return True
    return False


@router.get("/courses")
async def courses(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    cs = list((await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars())
    srcs = list((await db.execute(select(Source).where(Source.course_id.in_(cids or ["-"]), Source.approved.is_(True)).order_by(Source.created_at))).scalars())
    order = {c: i for i, c in enumerate(cids)}
    return {"live": llm.available(),
            "courses": [{"id": c.id, "code": c.code, "title": c.title,
                         "sources": [{"id": s.id, "title": s.title, "kind": s.kind} for s in srcs if s.course_id == c.id]}
                        for c in sorted(cs, key=lambda c: order.get(c.id, 99))]}


@router.get("/history")
async def history(course_id: str | None = None, limit: int = Query(default=50, ge=1, le=200),
                  db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    q = select(AssistantTurn).where(AssistantTurn.user_id == user.id)
    if course_id:
        q = q.where(AssistantTurn.course_id == course_id)
    rows = list((await db.execute(q.order_by(AssistantTurn.id.desc()).limit(limit))).scalars())
    return [turn_out(t) for t in reversed(rows)]


class AskIn(BaseModel):
    course_id: str = Field(min_length=1, max_length=32)
    q: str = Field(min_length=1, max_length=2000)
    mode: str = Field(default="lesson", pattern="^(lesson|simple|summ|rev|quiz)$")


@router.post("/ask")
async def ask(body: AskIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    q = body.q.strip()
    if not q:
        raise HTTPException(422, "Type a question first.")
    c, _ = await require_enrolled(db, user, body.course_id)
    if not await hit(f"assistant:{user.id}", 20):
        raise HTTPException(429, "You’re asking very quickly. Wait a minute and try again.")
    if await _is_assessment_question(db, c.id, q):
        res = {"answer": REFUSAL, "citations": [], "grounded": False, "engine": "policy"}
    else:
        res = await grounded_answer(db, [c.id], q + MODES[body.mode])
    t = AssistantTurn(user_id=user.id, course_id=c.id, question=q, answer=res["answer"], citations=res.get("citations") or [],
                      grounded=bool(res.get("grounded")), engine=str(res.get("engine", "retrieval"))[:16])
    db.add(t)
    await db.commit()
    return turn_out(t)


class RateIn(BaseModel):
    rating: int = Field(ge=-1, le=1)


@router.post("/turns/{turn_id}/rate")
async def rate(turn_id: int, body: RateIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    t = await db.get(AssistantTurn, turn_id)
    if not t or t.user_id != user.id:
        raise HTTPException(404, "Answer not found")
    t.rating = body.rating or None
    await db.commit()
    return {"id": t.id, "rating": t.rating}
