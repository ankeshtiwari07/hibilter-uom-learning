"""Shot planning: a lecture's chapters → an edit decision list in the style of a broadcast explainer.

Per chapter: the first line is a close-up of the lecturer (exact portrait), the following lines are "stage" shots with the
lecturer standing beside the chapter slide whose points appear as they are spoken, and long chapters close on a close-up.
Chapters are separated by a short silent chapter card. Spoken shots are capped (MAX_SHOT seconds) so the video engine gets
short, well-synced clips."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .source import Lecture, Line

PAD = 0.4        # silence before / after speech inside a spoken shot (> the dissolve, so speech never overlaps)
GAP = 0.45       # pause between sentences
MAX_SHOT = 24.0  # seconds of audio per generated clip (engine limit is 60 s at 720p, 30 s at 1080p)
CARD = 1.8       # chapter card length
END = 3.2        # end card length


@dataclass
class Shot:
    kind: str                         # intro | closeup | stage | chapter | end
    lines: list[Line] = field(default_factory=list)
    chapter: int = -1
    slide: dict | None = None
    reveal: list[int] = field(default_factory=list)   # slide elements visible while line i is spoken
    title: str = ""
    lower_third: bool = False
    starts: list[float] = field(default_factory=list)  # line start offsets inside the shot

    @property
    def spoken(self) -> bool:
        return bool(self.lines)

    @property
    def duration(self) -> float:
        if not self.lines:
            return END if self.kind == "end" else CARD
        return PAD * 2 + sum(x.dur for x in self.lines) + GAP * (len(self.lines) - 1)

    def layout(self):
        t = PAD
        self.starts = []
        for x in self.lines:
            self.starts.append(t)
            t += x.dur + GAP


def elements(slide: dict | None) -> int:
    if not slide:
        return 0
    k = slide.get("kind")
    n = {"bullets": len(slide.get("points") or []), "steps": len(slide.get("steps") or []), "cards": len(slide.get("cards") or []),
         "stat": len(slide.get("stats") or []), "compare": len(slide.get("columns") or [])}.get(k)
    if n is None:  # formula / code: the block, then its points
        n = 1 + len(slide.get("points") or [])
    return n + (1 if slide.get("note", {}).get("text") else 0)


def plan(lec: Lecture, voiced: list[list[Line]], intro: Line, max_seconds: float | None = None) -> list[Shot]:
    shots: list[Shot] = [Shot(kind="intro", lines=[intro], title=lec.title, lower_third=False)]
    budget = (max_seconds - intro.dur) if max_seconds else math.inf
    first_closeup = True
    for ci, (ch, lines) in enumerate(zip(lec.chapters, voiced)):
        take = []
        for x in lines:
            if budget - x.dur < 0:
                break
            budget -= x.dur
            take.append(x)
        if not take:
            break
        shots.append(Shot(kind="chapter", chapter=ci, title=ch["title"]))
        shots.append(Shot(kind="closeup", lines=[take[0]], chapter=ci, lower_third=first_closeup))
        first_closeup = False
        rest = take[1:]
        tail = rest.pop() if len(rest) >= 4 else None
        n, m = elements(ch.get("slide")), len(rest)
        cur: Shot | None = None
        for j, x in enumerate(rest):
            k = max(1, math.ceil(n * (j + 1) / m)) if n else 0
            if cur is None or cur.duration + GAP + x.dur > MAX_SHOT:
                cur = Shot(kind="stage", chapter=ci, slide=ch.get("slide"), title=ch["title"])
                shots.append(cur)
            cur.lines.append(x)
            cur.reveal.append(k)
        if tail:
            shots.append(Shot(kind="closeup", lines=[tail], chapter=ci))
        if len(take) < len(lines):
            break
    shots.append(Shot(kind="end", title=lec.title))
    for s in shots:
        s.layout()
    return shots


def intro_text(lec: Lecture) -> str:
    return f"Hello, I'm {lec.lecturer.name}. Welcome to {lec.course_title}. In this lecture: {lec.title}."


def spoken_seconds(shots: list[Shot]) -> float:
    return sum(s.duration for s in shots if s.spoken)
