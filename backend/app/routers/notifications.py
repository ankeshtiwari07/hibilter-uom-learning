"""Per-user notification feed derived from announcements, due dates and published grades."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.db import get_db
from ..core.deps import current_user
from ..models import Announcement, AnnouncementRead, Assessment, Course, Enrolment, Submission, User

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


async def my_course_ids(db: AsyncSession, user: User) -> list[str]:
    if user.role == "student":
        return list((await db.execute(select(Enrolment.course_id).where(Enrolment.user_id == user.id))).scalars())
    if user.role == "lecturer":
        return list((await db.execute(select(Course.id).where(Course.lecturer_id == user.id))).scalars())
    return list((await db.execute(select(Course.id))).scalars())


@router.get("")
async def feed(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    cids = await my_course_ids(db, user)
    read = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    anns = (await db.execute(select(Announcement).where(Announcement.status == "published", or_(Announcement.scope == "university",
            Announcement.course_id.in_(cids), and_(Announcement.scope == "faculty", Announcement.faculty_id == user.faculty_id)))
            .order_by(Announcement.publish_at.desc()).limit(10))).scalars()
    out = [{"id": a.id, "kind": "news", "title": a.title, "body": a.body[:140], "at": (a.publish_at or a.created_at).isoformat(),
            "unread": a.id not in read, "link": "/s-news" if user.role == "student" else None} for a in anns]
    if user.role == "student":
        now = datetime.now(timezone.utc)
        due = (await db.execute(select(Assessment).where(Assessment.course_id.in_(cids), Assessment.due >= now, Assessment.due <= now + timedelta(days=4)))).scalars()
        for a in due:
            out.append({"id": f"due-{a.id}", "kind": "due", "title": f"Due soon: {a.title}", "body": f"Due {a.due:%a %d %b, %H:%M}", "at": now.isoformat(), "unread": True,
                        "link": "/s-quiz" if a.type == "quiz" else "/s-assign"})
        graded = (await db.execute(select(Submission, Assessment).join(Assessment).where(Submission.user_id == user.id, Submission.status.in_(["graded", "published"])).limit(3))).all()
        for sb, a in graded:
            out.append({"id": f"gr-{sb.id}", "kind": "grade", "title": f"Feedback available: {a.title}", "body": f"Score {sb.score:g}/{a.max_score}" if sb.score is not None else "Feedback posted",
                        "at": (sb.submitted_at or sb.created_at).isoformat(), "unread": False, "link": "/s-progress"})
    return sorted(out, key=lambda x: x["at"], reverse=True)


@router.post("/read-all")
async def read_all(db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    cids = await my_course_ids(db, user)
    anns = (await db.execute(select(Announcement.id).where(or_(Announcement.scope == "university", Announcement.course_id.in_(cids))))).scalars()
    have = set((await db.execute(select(AnnouncementRead.announcement_id).where(AnnouncementRead.user_id == user.id))).scalars())
    for aid in anns:
        if aid not in have:
            db.add(AnnouncementRead(announcement_id=aid, user_id=user.id))
    await db.commit()
    return {"ok": True}
