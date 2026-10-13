"""Relational model for the UoM Learning platform (see LLD §6.6)."""
from __future__ import annotations

import uuid
from datetime import datetime, date

from sqlalchemy import (
    JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .core.db import Base


def uid() -> str:
    return uuid.uuid4().hex


class TS:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---------- Academic structure ----------
class Faculty(Base):
    __tablename__ = "faculties"
    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    short: Mapped[str] = mapped_column(String(64))


class Programme(Base):
    __tablename__ = "programmes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    faculty_id: Mapped[str] = mapped_column(ForeignKey("faculties.id"))
    name: Mapped[str] = mapped_column(String(200))
    level: Mapped[str] = mapped_column(String(64))
    years: Mapped[int] = mapped_column(Integer, default=3)


class User(TS, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(16), index=True)  # student | lecturer | admin
    name: Mapped[str] = mapped_column(String(200))
    first: Mapped[str] = mapped_column(String(80))
    title: Mapped[str | None] = mapped_column(String(200))
    faculty_id: Mapped[str | None] = mapped_column(ForeignKey("faculties.id"))
    programme_id: Mapped[str | None] = mapped_column(ForeignKey("programmes.id"))
    student_no: Mapped[str | None] = mapped_column(String(32))
    year: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | suspended
    prefs: Mapped[dict] = mapped_column(JSON, default=dict)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    risk: Mapped[dict] = mapped_column(JSON, default=dict)  # cached at-risk signals


class Course(TS, Base):
    __tablename__ = "courses"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    faculty_id: Mapped[str] = mapped_column(ForeignKey("faculties.id"))
    programme_id: Mapped[str | None] = mapped_column(ForeignKey("programmes.id"))
    lecturer_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    term: Mapped[str] = mapped_column(String(32), default="Semester 1 2026/27")
    credits: Mapped[int] = mapped_column(Integer, default=3)
    description: Mapped[str] = mapped_column(Text, default="")
    cover: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="published")
    vf_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)


class Enrolment(TS, Base):
    __tablename__ = "enrolments"
    __table_args__ = (UniqueConstraint("user_id", "course_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="active")


class Module(Base):
    __tablename__ = "modules"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    ord: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    items: Mapped[list] = mapped_column(JSON, default=list)  # [{id,type,title,dur,lesson_id?}]


# ---------- Virtual faculty lessons ----------
class Lesson(TS, Base):
    __tablename__ = "lessons"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    module: Mapped[str] = mapped_column(String(200), default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="published")  # draft | published
    content: Mapped[dict] = mapped_column(JSON)  # LessonContent schema
    policy: Mapped[dict] = mapped_column(JSON, default=dict)  # {threshold, hints, assisted}
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    avatars: Mapped[list] = mapped_column(JSON, default=list)


class LessonVersion(TS, Base):
    __tablename__ = "lesson_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    content: Mapped[dict] = mapped_column(JSON)
    policy: Mapped[dict] = mapped_column(JSON)
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))


class Avatar(Base):
    __tablename__ = "avatars"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    short: Mapped[str] = mapped_column(String(80))
    subject: Mapped[str] = mapped_column(String(200))
    teach: Mapped[str] = mapped_column(String(300))
    gender: Mapped[str] = mapped_column(String(16))
    voice: Mapped[str] = mapped_column(String(200))
    voice_id: Mapped[str] = mapped_column(String(64))
    style: Mapped[str] = mapped_column(String(300))
    portrait: Mapped[str] = mapped_column(String(200))
    listen_portrait: Mapped[str | None] = mapped_column(String(200))
    calib: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="active")


class MediaClip(TS, Base):
    """One rendered spoken line for one avatar (audio and optionally full-body video)."""
    __tablename__ = "media_clips"
    hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    avatar_id: Mapped[str] = mapped_column(ForeignKey("avatars.id"), index=True)
    text: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16), default="speech")  # speech | transition | idle
    audio_url: Mapped[str | None] = mapped_column(String(400))
    duration: Mapped[float | None] = mapped_column(Float)
    envelope: Mapped[str | None] = mapped_column(Text)  # base64 loudness envelope @50fps (Tier C lip)
    video_url: Mapped[str | None] = mapped_column(String(400))
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|audio|rendering|ready|failed|review
    engine: Mapped[str | None] = mapped_column(String(64))
    qc: Mapped[dict] = mapped_column(JSON, default=dict)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)


class VFSession(TS, Base):
    __tablename__ = "vf_sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    lesson_id: Mapped[str] = mapped_column(ForeignKey("lessons.id"), index=True)
    lesson_version: Mapped[int] = mapped_column(Integer)
    avatar_id: Mapped[str] = mapped_column(ForeignKey("avatars.id"))
    state: Mapped[str] = mapped_column(String(32), default="IDLE")
    resume_state: Mapped[str | None] = mapped_column(String(32))
    seg: Mapped[int] = mapped_column(Integer, default=0)
    sent: Mapped[int] = mapped_column(Integer, default=0)
    turn: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)
    mode: Mapped[str] = mapped_column(String(16), default="")
    hints: Mapped[dict] = mapped_column(JSON, default=dict)
    outcome: Mapped[dict] = mapped_column(JSON, default=dict)
    trace: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(24), default="active")  # active|saved|completed|saved-after-error
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class VFAttempt(TS, Base):
    __tablename__ = "vf_attempts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("vf_sessions.id"), index=True)
    checkpoint_id: Mapped[str] = mapped_column(String(32), index=True)
    n: Mapped[int] = mapped_column(Integer)
    answer: Mapped[str] = mapped_column(Text)
    verdict: Mapped[str] = mapped_column(String(16))
    found: Mapped[list] = mapped_column(JSON, default=list)
    missing: Mapped[list] = mapped_column(JSON, default=list)
    mis: Mapped[list] = mapped_column(JSON, default=list)
    engine: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[str] = mapped_column(String(8), default="high")
    ai_feedback: Mapped[str | None] = mapped_column(Text)
    hints_before: Mapped[int] = mapped_column(Integer, default=0)
    eval_log_id: Mapped[int | None] = mapped_column(ForeignKey("eval_logs.id"))
    idempotency_key: Mapped[str | None] = mapped_column(String(64), unique=True)


