"""Grounded answers from approved course material only (LLD §6.5). Retrieval is lexical (BM25-style) over approved chunks;
generation is Claude with citations; canned answers when Claude is unavailable."""
from __future__ import annotations

import math
import re
import time
from collections import Counter

import anthropic
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import get_settings
from ..evaluation import llm
from ..models import Chunk, EvalLog, Source

STOP = set("a an the is are was were be been of to in on for and or with what why how when which who does do did it its this that as by from at into can could would should about".split())


def toks(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 1]


def bm25(query: str, docs: list[str], k1: float = 1.4, b: float = 0.75) -> list[float]:
    q = toks(query)
    D = [toks(d) for d in docs]
    if not D:
        return []
    avg = sum(len(d) for d in D) / len(D) or 1
    df = Counter(w for d in D for w in set(d))
    N = len(D)
    out = []
    for d in D:
        tf = Counter(d)
        s = 0.0
        for w in q:
            if w in tf:
                idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(d) / avg))
        out.append(s)
    return out


async def retrieve(db: AsyncSession, course_ids: list[str], q: str, k: int = 5) -> list[dict]:
    rows = (await db.execute(select(Chunk, Source).join(Source, Source.id == Chunk.source_id)
                             .where(Chunk.course_id.in_(course_ids), Source.approved.is_(True)))).all()
    if not rows:
        return []
    scores = bm25(q, [c.text for c, _ in rows])
    ranked = sorted(zip(scores, rows), key=lambda x: -x[0])[:k]
    return [{"id": f"S{i + 1}", "chunk_id": c.id, "source": s.title, "source_id": s.id, "page": c.page, "text": c.text, "score": round(sc, 3)}
            for i, (sc, (c, s)) in enumerate(ranked) if sc > 0.5]


class Answer(BaseModel):
    answer: str
    citations: list[str]
    grounded: bool


SYSTEM = ("You are a university study assistant. Answer ONLY from the numbered approved passages provided. Cite passage ids like [S1]. "
          "If the passages do not contain the answer, set grounded=false and say briefly that it is not covered in the approved material "
          "and suggest asking the course lecturer. Never help complete graded assessment questions. Plain text, no markdown headings.")


async def grounded_answer(db: AsyncSession, course_ids: list[str], q: str, persona: str | None = None, max_sentences: int = 5) -> dict:
    passages = await retrieve(db, course_ids, q)
    if not passages:
        return {"answer": "I couldn’t find that in the approved course material. Try rephrasing, or ask your lecturer in the course forum.",
                "citations": [], "grounded": False, "engine": "retrieval"}
    if not llm.available():
        top = passages[0]
        sent = re.split(r"(?<=[.!?])\s+", top["text"])
        best = max(sent, key=lambda x: len(set(toks(x)) & set(toks(q))))
        return {"answer": best, "citations": [{k: top[k] for k in ("id", "source", "page")}], "grounded": True, "engine": "extractive"}
    s = get_settings()
    ctx = "\n\n".join(f"[{p['id']}] ({p['source']}, p.{p['page']}): {p['text']}" for p in passages)
    who = f"You are speaking as {persona}, a digital lecturer, in at most {max_sentences} short spoken sentences. " if persona else ""
    t0 = time.monotonic()
    try:
        resp = await llm.client().beta.messages.parse(
            model=s.llm_model, max_tokens=1500, system=who + SYSTEM, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "low"}, output_format=Answer,
            messages=[{"role": "user", "content": f"APPROVED PASSAGES:\n{ctx}\n\n<question>{q[:500]}</question>"}])
        a: Answer | None = resp.parsed_output
        if resp.stop_reason == "refusal" or a is None:
            raise ValueError("no answer")
        db.add(EvalLog(kind="assistant", model=s.llm_model, prompt_hash="-", latency_ms=int((time.monotonic() - t0) * 1000), ok=True,
                       raw={"q": q[:300], "grounded": a.grounded}, input_tokens=resp.usage.input_tokens, output_tokens=resp.usage.output_tokens))
        valid = {p["id"]: p for p in passages}
        cites = [{k: valid[c][k] for k in ("id", "source", "page")} for c in dict.fromkeys(a.citations) if c in valid]
        grounded = a.grounded and bool(cites)
        return {"answer": a.answer.strip(), "citations": cites, "grounded": grounded, "engine": "claude"}
    except (anthropic.APIError, ValueError, Exception):
        top = passages[0]
        return {"answer": top["text"][:400], "citations": [{k: top[k] for k in ("id", "source", "page")}], "grounded": True, "engine": "extractive"}


async def side_answer(db: AsyncSession, c, q: str) -> dict:
    """Classroom side question: grounded in this lesson's approved material; canned answers offline."""
    low = q.lower()
    canned = c.content.get("side_answers", {})
    if llm.available():
        r = await grounded_answer(db, [c.lesson.course_id], q, persona=c.avatar.name, max_sentences=3)
        if r["engine"] == "claude":
            return r
    key = "deep" if "deep" in low else "example" if re.search(r"example|real|mauritius", low) else "overfit" if "overfit" in low else "label" if "label" in low else "none"
    return {"answer": canned.get(key, canned.get("none", "")), "citations": [], "grounded": key != "none", "engine": "prepared"}
