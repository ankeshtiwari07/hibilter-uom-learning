"""Teaching state machine (LLD §6.2). Pure functions: no I/O, fully unit-tested."""
from __future__ import annotations

STATES = ["IDLE", "WELCOME", "TEACHING", "QUESTION", "WAITING_FOR_ANSWER", "EVALUATING", "FEEDBACK",
          "RETRY_OR_CONTINUE", "COMPLETED", "PAUSED", "ERROR_RECOVERY"]

TRANSITIONS: dict[str, set[str]] = {
    "IDLE": {"WELCOME", "TEACHING"},
    "WELCOME": {"TEACHING", "PAUSED"},
    "TEACHING": {"TEACHING", "QUESTION", "COMPLETED", "PAUSED"},
    "QUESTION": {"WAITING_FOR_ANSWER", "PAUSED"},
    "WAITING_FOR_ANSWER": {"EVALUATING", "PAUSED", "TEACHING", "COMPLETED"},
    "EVALUATING": {"FEEDBACK", "ERROR_RECOVERY"},
    "FEEDBACK": {"RETRY_OR_CONTINUE", "PAUSED"},
    "RETRY_OR_CONTINUE": {"WAITING_FOR_ANSWER", "TEACHING", "COMPLETED", "PAUSED"},
    "ERROR_RECOVERY": {"EVALUATING", "WAITING_FOR_ANSWER", "PAUSED"},
    "PAUSED": set(),
    "COMPLETED": set(),
}

LABEL = {"IDLE": "Ready to start", "WELCOME": "Welcoming you", "TEACHING": "Explaining the concept",
         "QUESTION": "Asking a question", "WAITING_FOR_ANSWER": "Waiting for your response",
         "EVALUATING": "Processing your answer", "FEEDBACK": "Explaining your answer",
         "RETRY_OR_CONTINUE": "Your next step", "COMPLETED": "Lesson complete", "PAUSED": "Paused",
         "ERROR_RECOVERY": "Evaluation unavailable"}

PAUSABLE = {"WELCOME", "TEACHING", "QUESTION", "WAITING_FOR_ANSWER", "FEEDBACK", "RETRY_OR_CONTINUE", "ERROR_RECOVERY"}


class Blocked(Exception):
    def __init__(self, msg: str):
        super().__init__(msg)
        self.msg = msg


def can_advance(cp: dict | None, last_verdict: str | None, outcome: str | None) -> bool:
    if not cp or not cp.get("mandatory"):
        return True
    return last_verdict == "correct" or outcome == "assisted"


def check(frm: str, to: str, *, resume_state: str | None = None, guard_ok: bool = True, reteach: bool = False) -> None:
    if frm == "PAUSED":
        if to != resume_state:
            raise Blocked(f"{frm} → {to} blocked")
        return
    if to not in TRANSITIONS.get(frm, set()):
        raise Blocked(f"{frm} → {to} blocked")
    if to in ("TEACHING", "COMPLETED") and frm in ("WAITING_FOR_ANSWER", "RETRY_OR_CONTINUE") and not guard_ok and not reteach:
        raise Blocked("Checkpoint not satisfied — next segment stays locked")