class EvalLog(TS, Base):
    __tablename__ = "eval_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16), default="checkpoint")  # checkpoint | assistant
    model: Mapped[str] = mapped_column(String(64))
    prompt_hash: Mapped[str] = mapped_column(String(64))
    latency_ms: Mapped[int] = mapped_column(Integer)
    ok: Mapped[bool] = mapped_column(Boolean)
    raw: Mapped[dict] = mapped_column(JSON, default=dict)
    policy_version: Mapped[str] = mapped_column(String(32), default="v1")
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)


class ReviewItem(TS, Base):
    __tablename__ = "review_items"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(16))  # assisted | low_conf | flagged
    session_id: Mapped[str] = mapped_column(ForeignKey("vf_sessions.id"))
    checkpoint_id: Mapped[str] = mapped_column(String(32))
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    student_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | resolved
    note: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(32), index=True)
    session_id: Mapped[str | None] = mapped_column(String(32), index=True)
    course_id: Mapped[str | None] = mapped_column(String(32), index=True)
    type: Mapped[str] = mapped_column(String(32), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


# ---------- Assessments ----------
class Assessment(TS, Base):
    __tablename__ = "assessments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    type: Mapped[str] = mapped_column(String(24))  # quiz | assignment | exam | lab
    due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    weight: Mapped[int] = mapped_column(Integer, default=10)
    max_score: Mapped[int] = mapped_column(Integer, default=100)
    status: Mapped[str] = mapped_column(String(16), default="published")
    instructions: Mapped[str] = mapped_column(Text, default="")
    questions: Mapped[list] = mapped_column(JSON, default=list)  # quiz items
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    rubric: Mapped[list] = mapped_column(JSON, default=list)


class Submission(TS, Base):
    __tablename__ = "submissions"
    __table_args__ = (UniqueConstraint("assessment_id", "user_id", "attempt"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    assessment_id: Mapped[str] = mapped_column(ForeignKey("assessments.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    answers: Mapped[dict] = mapped_column(JSON, default=dict)
    text: Mapped[str | None] = mapped_column(Text)
    file_name: Mapped[str | None] = mapped_column(String(300))
    file_url: Mapped[str | None] = mapped_column(String(400))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    late: Mapped[bool] = mapped_column(Boolean, default=False)
    score: Mapped[float | None] = mapped_column(Float)
    feedback: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|submitted|graded|published
    graded_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))


# ---------- Communication / calendar / support ----------
class Announcement(TS, Base):
    __tablename__ = "announcements"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    scope: Mapped[str] = mapped_column(String(16))  # university | course | faculty
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"))
    faculty_id: Mapped[str | None] = mapped_column(ForeignKey("faculties.id"))
    author_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="published")


class AnnouncementRead(Base):
    __tablename__ = "announcement_reads"
    announcement_id: Mapped[str] = mapped_column(ForeignKey("announcements.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)


class Thread(TS, Base):
    __tablename__ = "threads"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"))
    subject: Mapped[str] = mapped_column(String(300))
    participants: Mapped[list] = mapped_column(JSON, default=list)


class Message(TS, Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    thread_id: Mapped[str] = mapped_column(ForeignKey("threads.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    body: Mapped[str] = mapped_column(Text)


class CalendarEvent(TS, Base):
    __tablename__ = "calendar_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    kind: Mapped[str] = mapped_column(String(16))  # cls | due | exam | uni | vf
    title: Mapped[str] = mapped_column(String(300))
    start: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"))
    location: Mapped[str | None] = mapped_column(String(200))


class SupportTicket(TS, Base):
    __tablename__ = "support_tickets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    category: Mapped[str] = mapped_column(String(64))
    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="open")
    updates: Mapped[list] = mapped_column(JSON, default=list)


class FAQ(Base):
    __tablename__ = "faq"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    q: Mapped[str] = mapped_column(Text)
    a: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(64), default="General")


# ---------- AI assistant ----------
class Source(TS, Base):
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=uid)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    kind: Mapped[str] = mapped_column(String(32), default="reading")
    uri: Mapped[str | None] = mapped_column(String(400))
    approved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    approved: Mapped[bool] = mapped_column(Boolean, default=True)


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"), index=True)
    course_id: Mapped[str] = mapped_column(String(32), index=True)
    page: Mapped[int | None] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)


class AssistantTurn(TS, Base):
    __tablename__ = "assistant_turns"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    course_id: Mapped[str | None] = mapped_column(String(32))
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    citations: Mapped[list] = mapped_column(JSON, default=list)
    grounded: Mapped[bool] = mapped_column(Boolean, default=True)
    engine: Mapped[str] = mapped_column(String(16))
    rating: Mapped[int | None] = mapped_column(Integer)


# ---------- Governance ----------
class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(32))
    actor_name: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))  # content | grade | access | export | system | auth | data
    obj: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class AcademicTerm(Base):
    __tablename__ = "academic_terms"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    start: Mapped[date] = mapped_column(Date)
    end: Mapped[date] = mapped_column(Date)
    current: Mapped[bool] = mapped_column(Boolean, default=False)
