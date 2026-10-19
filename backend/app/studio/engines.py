"""Paid generation (fal.ai) behind a spend ledger with a hard cap and a content-addressed cache.

Every call is priced before it is made; if it would take the ledger past STUDIO_BUDGET_USD it is refused. Results are cached
by a hash of (engine, inputs, prompt, settings), so re-running a build — or rebuilding after a slide edit — never pays twice
for an unchanged shot."""
from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import shutil
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..core.config import get_settings
from .source import Lecturer, media_root, probe

log = logging.getLogger("studio")

TALK_ENGINE = os.environ.get("STUDIO_TALK_ENGINE", "fal-ai/bytedance/omnihuman/v1.5")
TALK_RES = os.environ.get("STUDIO_RESOLUTION", "1080p")      # shots are kept under 30 s, so 1080p is allowed; same price
EDIT_ENGINE = os.environ.get("STUDIO_EDIT_ENGINE", "fal-ai/nano-banana/edit")
PRICE = {TALK_ENGINE: 0.16, EDIT_ENGINE: 0.04}                # USD per second of video / per image (fal list prices)

CLOSEUP_PROMPT = ("The lecturer speaks directly to the camera in a warm, engaged teaching manner: natural head movement, expressive face "
                  "and eyes, and open-handed explanatory hand gestures that match the speech. Static camera. The background, lighting, "
                  "clothing and face stay exactly as in the reference image.")
STAGE_PROMPT = ("The lecturer stands and presents to the camera, now and then turning slightly and gesturing with an open hand toward the "
                "empty left side of the frame, where the presentation is displayed, then looking back at the camera. Natural body movement "
                "and weight shifts, expressive face. Static camera. Background, lighting, clothing and face stay exactly as in the reference image.")


def stage_keyframe_prompt(lec: Lecturer) -> str:
    who = "woman" if lec.gender == "female" else "man"
    return (f"Use the {who} in the reference photo. Keep the face, hairstyle, skin tone, age and the clothing EXACTLY the same — same jacket, "
            f"shirt and colours; this must be unmistakably the same person. New scene: the {who} is standing, seen from the knees up, on the "
            "right-hand third of a wide 16:9 frame, body angled slightly toward the left of the frame, hands relaxed in front at waist "
            "height, looking at the camera with a friendly, confident expression. Setting: a bright, modern broadcast lecture studio with a "
            "smooth deep-navy to blue gradient backdrop and soft glowing light streaks. The left two-thirds of the frame is clean, empty "
            "backdrop with no objects, screens or text. Soft, even studio lighting, photorealistic, sharp focus, no text, no logos.")


class BudgetExceeded(RuntimeError):
    pass


def studio_dir() -> Path:
    d = media_root() / "studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def budget() -> float:
    return float(os.environ.get("STUDIO_BUDGET_USD", "20"))


@contextmanager
def _ledger():
    path = studio_dir() / "ledger.json"
    with open(studio_dir() / "ledger.lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        data = json.loads(path.read_text()) if path.exists() else {"spent": 0.0, "entries": []}
        yield data
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.replace(path)


def spent() -> float:
    p = studio_dir() / "ledger.json"
    return json.loads(p.read_text())["spent"] if p.exists() else 0.0


def _reserve(est: float, what: str):
    with _ledger() as L:
        if L["spent"] + est > budget() + 1e-9:
            raise BudgetExceeded(f"{what}: ${est:.2f} would exceed the studio budget (spent ${L['spent']:.2f} of ${budget():.2f}). "
                                 "Raise STUDIO_BUDGET_USD to continue.")


def _charge(engine: str, units: float, what: str, request_id: str | None):
    cost = round(units * PRICE.get(engine, 0), 4)
    with _ledger() as L:
        L["spent"] = round(L["spent"] + cost, 4)
        L["entries"].append({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "engine": engine, "units": units,
                             "cost": cost, "what": what, "request": request_id})
    log.info("charged $%.2f (%s) · total $%.2f / $%.2f", cost, what, spent(), budget())
    return cost


def _sha(*parts) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.read_bytes() if isinstance(p, Path) else str(p).encode())
        h.update(b"\0")
    return h.hexdigest()[:24]


def _fal():
    import fal_client
    key = get_settings().fal_key or os.environ.get("FAL_KEY")
    if not key:
        raise RuntimeError("FAL_KEY is not configured")
    os.environ["FAL_KEY"] = key
    return fal_client


def _download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dest)


def _call(engine: str, args: dict, tries: int = 2) -> dict:
    fal = _fal()
    last = None
    for a in range(tries):
        try:
            h = fal.submit(engine, arguments=args)
            res = h.get()
            return {**(res or {}), "_request_id": getattr(h, "request_id", None)}
        except Exception as e:  # noqa: BLE001 — network / queue errors: one retry, then surface
            last = e
            log.warning("%s failed (attempt %d): %s", engine, a + 1, str(e)[:300])
            time.sleep(5)
    raise RuntimeError(f"{engine}: {last}")


def stage_keyframe(lec: Lecturer, n: int = 2) -> Path:
    """The lecturer standing in the studio (generated once per lecturer from the exact portrait, then reused for every lecture).
    The approved frame is keyframes/<id>/stage.png; candidates are kept beside it so a different one can be chosen."""
    d = studio_dir() / "keyframes" / lec.id
    approved = d / "stage.png"
    if approved.exists():
        return approved
    prompt = stage_keyframe_prompt(lec)
    est = PRICE[EDIT_ENGINE] * n
    _reserve(est, f"stage keyframe {lec.id}")
    fal = _fal()
    url = fal.upload_file(str(lec.portrait))
    res = _call(EDIT_ENGINE, {"prompt": prompt, "image_urls": [url], "num_images": n, "aspect_ratio": "16:9", "output_format": "png"})
    imgs = res.get("images") or []
    _charge(EDIT_ENGINE, len(imgs) or n, f"stage keyframe {lec.id}", res.get("_request_id"))
    if not imgs:
        raise RuntimeError(f"keyframe engine returned no image: {str(res)[:300]}")
    for i, im in enumerate(imgs, 1):
        _download(im["url"], d / f"candidate_{i}.png")
    shutil.copy(d / "candidate_1.png", approved)
    (d / "prompt.txt").write_text(prompt)
    return approved


def talk_cached(image: Path, audio: Path, prompt: str) -> Path:
    return studio_dir() / "cache" / f"{_sha(TALK_ENGINE, TALK_RES, image, audio, prompt)}.mp4"


def talk(image: Path, audio: Path, prompt: str, what: str) -> Path:
    """Lip-synced, gesturing video of the lecturer in `image` speaking `audio` (cached)."""
    out = talk_cached(image, audio, prompt)
    if out.exists():
        return out
    secs = probe(audio)
    _reserve(secs * PRICE[TALK_ENGINE], what)
    fal = _fal()
    args = {"image_url": fal.upload_file(str(image)), "audio_url": fal.upload_file(str(audio)), "prompt": prompt, "resolution": TALK_RES}
    t0 = time.monotonic()
    res = _call(TALK_ENGINE, args)
    url = (res.get("video") or {}).get("url")
    _charge(TALK_ENGINE, float(res.get("duration") or secs), what, res.get("_request_id"))
    if not url:
        raise RuntimeError(f"talk engine returned no video: {str(res)[:300]}")
    _download(url, out)
    log.info("%s rendered in %.0fs", what, time.monotonic() - t0)
    return out


def estimate(spoken_seconds: float, keyframes: int) -> float:
    return round(spoken_seconds * PRICE[TALK_ENGINE] + keyframes * 2 * PRICE[EDIT_ENGINE], 2)
