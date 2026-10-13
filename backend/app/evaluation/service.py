from __future__ import annotations

from ..core.config import get_settings
from . import llm
from .policy import apply_policy
from .rubric import rubric_eval


class EvaluationFailed(Exception):
    def __init__(self, code: str, msg: str = ""):
        super().__init__(msg or code)
        self.code = code


async def evaluate(cp: dict, answer: str, first_name: str, attempt: int, threshold: str = "required",
                   engine: str | None = None, fail: bool = False) -> tuple[dict, dict | None]:
    """Returns (result, eval_log). engine: auto|claude|rubric. Claude errors fall back to the rubric (low confidence)
    unless engine == 'claude' is forced, in which case EvaluationFailed is raised → ERROR_RECOVERY."""
    if fail:
        raise EvaluationFailed("upstream_error", "Simulated AI evaluation outage (presenter control)")
    engine = engine or get_settings().evaluation_engine
    if engine == "rubric" or (engine == "auto" and not llm.available()):
        return apply_policy(cp, rubric_eval(cp, answer), threshold), None
    try:
        raw, log = await llm.extract(cp, answer, first_name, attempt)
        log["ok"] = True
        return apply_policy(cp, raw, threshold), log
    except llm.EvalUnavailable as e:
        if engine == "claude":
            raise EvaluationFailed(e.code, str(e)) from e
        raw = rubric_eval(cp, answer)
        raw["confidence"] = "low"
        res = apply_policy(cp, raw, threshold)
        res["fallback_reason"] = e.code
        return res, {"model": "rubric-fallback", "prompt_hash": "-", "latency_ms": 0, "ok": False, "raw": {"error": e.code}}
