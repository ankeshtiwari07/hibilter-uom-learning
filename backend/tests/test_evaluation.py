"""The demo's 10 checkpoint acceptance cases, run against the offline rubric engine + lecturer policy."""
import asyncio

import pytest

from app.evaluation.service import EvaluationFailed, evaluate
from app.seed.seed import lesson_content

L = lesson_content()
CP = [s["checkpoint"] for s in L["segments"]]

CASES = [
    ("T1", 0, "Machine learning is a subset of AI where systems learn patterns from data instead of being explicitly programmed.", "correct"),
    ("T2", 0, "AI is the big umbrella field; ML is one branch of it that figures out patterns by training on examples.", "correct"),
    ("T3", 0, "Machine learning is when computers learn from data.", "partial"),
    ("T4", 0, "AI is a type of machine learning used in robots.", "incorrect"),
    ("T5", 0, "There is no difference, they are the same thing.", "incorrect"),
    ("T7", 0, "idk", "unclear"),
    ("T8", 0, "sdfghjk qwrtp", "unclear"),
    ("T9", 1, "The labels tell the model the right answer for each example so it can check its predictions.", "correct"),
]


@pytest.mark.parametrize("tid,cp,ans,expect", CASES)
def test_rubric_cases(tid, cp, ans, expect):
    r, _ = asyncio.run(evaluate(CP[cp], ans, "Sagar", 1, engine="rubric"))
    assert r["verdict"] == expect, (tid, r)


def test_T10_technical_failure():
    with pytest.raises(EvaluationFailed):
        asyncio.run(evaluate(CP[0], "ML is part of AI and learns from data.", "Sagar", 1, engine="rubric", fail=True))


def test_threshold_all_requires_every_concept():
    r, _ = asyncio.run(evaluate(CP[0], "Machine learning is a subset of AI that learns from data.", "Sagar", 1, threshold="all", engine="rubric"))
    assert r["verdict"] == "partial" and "rules" in r["missing"]
