import pytest

from app.classroom.fsm import Blocked, can_advance, check


def test_legal_path():
    for a, b in [("IDLE", "WELCOME"), ("WELCOME", "TEACHING"), ("TEACHING", "QUESTION"), ("QUESTION", "WAITING_FOR_ANSWER"),
                 ("WAITING_FOR_ANSWER", "EVALUATING"), ("EVALUATING", "FEEDBACK"), ("FEEDBACK", "RETRY_OR_CONTINUE")]:
        check(a, b)


def test_illegal_transition_rejected():
    with pytest.raises(Blocked):
        check("TEACHING", "FEEDBACK")
    with pytest.raises(Blocked):
        check("COMPLETED", "TEACHING")


def test_mandatory_checkpoint_locks_next_segment():
    with pytest.raises(Blocked, match="locked"):
        check("RETRY_OR_CONTINUE", "TEACHING", guard_ok=False)
    check("RETRY_OR_CONTINUE", "TEACHING", guard_ok=True)
    check("RETRY_OR_CONTINUE", "TEACHING", guard_ok=False, reteach=True)  # assisted path


def test_pause_returns_only_to_saved_state():
    check("PAUSED", "TEACHING", resume_state="TEACHING")
    with pytest.raises(Blocked):
        check("PAUSED", "QUESTION", resume_state="TEACHING")


def test_guard():
    cp = {"mandatory": True}
    assert not can_advance(cp, "partial", None)
    assert can_advance(cp, "correct", None)
    assert can_advance(cp, "incorrect", "assisted")
    assert can_advance({"mandatory": False}, None, None)
