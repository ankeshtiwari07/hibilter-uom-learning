"""Every sentence a digital lecturer speaks. Single source of truth for the engine and the voice/video render pipeline
(ported from the demo's `V` object and `voiceInventory()`)."""
from __future__ import annotations

import hashlib

CONCEPT_ASK = {
    "subset": "how machine learning relates to AI as a whole",
    "data": "where a machine learning system gets its knowledge from",
    "rules": "how this differs from a programmer writing every rule",
    "aidef": "what AI as a field tries to do",
    "answer": "what information each label actually contains",
    "compare": "how the model uses that information while training",
    "mapping": "how inputs and labels are paired",
    "unfair": "what could happen to people who are under-represented",
}
GREETINGS = ["Good morning", "Good afternoon", "Good evening"]


def greeting(hour: int) -> str:
    return "Good morning" if hour < 12 else "Good afternoon" if hour < 17 else "Good evening"


def welcome(g, n, a):
    return [f"{g}, {n}.", "Welcome to today's session on Artificial Intelligence.", f"I'm {a['name']}.",
            "I will guide you through the topic, ask you a few questions, and help you understand the concepts as we go along."]


def resume(n):
    return [f"Welcome back, {n}.", "Let's pick up from your last completed checkpoint."]


def ask_intro(seg, mandatory, n):
    if seg == 0:
        return f"Now, {n}, let me check your understanding."
    return f"Let me check that with you, {n}." if mandatory else f"Here is a quick optional check, {n}."


def question(cp):
    q = cp["question"].removeprefix("Optional check: ")
    return q[0].upper() + q[1:]


TYPE_IT = "Please type your answer in the box."


def correct(n, cp):
    return [f"Excellent, {n}.", "That's right.", cp.get("ack") or cp["model"], "Let's build on that understanding."]


def maxed(n):
    return [f"Thank you for persevering, {n}.", "Let me explain this one a different way, and then we'll move on together."]


def partial(n, missing_id, concept_ask=None):
    ask = (concept_ask or {}).get(missing_id) or CONCEPT_ASK.get(missing_id) or "a little more"
    return [f"Good start, {n}.", "You've identified an important part of the concept.", f"Can you also explain {ask}?"]


def unclear(n):
    return [f"I'm not quite sure I followed that, {n}.", "Could you explain it in a full sentence, in your own words?"]


def reversed_(n, hint):
    return [f"That's a useful attempt, {n}, but it's actually the other way round.", hint, "Would you like to try again?"]


def incorrect(n, hint):
    return [f"That's a useful attempt, {n}.", "Let me give you a hint.", hint, "Would you like to try again?"]


def reteach(cp):
    return [cp["reteach"], "Now, have another go, in your own words."]


def next_seg(seg, total):
    return ("Perfect. Now that we have established the foundation, let's move to the next concept."
            if seg == 1 else "Well done. Let's look at the final part of today's lesson.")


def closing(lesson, n):
    return [l.replace("{name}", n) for l in lesson["closing"]]


def switched(n, a):
    return [f"Hello, {n}.", f"I'm {a['name']}.", "I'll continue exactly where we left off."]


SIDE_AI = ["Good question.", "I've put my answer on the screen for you."]
SIDE_CONTINUE = "Now, let me continue."


def preview(a):
    return [f"Hello, I'm {a['name']}.", f"I teach {a['teach']}.", "Let's begin today's lesson."]


def line_hash(avatar_id: str, text: str, voice_ver: str = "kokoro-1") -> str:
    norm = " ".join(text.split())
    return hashlib.sha256(f"{avatar_id}|{voice_ver}|{norm}".encode()).hexdigest()[:40]


def inventory(lesson: dict, avatar: dict, names: list[str]) -> list[str]:
    """Every line this avatar can say in this lesson for the given learner first names."""
    out: dict[str, None] = {}

    def add(x):
        for s in (x if isinstance(x, list) else [x]):
            if s:
                out[s] = None

    segs = lesson["segments"]
    for n in names:
        for g in GREETINGS:
            add(welcome(g, n, avatar))
        add(resume(n)); add(unclear(n)); add(maxed(n)); add(closing(lesson, n)); add(switched(n, avatar))
        for i, s in enumerate(segs):
            cp = s["checkpoint"]
            add(ask_intro(i, cp["mandatory"], n)); add(correct(n, cp))
            for c in cp["concepts"]:
                add(partial(n, c["id"], lesson.get("concept_ask")))
            for h in cp["hints"]:
                add(reversed_(n, h)); add(incorrect(n, h))
    for i, s in enumerate(segs):
        add(s["speech"]); add(s["simpler"]); add(question(s["checkpoint"])); add(reteach(s["checkpoint"]))
        if i:
            add(next_seg(i, len(segs)))
    add(TYPE_IT); add(SIDE_AI); add(SIDE_CONTINUE); add(preview(avatar))
    add(list(lesson.get("side_answers", {}).values()))
    return list(out)
