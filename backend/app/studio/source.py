"""Inputs for a production: the curriculum item, its course and lecturer, and the voiced lines (reusing rendered audio)."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..classroom.lines import line_hash
from ..core.config import get_settings

SEED = Path(__file__).resolve().parent.parent / "seed"
PORTRAITS = {"henri": "henri.png", "isabelle": "isabelle.png", "arjun": "arjun.png", "nalini": "nalini.png", "elena": "elena.png",
             "lucas": "lucas.png"}


@dataclass
class Lecturer:
    id: str
    name: str
    subject: str
    gender: str
    voice_id: str
    portrait: Path


@dataclass
class Line:
    text: str
    hash: str
    audio: Path
    dur: float


@dataclass
class Lecture:
    course_id: str
    course_code: str
    course_title: str
    item_id: str
    title: str
    module: str
    objectives: list[str]
    chapters: list[dict]
    lecturer: Lecturer
    digest: str = ""
    extra: dict = field(default_factory=dict)


def media_root() -> Path:
    return Path(get_settings().media_dir)


def assets_dir() -> Path:
    return Path(get_settings().assets_dir)


def lecturer(aid: str) -> Lecturer:
    data = json.loads((SEED / "demo_data.json").read_text())
    a = next(x for x in data["AVATARS"] if x["id"] == aid)
    return Lecturer(id=aid, name=a["name"], subject=a["subject"], gender=a["gender"], voice_id=a["tts"],
                    portrait=assets_dir() / "portraits" / PORTRAITS[aid])


def load(ref: str) -> Lecture:
    """ref = '<course>:<item>' e.g. 'c1:L2'."""
    import hashlib
    cid, _, iid = ref.partition(":")
    cur = json.loads((SEED / "curriculum" / f"{cid}.json").read_text())
    courses = {c["id"]: c for c in json.loads((SEED / "demo_data.json").read_text())["COURSES"]}
    for m in cur["modules"]:
        for it in m["items"]:
            if it["id"] == iid:
                if it["type"] != "video":
                    raise SystemExit(f"{ref} is a {it['type']} item; only narrated lectures (video) can be produced")
                body = {k: it.get(k) for k in ("title", "chapters", "objectives")}
                dg = hashlib.sha256(json.dumps([body, cur["presenter"]], sort_keys=True).encode()).hexdigest()[:12]
                c = courses.get(cid, {})
                return Lecture(course_id=cid, course_code=c.get("code", cid), course_title=c.get("title", cid), item_id=iid,
                               title=it["title"], module=m["title"], objectives=it.get("objectives", []), chapters=it["chapters"],
                               lecturer=lecturer(cur["presenter"]), digest=dg)
    raise SystemExit(f"no item {iid} in {cid}")


def items(cid: str) -> list[str]:
    cur = json.loads((SEED / "curriculum" / f"{cid}.json").read_text())
    return [f"{cid}:{it['id']}" for m in cur["modules"] for it in m["items"] if it["type"] == "video"]


def probe(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True)
    return float(json.loads(r.stdout or "{}").get("format", {}).get("duration", 0) or 0)


def voice(lec: Lecturer, text: str) -> Line:
    """The line's audio — the clip the platform already rendered if present, otherwise synthesised now with the same voice."""
    text = " ".join(text.split())
    h = line_hash(lec.id, text)
    path = media_root() / "audio" / f"{h}.mp3"
    if not path.exists():
        from ..services.render_worker import synth, to_mp3
        samples, sr = synth(text, lec.voice_id)
        to_mp3(samples, sr, path)
    return Line(text=text, hash=h, audio=path, dur=probe(path))
