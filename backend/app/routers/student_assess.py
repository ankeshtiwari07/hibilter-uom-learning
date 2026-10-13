"""Student portal: assignments (S07) and quizzes (S08). Scoring is server-side only; correct answers never leave the
server before the student's attempt is submitted."""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.audit import audit
from ..core.config import get_settings
from ..core.db import get_db
from ..core.deps import require
from ..models import Assessment, Course, Submission, User
from ._student_util import DONE_SUB, GRADED, LOCKED, enrolled_ids, iso, now, staff_names, sync_progress

router = APIRouter(prefix="/api/student", tags=["student"])
student = require("student")

MAX_BYTES = 20 * 1024 * 1024
ALLOWED = {".pdf", ".docx", ".ipynb", ".zip", ".txt"}
GRACE = timedelta(seconds=20)


async def _assessment(db: AsyncSession, user: User, aid: str, types: tuple[str, ...]) -> tuple[Assessment, Course]:
    a = await db.get(Assessment, aid)
    if not a or a.status != "published" or a.type not in types:
        raise HTTPException(404, "Not found")
    if a.course_id not in await enrolled_ids(db, user):
        raise HTTPException(403, "You're not enrolled in this course.")
    return a, await db.get(Course, a.course_id)


async def _subs(db: AsyncSession, user: User, aid: str) -> list[Submission]:
    return list((await db.execute(select(Submission).where(Submission.assessment_id == aid, Submission.user_id == user.id)
                                  .order_by(Submission.attempt))).scalars())


def _ans(s: Submission | None) -> dict:
    return dict(s.answers) if s and isinstance(s.answers, dict) else {}


# =============================== assignments ===============================
def _assign_state(a: Assessment, s: Submission | None) -> dict:
    t = now()
    allow_late = (a.settings or {}).get("allow_late", True)
    closed = bool(a.due and t > a.due)
    submitted = bool(s and s.status in DONE_SUB)
    graded = bool(s and s.status in GRADED)
    locked = bool(s and s.status in LOCKED)
    if graded:
        status = "graded"
    elif submitted:
        status = "late" if s.late else "submitted"
    elif closed:
        status = "overdue"
    elif s and (s.text or _ans(s).get("draft")):
        status = "draft"
    else:
        status = "not_submitted"
    can = not locked and ((not closed) or (allow_late and not submitted))
    return {"status": status, "can_submit": can, "closed": closed, "late_window": closed and can}


def _assign_row(a: Assessment, c: Course, s: Submission | None) -> dict:
    st = _assign_state(a, s)
    return {"id": a.id, "title": a.title, "type": a.type, "course_id": c.id, "course_code": c.code, "course_title": c.title,
            "due": iso(a.due), "weight": a.weight, "max": a.max_score, **st,
            "score": s.score if s and s.status in GRADED else None, "submitted_at": iso(s.submitted_at) if s else None}


