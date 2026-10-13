"""Queue every line a lecturer can say in a lesson for rendering.
Usage: python -m app.services.render_enqueue --lesson L1 [--avatar henri] [--course-learners] [--names Sagar,Aisha]"""
from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select

from ..classroom import lines as L
from ..core.db import SessionLocal
from ..models import Avatar, Enrolment, Lesson, MediaClip, User


async def enqueue(lesson_id: str, avatar_ids: list[str] | None, names: list[str]) -> dict:
    async with SessionLocal() as db:
        lesson = await db.get(Lesson, lesson_id)
        if not names:
            names = list((await db.execute(select(User.first).join(Enrolment, Enrolment.user_id == User.id)
                                           .where(Enrolment.course_id == lesson.course_id))).scalars())
        ids = avatar_ids or lesson.avatars
        added = 0
        for aid in ids:
            av = await db.get(Avatar, aid)
            adict = {"id": av.id, "name": av.name, "teach": av.teach}
            have = set((await db.execute(select(MediaClip.hash).where(MediaClip.avatar_id == aid))).scalars())
            for text in L.inventory(lesson.content, adict, sorted(set(names))):
                h = L.line_hash(aid, text)
                if h not in have:
                    db.add(MediaClip(hash=h, avatar_id=aid, text=text, status="pending"))
                    have.add(h)
                    added += 1
        await db.commit()
        return {"lesson": lesson_id, "avatars": ids, "names": len(set(names)), "queued": added}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lesson", default="L1")
    ap.add_argument("--avatar", action="append")
    ap.add_argument("--names", default="")
    a = ap.parse_args()
    print(asyncio.run(enqueue(a.lesson, a.avatar, [n for n in a.names.split(",") if n])))
