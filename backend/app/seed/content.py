"""Course content sync: loads backend/app/seed/curriculum/<course>.json (docs/curriculum-schema.md) into the database.

Idempotent and safe to re-run on a live system: modules are rewritten as the table of contents, video/reading content is
upserted into LearningItem, the virtual lesson into Lesson (new version + LessonVersion on change), quizzes/assignments into
Assessment (due dates are only set when created), and every reading/transcript becomes approved study-assistant material.
Every spoken line is queued for rendering with the course's virtual lecturer. Learner progress is keyed by item id and kept.
Run: python -m app.seed.content [c2 c3 ...]"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, select

from ..classroom import lines as L
from ..core.db import SessionLocal
from ..models import (Assessment, Avatar, Chunk, Course, Enrolment, LearningItem, Lesson, LessonVersion, MediaClip, Module, Source,
                      User)

DIR = Path(__file__).parent / "curriculum"
MU = timezone(timedelta(hours=4))
POLICY = {"threshold": "required", "hints": True, "assisted": True, "simpler": True}
KEEP_FROM_EXISTING = ("side_answers",)  # hand-written extras on existing lessons (e.g. L1) that files don't carry


def digest(o) -> str:
    return hashlib.sha256(json.dumps(o, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def chapters_transcript(chapters: list[dict]) -> str:
    return "\n".join(f"{c['title']}. " + " ".join(c["narration"]) for c in chapters)


def reading_sections(body: str) -> list[str]:
    """Split markdown into ~section chunks for retrieval."""
    out, cur = [], []
    for line in body.splitlines():
        if line.startswith("## ") and cur:
            out.append("\n".join(cur).strip()); cur = []
        cur.append(line)
    if cur:
        out.append("\n".join(cur).strip())
    return [x for x in out if x]


def lesson_content(item: dict, module_title: str, existing: dict | None) -> tuple[dict, dict]:
    les = copy.deepcopy(item["lesson"])
    calibration = {}
    concept_ask = {}
    for s in les["segments"]:
        cp = s["checkpoint"]
        calibration[cp["id"]] = cp.pop("calibration", [])
        for c in cp["concepts"]:
            if c.get("ask"):
                concept_ask[c["id"]] = c.pop("ask")
        cp.setdefault("ack", cp["model"])
    content = {"id": item["id"], "title": item["title"], "module": module_title, "dur": item["dur"], "objectives": item.get("objectives", []),
               "chips": item.get("chips", []), "summary": les.get("summary", []), "segments": les["segments"], "closing": les["closing"],
               "concept_ask": concept_ask, "side_answers": {}}
    for k in KEEP_FROM_EXISTING:
        if existing and existing.get(k) and not content.get(k):
            content[k] = existing[k]
    if existing and existing.get("concept_ask"):
        content["concept_ask"] = {**existing["concept_ask"], **concept_ask}
    if existing:  # keep hand-tuned acknowledgements
        old = {s["checkpoint"]["id"]: s["checkpoint"] for s in existing.get("segments", [])}
        for s in content["segments"]:
            o = old.get(s["checkpoint"]["id"])
            if o and o.get("ack") and s["checkpoint"]["ack"] == s["checkpoint"]["model"]:
                s["checkpoint"]["ack"] = o["ack"]
    return content, calibration


async def enqueue_lines(db, avatar_id: str, texts: list[str], want_video: bool = True) -> int:
    have = set((await db.execute(select(MediaClip.hash).where(MediaClip.avatar_id == avatar_id))).scalars())
    n = 0
    for t in dict.fromkeys(texts):
        t = " ".join(t.split())
        if not t:
            continue
        h = L.line_hash(avatar_id, t)
        if h in have:
            continue
        have.add(h)
        db.add(MediaClip(hash=h, avatar_id=avatar_id, text=t, kind="speech", status="pending", qc={"want_video": want_video}))
        n += 1
    return n


async def sync_course(db, path: Path) -> dict:
    data = json.loads(path.read_text())
    cid = data["course"]
    course = await db.get(Course, cid)
    if not course:
        return {"course": cid, "skipped": "no such course"}
    presenter = data["presenter"]
    av = await db.get(Avatar, presenter)
    if not av:
        raise SystemExit(f"{cid}: unknown presenter {presenter}")
    stats = {"course": cid, "items": 0, "updated": 0, "assessments": 0, "lines": 0}
    keep_mods = []
    today = datetime.now(MU).date()
    names = list((await db.execute(select(User.first).join(Enrolment, Enrolment.user_id == User.id)
                                   .where(Enrolment.course_id == cid))).scalars())
    names = sorted({n for n in names if n})
    for mi, m in enumerate(data["modules"]):
        mid = f"{cid}-{m['id']}"
        keep_mods.append(mid)
        toc = []
        for it in m["items"]:
            stats["items"] += 1
            typ = it["type"]
            entry = {"id": it["id"], "type": typ, "title": it["title"], "dur": it.get("dur")}
            if typ in ("video", "reading"):
                body = {k: it[k] for k in ("objectives", "chips", "chapters", "body") if k in it}
                dg = digest(body)
                li = await db.get(LearningItem, it["id"])
                if li is None:
                    li = LearningItem(id=it["id"], course_id=cid, module_id=mid, type=typ, title=it["title"], presenter=presenter,
                                      content=body, version=1, digest=dg, status="published")
                    db.add(li)
                    stats["updated"] += 1
                elif li.digest != dg or li.title != it["title"] or li.module_id != mid or li.presenter != presenter:
                    li.content, li.title, li.module_id, li.presenter, li.type = body, it["title"], mid, presenter, typ
                    if li.digest != dg:
                        li.version += 1
                    li.digest = dg
                    stats["updated"] += 1
                if typ == "video":
                    stats["lines"] += await enqueue_lines(db, presenter, [ln for c in it["chapters"] for ln in c["narration"]])
            elif typ == "virtual":
                entry["vf"] = True
                entry["lesson_id"] = it["id"]
                les = await db.get(Lesson, it["id"])
                content, calibration = lesson_content(it, m["title"], les.content if les else None)
                content["calibration"] = {**((les.content or {}).get("calibration", {}) if les else {}), **calibration}
                if les is None:
                    les = Lesson(id=it["id"], course_id=cid, title=it["title"], module=m["title"], version=1, status="published",
                                 content=content, policy=dict(POLICY), published_at=datetime.now(timezone.utc), avatars=[presenter])
                    db.add(les)
                    await db.flush()
                    db.add(LessonVersion(lesson_id=les.id, version=1, content=content, policy=les.policy, author_id=course.lecturer_id))
                    stats["updated"] += 1
                elif digest(les.content) != digest(content):
                    les.version += 1
                    les.content, les.title, les.module = content, it["title"], m["title"]
                    if presenter not in (les.avatars or []):
                        les.avatars = [presenter] + list(les.avatars or [])
                    db.add(LessonVersion(lesson_id=les.id, version=les.version, content=content, policy=les.policy, author_id=course.lecturer_id))
                    stats["updated"] += 1
                for aid in les.avatars or [presenter]:
                    a = await db.get(Avatar, aid)
                    # name-free lines only; a learner's personalised lines are queued when their session starts
                    texts = [x for x in L.inventory(content, {"id": a.id, "name": a.name, "teach": a.teach}, names)
                             if not any(f" {n}" in f" {x}" for n in names)]
                    stats["lines"] += await enqueue_lines(db, aid, texts)
            elif typ in ("quiz", "assignment"):
                if it.get("assessment"):
                    entry["assessment_id"] = it["assessment"]
                else:
                    aid = it["id"]
                    a = await db.get(Assessment, aid)
                    spec = it.get("quiz") or it.get("assignment") or {}
                    due = datetime.combine(today + timedelta(days=7 * (mi + 1) + (3 if typ == "assignment" else 0)),
                                           time(23, 59) if typ == "quiz" else time(17, 0), MU)
                    fields = dict(course_id=cid, title=it["title"], type=typ, weight=spec.get("weight", 10), status="published")
                    if typ == "quiz":
                        fields.update(questions=spec["questions"], max_score=len(spec["questions"]) * 2,
                                      settings={"time_limit": spec.get("time", it.get("dur", 15)), "attempts": 2, "review": True},
                                      instructions=f"{len(spec['questions'])} multiple-choice questions · {spec.get('time', 15)} minutes · 2 attempts, best counts.")
                    else:
                        fields.update(instructions=spec["brief"], rubric=spec["rubric"], max_score=spec.get("max", 100), settings={"allow_late": True})
                    if a is None:
                        db.add(Assessment(id=aid, due=due, **fields))
                    else:
                        for k, v in fields.items():
                            setattr(a, k, v)
                    entry["assessment_id"] = aid
                    stats["assessments"] += 1
            toc.append(entry)
        mod = await db.get(Module, mid)
        if mod is None:
            db.add(Module(id=mid, course_id=cid, ord=mi + 1, title=m["title"], items=toc))
        else:
            mod.ord, mod.title, mod.items = mi + 1, m["title"], toc
    await db.execute(delete(Module).where(Module.course_id == cid, Module.id.notin_(keep_mods)))
    # approved study-assistant material: one source per reading / lecture transcript
    for m in data["modules"]:
        for it in m["items"]:
            if it["type"] not in ("video", "reading"):
                continue
            sid = f"src-{it['id']}"[:32]
            src = await db.get(Source, sid)
            if src is None:
                src = Source(id=sid, course_id=cid, title=it["title"] if it["type"] == "reading" else f"Lecture transcript: {it['title']}",
                             kind="reading" if it["type"] == "reading" else "transcript", uri=f"/s-lesson?course={cid}&item={it['id']}",
                             approved=True, approved_by=course.lecturer_id)
                db.add(src)
                await db.flush()
            await db.execute(delete(Chunk).where(Chunk.source_id == sid))
            parts = reading_sections(it["body"]) if it["type"] == "reading" else [f"{c['title']}. " + " ".join(c["narration"]) for c in it["chapters"]]
            for i, p in enumerate(parts):
                db.add(Chunk(source_id=sid, course_id=cid, page=i + 1, text=p))
    meta = dict(course.meta or {})
    meta["presenter"] = presenter
    course.meta = meta
    return stats


async def run(only: list[str]):
    files = sorted(DIR.glob("*.json"))
    if only:
        files = [f for f in files if f.stem in only]
    out = []
    async with SessionLocal() as db:
        for f in files:
            out.append(await sync_course(db, f))
            await db.flush()
        await db.commit()
    for s in out:
        print(s)


if __name__ == "__main__":
    asyncio.run(run(sys.argv[1:]))
