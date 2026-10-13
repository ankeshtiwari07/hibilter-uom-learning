"""Deterministic offline evaluator (regex concepts), ported from the demo's rubricEval(). Used as the fallback engine."""
from __future__ import annotations

import re
from functools import lru_cache

IDK = re.compile(r"^(i\s*(don'?t|do not)\s*know|idk|no idea|not sure|\?+$|pass$|skip$|dunno|nothing)", re.I)


@lru_cache(maxsize=512)
def _rx(src: str, flags: str) -> re.Pattern:
    return re.compile(src, re.I if "i" in flags else 0)


def _match(item: dict, text: str) -> bool:
    return any(_rx(r["re"], r.get("flags", "i")).search(text) for r in item.get("rx", []))


def is_unclear_text(a: str) -> tuple[bool, bool]:
    letters = re.sub(r"[^a-z]", "", a, flags=re.I)
    vowels = len(re.findall(r"[aeiou]", letters, re.I))
    idk = bool(IDK.search(a))
    gib = len(letters) >= 5 and (vowels / len(letters) < 0.17 or bool(re.search(r"(.)\1{3,}", a)) or bool(re.fullmatch(r"[^aeiou\s]{6,}", a, re.I)))
    return idk, gib


def rubric_eval(cp: dict, answer: str) -> dict:
    a = answer.strip()
    words = [w for w in a.split() if w]
    idk, gib = is_unclear_text(a)
    found = [c["id"] for c in cp["concepts"] if _match(c, a)]
    mis = [m["id"] for m in cp.get("misconceptions", []) if _match(m, a)]
    unclear = idk or gib or (len(words) < 3 and not found)
    return {"found": found, "mis": mis, "unclear": unclear, "engine": "rubric", "confidence": "medium"}