@router.get("/assignments")
async def assignments(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    rows = list((await db.execute(select(Assessment).where(Assessment.course_id.in_(cids or ["-"]), Assessment.status == "published",
                                                           Assessment.type.in_(["assignment", "lab"])))).scalars())
    subs = {}
    if rows:
        for s in (await db.execute(select(Submission).where(Submission.user_id == user.id, Submission.assessment_id.in_([a.id for a in rows]))
                                   .order_by(Submission.attempt))).scalars():
            subs[s.assessment_id] = s
    out = [_assign_row(a, courses[a.course_id], subs.get(a.id)) for a in rows]
    out.sort(key=lambda r: (r["status"] in ("graded",), r["due"] is None, r["due"] or ""))
    return out


@router.get("/assignments/{aid}")
async def assignment(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, c = await _assessment(db, user, aid, ("assignment", "lab"))
    subs = await _subs(db, user, aid)
    s = subs[-1] if subs else None
    ans = _ans(s)
    show_fb = bool(s and s.status in GRADED)
    marker = (await staff_names(db, [s.graded_by])).get(s.graded_by) if show_fb and s.graded_by else None
    lec = (await staff_names(db, [c.lecturer_id])).get(c.lecturer_id)
    history = list(ans.get("history") or [])
    return {**_assign_row(a, c, s), "instructions": a.instructions, "rubric": a.rubric or [], "settings": {
                "allowed": sorted(ALLOWED), "max_mb": MAX_BYTES // (1024 * 1024), "allow_late": (a.settings or {}).get("allow_late", True)},
            "opened": iso(a.created_at), "lecturer": lec.name if lec else None,
            "submission": None if not s else {
                "status": s.status, "text": s.text if s.status != "draft" else None, "draft": ans.get("draft") if s.status == "draft" else ans.get("draft"),
                "file_name": s.file_name, "has_file": bool(s.file_url and ans.get("path")), "submitted_at": iso(s.submitted_at), "late": s.late,
                "receipt": ans.get("receipt"), "words": ans.get("words")},
            "history": history,
            "feedback": {"score": s.score, "max": a.max_score, "text": s.feedback, "by": marker.name if marker else (lec.name if lec else "Course lecturer"),
                         "status": s.status} if show_fb else None}


class DraftIn(BaseModel):
    text: str = Field(default="", max_length=60000)


async def _get_or_create(db: AsyncSession, user: User, a: Assessment) -> Submission:
    subs = await _subs(db, user, a.id)
    if subs:
        return subs[-1]
    s = Submission(assessment_id=a.id, user_id=user.id, attempt=1, answers={}, status="draft")
    db.add(s)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        s = (await _subs(db, user, a.id))[-1]
    return s


@router.put("/assignments/{aid}/draft")
async def assignment_draft(aid: str, body: DraftIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, _ = await _assessment(db, user, aid, ("assignment", "lab"))
    s = await _get_or_create(db, user, a)
    if s.status in LOCKED:
        raise HTTPException(409, "This assignment is being marked; it can’t be changed.")
    s.answers = {**_ans(s), "draft": body.text, "draft_at": iso(now())}
    await db.commit()
    return {"ok": True, "at": s.answers["draft_at"]}


def _safe_name(name: str) -> str:
    base = os.path.basename(name or "file").strip()
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .") or "file"
    stem, ext = os.path.splitext(base)
    return f"{stem[:80]}{ext.lower()[:10]}"


def _sniff_ok(ext: str, head: bytes) -> bool:
    if ext == ".pdf":
        return head.startswith(b"%PDF")
    if ext in (".docx", ".zip"):
        return head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06")
    if ext == ".ipynb":
        return head.lstrip()[:1] == b"{"
    if ext == ".txt":
        if b"\x00" in head:
            return False
        try:
            head.decode("utf-8")
        except UnicodeDecodeError as e:  # tolerate a multi-byte char cut at the sniff boundary
            return e.start >= len(head) - 4
        return True
    return False


@router.post("/assignments/{aid}/submit")
async def assignment_submit(aid: str, declaration: bool = Form(False), text: str = Form(default="", max_length=60000),
                            idem: str = Form(default="", max_length=64), file: UploadFile | None = File(default=None),
                            db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, c = await _assessment(db, user, aid, ("assignment", "lab"))
    s = await _get_or_create(db, user, a)
    ans = _ans(s)
    if idem and ans.get("idem") == idem and s.status in DONE_SUB:  # replayed request → same receipt
        return {"receipt": ans.get("receipt"), "submitted_at": iso(s.submitted_at), "late": s.late, "duplicate": True}
    st = _assign_state(a, s)
    if not st["can_submit"]:
        raise HTTPException(409, "This assignment is being marked; it can’t be changed." if s.status in LOCKED else "The deadline has passed; resubmission is closed.")
    if not declaration:
        raise HTTPException(422, "Tick the declaration to confirm the work is your own.")
    text = (text or "").strip()
    stored = None
    if file is not None and file.filename:
        name = _safe_name(file.filename)
        ext = os.path.splitext(name)[1]
        if ext not in ALLOWED:
            raise HTTPException(422, "That file type isn’t accepted. Upload a PDF, DOCX, IPYNB, ZIP or TXT file.")
        root = Path(get_settings().media_dir) / "uploads" / user.id
        root.mkdir(parents=True, exist_ok=True)
        dest = root / f"{uuid.uuid4().hex}-{name}"
        size, head, h = 0, b"", hashlib.sha256()
        try:
            with open(dest, "wb") as out:
                while chunk := await file.read(1024 * 256):
                    if not head:
                        head = chunk[:2048]
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "That file is larger than 20 MB.")
                    h.update(chunk)
                    out.write(chunk)
            if size == 0:
                raise HTTPException(422, "That file is empty.")
            if not _sniff_ok(ext, head):
                raise HTTPException(422, f"The file doesn’t look like a valid {ext[1:].upper()} file.")
        except HTTPException:
            dest.unlink(missing_ok=True)
            raise
        stored = {"path": str(dest), "name": name, "size": size, "sha256": h.hexdigest()}
    if not stored and not text and not s.file_url:
        raise HTTPException(422, "Choose a file to submit, or write your answer in the text box.")
    t = now()
    receipt = "RCPT-" + hashlib.sha256(f"{s.id}:{t.isoformat()}:{user.id}".encode()).hexdigest()[:8].upper()
    hist = list(ans.get("history") or [])
    hist.insert(0, {"at": iso(t), "file": stored["name"] if stored else s.file_name, "receipt": receipt, "late": bool(a.due and t > a.due),
                    "size": stored["size"] if stored else None, "text": bool(text)})
    if stored:
        old = ans.get("path")
        s.file_name, s.file_url = stored["name"], f"/api/student/assignments/{a.id}/file"
        ans.update(path=stored["path"], size=stored["size"], sha256=stored["sha256"])
        if old and old != stored["path"]:
            ans.setdefault("replaced", []).append(old)  # keep previous files for the record
    s.text = text or None
    s.submitted_at, s.late, s.status = t, bool(a.due and t > a.due), "submitted"
    s.answers = {**ans, "receipt": receipt, "history": hist[:20], "declaration": True, "idem": idem or None,
                 "words": len(text.split()) if text else ans.get("words"), "draft": None}
    await db.flush()
    await sync_progress(db, user, a.course_id)
    await audit(db, user, "Submitted assignment", "data", f"{c.code} · {a.title}", detail={"receipt": receipt, "late": s.late,
                                                                                            "file": s.file_name, "sha256": ans.get("sha256")})
    await db.commit()
    return {"receipt": receipt, "submitted_at": iso(t), "late": s.late, "duplicate": False}


@router.get("/assignments/{aid}/file")
async def assignment_file(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, _ = await _assessment(db, user, aid, ("assignment", "lab"))
    subs = await _subs(db, user, aid)
    path = _ans(subs[-1]).get("path") if subs else None
    root = (Path(get_settings().media_dir) / "uploads" / user.id).resolve()
    if not path or not Path(path).resolve().is_relative_to(root) or not Path(path).exists():
        raise HTTPException(404, "No file on record")
    return FileResponse(path, filename=subs[-1].file_name or "submission", headers={"Cache-Control": "no-store"})


# =============================== quizzes ===============================
def _settings(a: Assessment) -> dict:
    st = a.settings or {}
    return {"time_limit": st.get("time_limit"), "attempts": int(st.get("attempts") or 1), "review": st.get("review", True),
            "shuffle": False}


def _deadline(a: Assessment, s: Submission) -> datetime | None:
    ans = _ans(s)
    started = datetime.fromisoformat(ans["started_at"]) if ans.get("started_at") else s.created_at
    lim = _settings(a)["time_limit"]
    d = started + timedelta(minutes=int(lim)) if lim else None
    if a.due and (d is None or a.due < d):
        d = a.due
    return d


def _public_questions(a: Assessment) -> list[dict]:
    return [{"i": i, "q": q.get("q", ""), "o": list(q.get("o", []))} for i, q in enumerate(a.questions or [])]


def _sel(raw: dict, n: int, opts: list[int]) -> dict[str, int]:
    out = {}
    for k, v in (raw or {}).items():
        try:
            i, j = int(k), int(v)
        except (TypeError, ValueError):
            continue
        if 0 <= i < n and 0 <= j < opts[i]:
            out[str(i)] = j
    return out


def _score(a: Assessment, sel: dict[str, int]) -> tuple[list[bool], int, float]:
    res = [sel.get(str(i)) == q.get("a") for i, q in enumerate(a.questions or [])]
    correct = sum(res)
    return res, correct, round(correct / max(1, len(res)) * (a.max_score or len(res)), 2)


def _result(a: Assessment, s: Submission) -> dict:
    ans = _ans(s)
    if s.status not in GRADED:  # lecturer is re-marking: hide score until published
        return {"attempt": s.attempt, "score": None, "max": a.max_score, "correct": None, "total": len(a.questions or []), "pct": None,
                "submitted_at": iso(s.submitted_at), "late": s.late, "minutes": None, "auto": False, "status": "submitted"}
    sel = ans.get("sel") or {}
    res = ans.get("result") or _score(a, sel)[0]
    started = datetime.fromisoformat(ans["started_at"]) if ans.get("started_at") else s.created_at
    taken = round(((s.submitted_at or now()) - started).total_seconds() / 60, 1) if started else None
    out = {"attempt": s.attempt, "score": s.score, "max": a.max_score, "correct": sum(1 for r in res if r), "total": len(res),
           "pct": round(100 * sum(1 for r in res if r) / max(1, len(res))), "submitted_at": iso(s.submitted_at), "late": s.late,
           "minutes": taken, "auto": bool(ans.get("auto_submitted")), "status": s.status}
    if _settings(a)["review"]:
        out["review"] = [{"q": q.get("q"), "o": q.get("o"), "your": sel.get(str(i)), "a": q.get("a"), "ex": q.get("ex"), "ok": bool(res[i]) if i < len(res) else False}
                         for i, q in enumerate(a.questions or [])]
    return out


async def _finalize(db: AsyncSession, user: User, a: Assessment, s: Submission, auto: bool = False):
    ans = _ans(s)
    res, correct, score = _score(a, ans.get("sel") or {})
    t = now()
    dl = _deadline(a, s)
    s.submitted_at = min(t, dl + GRACE) if auto and dl else t
    s.late = bool(a.due and s.submitted_at > a.due + GRACE)
    s.score, s.status = score, "published"  # objective auto-score from the lecturer’s key is released immediately
    s.answers = {**ans, "result": res, "correct": correct, "auto_submitted": auto}
    await db.flush()
    await sync_progress(db, user, a.course_id)


async def _expire_if_needed(db: AsyncSession, user: User, a: Assessment, subs: list[Submission]) -> bool:
    d = next((s for s in subs if s.status == "draft"), None)
    if d is not None:
        dl = _deadline(a, d)
        if dl and now() > dl + GRACE:
            await _finalize(db, user, a, d, auto=True)
            await db.commit()
            return True
    return False


def _quiz_summary(a: Assessment, c: Course, subs: list[Submission]) -> dict:
    st = _settings(a)
    done = [s for s in subs if s.status in DONE_SUB]
    draft = next((s for s in subs if s.status == "draft"), None)
    best = max([s for s in done if s.status in GRADED], key=lambda s: s.score or 0, default=None)
    closed = bool(a.due and now() > a.due)
    return {"id": a.id, "title": a.title, "course_id": c.id, "course_code": c.code, "course_title": c.title, "due": iso(a.due),
            "weight": a.weight, "max": a.max_score, "questions": len(a.questions or []), "time_limit": st["time_limit"],
            "attempts_allowed": st["attempts"], "attempts_used": len(done), "in_progress": draft is not None, "closed": closed,
            "best": {"score": best.score, "pct": round(100 * (best.score or 0) / (a.max_score or 1))} if best else None,
            "can_start": (draft is not None) or (not closed and len(done) < st["attempts"] and len(a.questions or []) > 0),
            "status": "in_progress" if draft else "completed" if done else "closed" if closed else "open"}


@router.get("/quizzes")
async def quizzes(db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    cids = await enrolled_ids(db, user)
    courses = {c.id: c for c in (await db.execute(select(Course).where(Course.id.in_(cids or ["-"])))).scalars()}
    rows = list((await db.execute(select(Assessment).where(Assessment.course_id.in_(cids or ["-"]), Assessment.status == "published",
                                                           Assessment.type == "quiz"))).scalars())
    subs: dict[str, list[Submission]] = {}
    if rows:
        for s in (await db.execute(select(Submission).where(Submission.user_id == user.id, Submission.assessment_id.in_([a.id for a in rows]))
                                   .order_by(Submission.attempt))).scalars():
            subs.setdefault(s.assessment_id, []).append(s)
    out = [_quiz_summary(a, courses[a.course_id], subs.get(a.id, [])) for a in rows]
    out.sort(key=lambda r: (r["status"] in ("completed", "closed"), r["due"] is None, r["due"] or ""))
    return out


@router.get("/quizzes/{aid}")
async def quiz(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, c = await _assessment(db, user, aid, ("quiz",))
    subs = await _subs(db, user, aid)
    if await _expire_if_needed(db, user, a, subs):
        subs = await _subs(db, user, aid)
    draft = next((s for s in subs if s.status == "draft"), None)
    out = {**_quiz_summary(a, c, subs), "instructions": a.instructions,
           "results": [_result(a, s) for s in subs if s.status in DONE_SUB], "attempt": None}
    if draft:
        ans = _ans(draft)
        dl = _deadline(a, draft)
        out["attempt"] = {"n": draft.attempt, "questions": _public_questions(a), "answers": ans.get("sel") or {}, "flags": ans.get("flags") or [],
                          "deadline": iso(dl), "remaining": max(0, int((dl - now()).total_seconds())) if dl else None, "saved_at": ans.get("saved_at")}
    return out


@router.post("/quizzes/{aid}/start")
async def quiz_start(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, c = await _assessment(db, user, aid, ("quiz",))
    subs = await _subs(db, user, aid)
    await _expire_if_needed(db, user, a, subs)
    subs = await _subs(db, user, aid)
    if not any(s.status == "draft" for s in subs):
        st = _settings(a)
        if not a.questions:
            raise HTTPException(409, "This quiz has no questions yet.")
        if a.due and now() > a.due:
            raise HTTPException(409, "This quiz has closed.")
        if sum(1 for s in subs if s.status in DONE_SUB) >= st["attempts"]:
            raise HTTPException(409, f"You’ve used all {st['attempts']} attempt(s) for this quiz.")
        n = max([s.attempt for s in subs] or [0]) + 1
        db.add(Submission(assessment_id=a.id, user_id=user.id, attempt=n, status="draft",
                          answers={"sel": {}, "flags": [], "started_at": iso(now())}))
        try:
            await db.commit()
        except IntegrityError:  # double click / second tab: the other request created it
            await db.rollback()
    return await quiz(aid, db, user)


class QuizSaveIn(BaseModel):
    answers: dict[str, int] = Field(default_factory=dict)
    flags: list[int] = Field(default_factory=list, max_length=500)
    idem: str | None = Field(default=None, max_length=64)


async def _draft_for(db, user, a) -> Submission:
    d = next((s for s in await _subs(db, user, a.id) if s.status == "draft"), None)
    if not d:
        raise HTTPException(409, "No attempt in progress.")
    return d


@router.put("/quizzes/{aid}/draft")
async def quiz_save(aid: str, body: QuizSaveIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, _ = await _assessment(db, user, aid, ("quiz",))
    d = await _draft_for(db, user, a)
    dl = _deadline(a, d)
    if dl and now() > dl + GRACE:
        await _finalize(db, user, a, d, auto=True)
        await db.commit()
        raise HTTPException(409, "Time is up — your saved answers were submitted.")
    n = len(a.questions or [])
    opts = [len(q.get("o", [])) for q in a.questions or []]
    d.answers = {**_ans(d), "sel": _sel(body.answers, n, opts), "flags": sorted({f for f in body.flags if 0 <= f < n}), "saved_at": iso(now())}
    await db.commit()
    return {"ok": True, "saved_at": d.answers["saved_at"]}


@router.post("/quizzes/{aid}/submit")
async def quiz_submit(aid: str, body: QuizSaveIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    a, c = await _assessment(db, user, aid, ("quiz",))
    subs = await _subs(db, user, aid)
    if body.idem:
        prev = next((s for s in subs if s.status in DONE_SUB and _ans(s).get("idem") == body.idem), None)
        if prev:  # replayed submit → same result
            return _result(a, prev)
    d = next((s for s in subs if s.status == "draft"), None)
    if not d:
        last = next((s for s in reversed(subs) if s.status in DONE_SUB), None)
        if last:
            return _result(a, last)
        raise HTTPException(409, "No attempt in progress.")
    dl = _deadline(a, d)
    expired = bool(dl and now() > dl + GRACE)
    if not expired:  # answers in the submit body are the final state; after time-out only autosaved answers count
        n = len(a.questions or [])
        opts = [len(q.get("o", [])) for q in a.questions or []]
        d.answers = {**_ans(d), "sel": _sel(body.answers, n, opts), "flags": sorted({f for f in body.flags if 0 <= f < n})}
    d.answers = {**_ans(d), "idem": body.idem}
    await _finalize(db, user, a, d, auto=expired)
    await audit(db, user, "Submitted quiz", "grade", f"{c.code} · {a.title} (attempt {d.attempt})",
                detail={"score": d.score, "max": a.max_score, "auto_scored": True, "late": d.late})
    await db.commit()
    return _result(a, d)


@router.post("/quizzes/{aid}/practice")
async def quiz_practice(aid: str, body: QuizSaveIn, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Practice retake: scored but never recorded. Only after a recorded attempt, and only when review is allowed."""
    a, _ = await _assessment(db, user, aid, ("quiz",))
    subs = await _subs(db, user, aid)
    if not any(s.status in DONE_SUB for s in subs) or not _settings(a)["review"]:
        raise HTTPException(409, "Practice opens after your first submitted attempt, when your lecturer allows review.")
    n = len(a.questions or [])
    sel = _sel(body.answers, n, [len(q.get("o", [])) for q in a.questions or []])
    res, correct, score = _score(a, sel)
    return {"practice": True, "correct": correct, "total": n, "pct": round(100 * correct / max(1, n)), "score": score, "max": a.max_score,
            "review": [{"q": q.get("q"), "o": q.get("o"), "your": sel.get(str(i)), "a": q.get("a"), "ex": q.get("ex"), "ok": res[i]}
                       for i, q in enumerate(a.questions or [])]}


@router.get("/quizzes/{aid}/questions")
async def quiz_questions(aid: str, db: AsyncSession = Depends(get_db), user: User = Depends(student)):
    """Question text only (no answers) for a practice retake after a submitted attempt."""
    a, _ = await _assessment(db, user, aid, ("quiz",))
    if not any(s.status in DONE_SUB for s in await _subs(db, user, aid)):
        raise HTTPException(409, "Start the quiz to see its questions.")
    return _public_questions(a)
