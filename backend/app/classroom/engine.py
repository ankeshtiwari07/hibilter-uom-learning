"""Server-authoritative Virtual Faculty classroom engine.

The client plays whatever `say` lines a step returns, then reports back with the next action. Every action is
validated against the transition table and the checkpoint guard, versioned (optimistic concurrency) and logged
as an analytics event."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..evaluation.service import EvaluationFailed, evaluate
from ..models import Avatar, EvalLog, Event, Lesson, ReviewItem, User, VFAttempt, VFSession
from . import lines as L
from .fsm import LABEL, PAUSABLE, Blocked, can_advance, check


class Conflict(Exception):
    pass


def _now():
    return datetime.now(timezone.utc)


def avatar_dict(a: Avatar) -> dict:
    return {"id": a.id, "name": a.name, "short": a.short, "teach": a.teach, "subject": a.subject}


class Ctx:
    """Loaded state for one action."""

    def __init__(self, db: AsyncSession, s: VFSession, lesson: Lesson, avatar: Avatar, user: User, attempts: list[VFAttempt]):
        self.db, self.s, self.lesson, self.avatar, self.user = db, s, lesson, avatar, user
        self.content = lesson.content
        self.attempts = attempts
        self.say: list[dict] = []
        self.extra: dict = {}

    # helpers
    @property
    def name(self) -> str:
        return self.user.first

    @property
    def segs(self) -> list[dict]:
        return self.content["segments"]

    def seg(self) -> dict | None:
        return self.segs[self.s.seg] if self.s.seg < len(self.segs) else None

    def cp(self) -> dict | None:
        sg = self.seg()
        return sg.get("checkpoint") if sg else None

    def atts(self, cp_id: str) -> list[VFAttempt]:
        return [a for a in self.attempts if a.checkpoint_id == cp_id]

    def last_verdict(self, cp_id: str) -> str | None:
        a = self.atts(cp_id)
        return a[-1].verdict if a else None

    def guard_ok(self) -> bool:
        cp = self.cp()
        return can_advance(cp, self.last_verdict(cp["id"]) if cp else None, (self.s.outcome or {}).get(cp["id"]) if cp else None)

    def speak(self, lines, kind: str = "speech"):
        for t in (lines if isinstance(lines, list) else [lines]):
            if t:
                self.say.append({"id": L.line_hash(self.avatar.id, t), "text": t, "kind": kind})

    def event(self, type_: str, **payload):
        self.db.add(Event(actor_id=self.user.id, session_id=self.s.id, course_id=self.lesson.course_id, type=type_, payload=payload))

    def go(self, to: str, why: str = ""):
        frm = self.s.state
        check(frm, to, resume_state=self.s.resume_state, guard_ok=self.guard_ok(), reteach=(why == "reteach"))
        self.s.state = to
        tr = list(self.s.trace or []) + [to]
        self.s.trace = tr[-24:]
        self.event("state", frm=frm, to=to, why=why)

    def policy(self) -> dict:
        return {"threshold": "required", "hints": True, "assisted": True, "simpler": True, **(self.lesson.policy or {})}


# ---------------- flows ----------------
def teach(c: Ctx):
    sg = c.seg()
    if not sg:
        return complete(c)
    lines = sg["simpler"] if c.s.mode == "simpler" else sg["speech"]
    for i in range(c.s.sent, len(lines)):
        c.say.append({"id": L.line_hash(c.avatar.id, lines[i]), "text": lines[i], "kind": "teach", "idx": i})


def next_segment(c: Ctx, forced: bool = False):
    if c.s.seg + 1 >= len(c.segs):
        return complete(c)
    c.go("TEACHING", "reteach" if forced else "")
    c.s.seg += 1
    c.s.sent = 0
    c.s.mode = ""
    c.speak(L.next_seg(c.s.seg, len(c.segs)))
    teach(c)


def complete(c: Ctx):
    c.go("COMPLETED")
    c.s.status = "completed"
    c.s.ended_at = _now()
    c.speak(L.closing(c.content, c.name))
    c.event("complete")


def feedback_lines(c: Ctx, cp: dict, r: dict, n_att: int) -> list[str]:
    hints = cp["hints"]
    hi = min(n_att - 1, len(hints) - 1)
    req_missing = [i for i in r["missing"] if any(cc["id"] == i and cc.get("required") for cc in cp["concepts"])]
    if r["verdict"] == "correct":
        return L.correct(c.name, cp)
    if n_att >= cp["maxAttempts"] and cp["mandatory"]:
        return L.maxed(c.name)
    if r["verdict"] == "partial":
        return L.partial(c.name, (req_missing or r["missing"] or [None])[0], c.content.get("concept_ask"))
    if r["verdict"] == "unclear":
        return L.unclear(c.name)
    if "reversed" in r.get("mis", []):
        return L.reversed_(c.name, hints[hi])
    return L.incorrect(c.name, hints[hi])


async def do_answer(c: Ctx, text: str, idem: str | None, engine: str | None, fail: bool):
    cp = c.cp()
    if not cp:
        raise Blocked("No checkpoint in this segment")
    ans = (text or "").strip()
    if not ans:
        c.event("empty", cp=cp["id"])
        c.extra["error"] = {"field": "answer", "msg": "Type an answer before submitting."}
        return
    if idem:
        idem = f"{c.s.id}:{idem}"[:64]
        prev = (await c.db.execute(select(VFAttempt).where(VFAttempt.idempotency_key == idem))).scalar_one_or_none()
        if prev:
            c.extra["duplicate"] = True
            return
    if c.s.state in ("RETRY_OR_CONTINUE", "QUESTION"):
        c.go("WAITING_FOR_ANSWER")
    c.go("EVALUATING")
    n = len(c.atts(cp["id"])) + 1
    c.s.resume_state = None
    c.extra["last_answer"] = ans
    try:
        r, log = await evaluate(cp, ans, c.name, n, c.policy()["threshold"], engine=engine, fail=fail)
    except EvaluationFailed as e:
        c.event("eval_error", cp=cp["id"], code=e.code)
        c.go("ERROR_RECOVERY")
        c.s.mode = ""
        c.extra["error"] = {"code": e.code, "msg": "Evaluation service unavailable — your answer is saved and nothing was marked."}
        c.extra["pending_answer"] = ans
        # Keep the answer so "Try evaluation again" can re-run it.
        c.s.hints = {**(c.s.hints or {}), "_pending": ans}
        return
    elog_id = None
    if log:
        el = EvalLog(kind="checkpoint", model=log.get("model", "?"), prompt_hash=log.get("prompt_hash", "-"),
                     latency_ms=log.get("latency_ms", 0), ok=log.get("ok", False), raw=log.get("raw", {}),
                     policy_version=r.get("policy", "v1"), input_tokens=log.get("input_tokens"), output_tokens=log.get("output_tokens"))
        c.db.add(el)
        await c.db.flush()
        elog_id = el.id
    att = VFAttempt(session_id=c.s.id, checkpoint_id=cp["id"], n=n, answer=ans, verdict=r["verdict"], found=r["found"],
                    missing=r["missing"], mis=r["mis"], engine=r["engine"], confidence=r.get("confidence", "high"),
                    ai_feedback=r.get("ai_feedback"), hints_before=(c.s.hints or {}).get(cp["id"], 0), eval_log_id=elog_id,
                    idempotency_key=idem)
    c.db.add(att)
    c.attempts.append(att)
    c.event("eval", cp=cp["id"], verdict=r["verdict"], engine=r["engine"], n=n, mis=r["mis"], missing=r["missing"])
    if r.get("confidence") == "low":
        c.db.add(ReviewItem(kind="low_conf", session_id=c.s.id, checkpoint_id=cp["id"], course_id=c.lesson.course_id,
                            student_id=c.user.id, note=f"Low-confidence evaluation ({r.get('fallback_reason') or 'unverified evidence'})"))
    c.go("FEEDBACK")
    c.speak(feedback_lines(c, cp, r, n))
    c.extra["result"] = {k: r.get(k) for k in ("verdict", "found", "missing", "mis", "engine", "confidence", "ai_feedback")}


async def run_action(c: Ctx, action: str, p: dict):
    s = c.s
    cp = c.cp()
    if action == "start":
        resume = bool(p.get("resume")) and s.seg > 0
        s.started_at = s.started_at or _now()
        c.event("start", resume=resume)
        if resume:
            c.go("TEACHING", "resume"); s.sent = 0
            c.speak(L.resume(c.name)); teach(c)
        else:
            c.go("WELCOME")
            c.speak(L.welcome(L.greeting(int(p.get("hour", _now().hour))), c.name, avatar_dict(c.avatar)))
    elif action == "welcomed":
        c.go("TEACHING"); teach(c)
    elif action == "line_done":  # client reports progress through the teaching lines (for pause / repeat)
        if s.state == "TEACHING":
            s.sent = max(s.sent, int(p.get("sent", s.sent)))
    elif action == "taught":
        if s.state != "TEACHING":
            raise Blocked(f"{s.state} → QUESTION blocked")
        s.mode = ""
        if cp:
            c.go("QUESTION")
            c.speak([L.ask_intro(s.seg, cp["mandatory"], c.name), L.question(cp), L.TYPE_IT])
        else:
            next_segment(c)
    elif action == "asked":
        c.go("WAITING_FOR_ANSWER")
    elif action == "answer":
        await do_answer(c, p.get("text", ""), p.get("idempotency_key"), p.get("engine"), bool(p.get("simulate_failure")))
    elif action == "feedback_done":
        c.go("RETRY_OR_CONTINUE")
    elif action == "retry":
        c.go("WAITING_FOR_ANSWER")
    elif action == "hint":
        if not c.policy()["hints"] or not cp:
            raise Blocked("Hints are turned off for this lesson")
        if s.state not in ("WAITING_FOR_ANSWER", "RETRY_OR_CONTINUE"):
            raise Blocked(f"Hint not available while {LABEL[s.state].lower()}")
        k = (s.hints or {}).get(cp["id"], 0) + 1
        s.hints = {**(s.hints or {}), cp["id"]: k}
        h = cp["hints"][min(k - 1, len(cp["hints"]) - 1)]
        if s.state == "RETRY_OR_CONTINUE":
            c.go("WAITING_FOR_ANSWER")
        c.extra["assist"] = {"kind": "hint", "text": h, "level": min(k, len(cp["hints"])), "of": len(cp["hints"])}
        c.speak(h); c.event("hint", cp=cp["id"], level=k)
    elif action == "reteach":
        if not cp or s.state not in ("WAITING_FOR_ANSWER", "RETRY_OR_CONTINUE"):
            raise Blocked("Nothing to re-explain right now")
        if s.state == "RETRY_OR_CONTINUE":
            c.go("WAITING_FOR_ANSWER")
        c.extra["assist"] = {"kind": "reteach", "text": cp["reteach"]}
        c.speak(L.reteach(cp)); c.event("reteach", cp=cp["id"])
    elif action == "simpler":
        sg = c.seg()
        if s.state == "TEACHING":
            s.mode = "simpler"; s.sent = 0
            c.event("simpler"); teach(c)
        elif s.state in ("WAITING_FOR_ANSWER", "RETRY_OR_CONTINUE") and sg:
            if s.state == "RETRY_OR_CONTINUE":
                c.go("WAITING_FOR_ANSWER")
            c.extra["assist"] = {"kind": "simpler", "text": " ".join(sg["simpler"])}
            c.speak(sg["simpler"]); c.event("simpler")
        else:
            raise Blocked("A simpler explanation isn't available right now")
    elif action == "continue":
        if not c.guard_ok():
            raise Blocked("Checkpoint not satisfied — next segment stays locked")
        if cp and not (s.outcome or {}).get(cp["id"]):
            s.outcome = {**(s.outcome or {}), cp["id"]: "passed"}
        next_segment(c)
    elif action == "assisted":
        if not cp or not cp["mandatory"] or len(c.atts(cp["id"])) < cp["maxAttempts"] or not c.policy()["assisted"]:
            raise Blocked("Assisted continue is available after the maximum number of attempts")
        s.outcome = {**(s.outcome or {}), cp["id"]: "assisted"}
        c.db.add(ReviewItem(kind="assisted", session_id=s.id, checkpoint_id=cp["id"], course_id=c.lesson.course_id,
                            student_id=c.user.id, note="Completed with assisted learning"))
        c.event("assisted", cp=cp["id"])
        next_segment(c, forced=True)
    elif action == "skip":
        if not cp or cp["mandatory"]:
            raise Blocked("Only optional checks can be skipped")
        s.outcome = {**(s.outcome or {}), cp["id"]: "skipped"}
        c.event("skip", cp=cp["id"])
        next_segment(c, forced=True)
    elif action == "retry_eval":
        pending = (s.hints or {}).get("_pending")
        if s.state != "ERROR_RECOVERY" or not pending:
            raise Blocked("Nothing to re-evaluate")
        s.state = "WAITING_FOR_ANSWER"  # re-enter through the normal path
        await do_answer(c, pending, None, p.get("engine"), bool(p.get("simulate_failure")))
        if s.state != "ERROR_RECOVERY":
            s.hints = {k: v for k, v in (s.hints or {}).items() if k != "_pending"}
    elif action == "back_to_answer":
        c.go("WAITING_FOR_ANSWER")
    elif action == "pause":
        if s.state not in PAUSABLE:
            raise Blocked(f"Can't pause while {LABEL[s.state].lower()}")
        s.sent = int(p.get("sent", s.sent))
        s.resume_state = s.state
        s.state = "PAUSED"
        s.trace = (list(s.trace or []) + ["PAUSED"])[-24:]
        c.event("pause")
    elif action == "resume":
        if s.state != "PAUSED":
            raise Blocked("Not paused")
        to = s.resume_state
        c.go(to)
        s.resume_state = None
        c.event("resume")
        if to == "WELCOME":
            c.speak(L.welcome(L.greeting(int(p.get("hour", _now().hour))), c.name, avatar_dict(c.avatar)))
        elif to == "TEACHING":
            teach(c)
        elif to == "QUESTION":
            c.speak([L.question(cp), L.TYPE_IT])
        elif to == "FEEDBACK":
            c.go("RETRY_OR_CONTINUE")
    elif action == "repeat":
        if s.state == "TEACHING":
            s.sent = max(0, int(p.get("sent", s.sent)) - 1); teach(c)
        elif s.state in ("WAITING_FOR_ANSWER", "QUESTION") and cp:
            c.speak(L.question(cp))
        elif s.state == "RETRY_OR_CONTINUE" and cp and c.atts(cp["id"]):
            a = c.atts(cp["id"])[-1]
            c.speak(feedback_lines(c, cp, {"verdict": a.verdict, "missing": a.missing, "mis": a.mis}, len(c.atts(cp["id"]))))
        elif s.state == "COMPLETED":
            c.speak(L.closing(c.content, c.name))
    elif action == "switch_avatar":
        av = await c.db.get(Avatar, p.get("avatar_id"))
        if not av or av.status != "active":
            raise Blocked("That lecturer isn't available")
        s.avatar_id = av.id
        c.avatar = av
        c.speak(L.switched(c.name, avatar_dict(av)))
        c.event("switch_avatar", to=av.id)
    elif action == "save_exit":
        if s.state != "COMPLETED":
            s.status = "saved-after-error" if s.state == "ERROR_RECOVERY" else "saved"
            c.event("save")
    else:
        raise Blocked(f"Unknown action '{action}'")


def snapshot(c: Ctx) -> dict:
    s = c.s
    cp = c.cp()
    atts = c.atts(cp["id"]) if cp else []
    last = atts[-1] if atts else None
    max_reached = bool(cp and cp["mandatory"] and len(atts) >= cp["maxAttempts"] and (not last or last.verdict != "correct"))
    return {
        "id": s.id, "version": s.version, "state": s.state, "state_label": LABEL[s.state], "resume_state": s.resume_state,
        "seg": s.seg, "seg_count": len(c.segs), "sent": s.sent, "mode": s.mode, "status": s.status,
        "avatar_id": s.avatar_id, "lesson_id": s.lesson_id, "lesson_version": s.lesson_version,
        "trace": s.trace, "outcome": s.outcome, "hints": {k: v for k, v in (s.hints or {}).items() if not k.startswith("_")},
        "checkpoint": {"id": cp["id"], "question": cp["question"], "mandatory": cp["mandatory"], "max_attempts": cp["maxAttempts"],
                       "attempts": len(atts), "hint_count": len(cp["hints"])} if cp else None,
        "last_result": {"verdict": last.verdict, "found": last.found, "missing": last.missing, "mis": last.mis,
                        "engine": last.engine, "confidence": last.confidence, "ai_feedback": last.ai_feedback,
                        "answer": last.answer, "n": last.n} if last else None,
        "can_continue": c.guard_ok(), "can_assist": max_reached and c.policy()["assisted"],
        "pending_answer": (s.hints or {}).get("_pending"),
        "model_answer": cp["model"] if cp and max_reached else None,
        "say": c.say, **c.extra,
    }


async def load(db: AsyncSession, session_id: str, user: User, lock: bool = False) -> Ctx:
    q = select(VFSession).where(VFSession.id == session_id).execution_options(populate_existing=True)
    if lock:
        q = q.with_for_update()
    s = (await db.execute(q)).scalar_one_or_none()
    if not s or (s.user_id != user.id and user.role == "student"):
        raise LookupError("Session not found")
    lesson = await db.get(Lesson, s.lesson_id, populate_existing=True)
    avatar = await db.get(Avatar, s.avatar_id, populate_existing=True)
    student = await db.get(User, s.user_id, populate_existing=True)
    attempts = list((await db.execute(select(VFAttempt).where(VFAttempt.session_id == s.id).order_by(VFAttempt.id))).scalars())
    return Ctx(db, s, lesson, avatar, student, attempts)


async def act(db: AsyncSession, session_id: str, user: User, action: str, payload: dict, version: int | None) -> dict:
    c = await load(db, session_id, user, lock=True)
    if version is not None and version != c.s.version and action not in ("line_done",):
        raise Conflict(snapshot(c))
    await run_action(c, action, payload)
    if action != "line_done":
        c.s.version += 1
    await db.commit()
    return snapshot(c)
