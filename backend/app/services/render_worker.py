"""Media render worker (LLD §6.4).

Picks up pending MediaClip rows and produces, per spoken line and lecturer:
  1. neural voice audio (Kokoro, self-hosted on CPU) + a 50 fps loudness envelope for Tier-C lip-sync  → status 'audio'
  2. a full upper-body talking video from the EXACT portrait PNG + that audio via fal.ai          → status 'ready'
Per-line video is only requested for lines marked want_video (scripted, name-free lines), when FAL_KEY is configured AND
VIDEO_LINES=1. It is off by default: fal.ai bills per second, and produced lectures come from the studio pipeline
(app.studio), which has its own budget cap.
Run: python -m app.services.render_worker
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
from sqlalchemy import false, or_, select

from ..core.config import get_settings
from ..core.db import SessionLocal
from ..models import Avatar, MediaClip

log = logging.getLogger("render")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s render %(message)s")

MODEL_DIR = Path(os.environ.get("KOKORO_DIR", "/data/media/models"))
KOKORO_ONNX = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
KOKORO_VOICES = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
VIDEO_ENGINE = os.environ.get("VIDEO_ENGINE", "fal-ai/bytedance/omnihuman/v1.5")
VIDEO_RES = os.environ.get("VIDEO_RESOLUTION", "720p")
VIDEO_LINES = os.environ.get("VIDEO_LINES", "0") == "1"
MAX_ATTEMPTS = 3
GESTURE_PROMPT = ("A university lecturer seated at a desk speaks directly to the camera in a warm, engaged teaching manner, "
                  "with natural upper-body movement and open-handed explanatory hand gestures that match the speech. "
                  "Static camera. The background, lighting, clothing and face stay exactly as in the reference image.")

_kokoro = None


def media_root() -> Path:
    return Path(get_settings().media_dir)


def _download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    log.info("downloading %s", url)
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.rename(dest)


def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        onnx, voices = MODEL_DIR / "kokoro-v1.0.onnx", MODEL_DIR / "voices-v1.0.bin"
        if not onnx.exists():
            _download(KOKORO_ONNX, onnx)
        if not voices.exists():
            _download(KOKORO_VOICES, voices)
        _kokoro = Kokoro(str(onnx), str(voices))
    return _kokoro


def envelope(samples: np.ndarray, sr: int, fps: int = 50) -> str:
    """Peak-normalised RMS loudness per frame, 0..255, base64 — same format as the demo voice bank."""
    hop = sr // fps
    n = max(1, len(samples) // hop)
    frames = samples[: n * hop].reshape(n, hop)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    peak = np.percentile(rms, 98) or 1.0
    env = np.clip(rms / peak, 0, 1) ** 0.7
    return base64.b64encode((env * 255).astype(np.uint8).tobytes()).decode()


def synth(text: str, voice_id: str) -> tuple[np.ndarray, int]:
    voice, _, lang = voice_id.partition(":")
    samples, sr = kokoro().create(text, voice=voice, speed=1.0, lang=lang or "en-gb")
    return samples, sr


def to_mp3(samples: np.ndarray, sr: int, out: Path):
    import soundfile as sf
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav") as w:
        sf.write(w.name, samples, sr)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", w.name, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
                        "-ar", "24000", "-ac", "1", "-b:a", "64k", str(out)], check=True)


def probe_duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], capture_output=True, text=True)
    return float(json.loads(r.stdout or "{}").get("format", {}).get("duration", 0) or 0)


def render_video(portrait: Path, audio: Path, out: Path) -> dict:
    """Full upper-body animation of the exact PNG driven by the line audio (managed API)."""
    import fal_client
    img_url = fal_client.upload_file(str(portrait))
    aud_url = fal_client.upload_file(str(audio))
    args = {"image_url": img_url, "audio_url": aud_url, "prompt": GESTURE_PROMPT}
    if "omnihuman" in VIDEO_ENGINE:
        args["resolution"] = VIDEO_RES
    else:  # infinitalk-style engines
        dur = probe_duration(audio)
        args.update(resolution="720p" if VIDEO_RES == "720p" else "480p", num_frames=int(min(721, max(41, round(dur * 25) + 4))))
    t0 = time.monotonic()
    res = fal_client.subscribe(VIDEO_ENGINE, arguments=args, with_logs=False)
    url = (res or {}).get("video", {}).get("url")
    if not url:
        raise RuntimeError(f"engine returned no video: {str(res)[:300]}")
    _download(url, out)
    return {"engine": VIDEO_ENGINE, "seconds": round(time.monotonic() - t0, 1), "seed": res.get("seed"), "billed_duration": res.get("duration")}


def qc_video(video: Path, audio_dur: float) -> dict:
    vdur = probe_duration(video)
    ok = vdur > 0 and abs(vdur - audio_dur) <= max(0.6, audio_dur * 0.08)
    return {"video_duration": round(vdur, 2), "audio_duration": round(audio_dur, 2), "duration_ok": ok}


def faststart(src: Path, dst: Path):
    """Re-mux for progressive web playback (moov atom first), keep the engine's audio track."""
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-c", "copy", "-movflags", "+faststart", str(dst)], check=True)


_names: set[str] | None = None


async def learner_names(db) -> set[str]:
    global _names
    if _names is None:
        from ..models import User
        _names = {n for n in (await db.execute(select(User.first).where(User.role == "student"))).scalars() if n}
    return _names


async def process(clip_hash: str):
    s = get_settings()
    root = media_root()
    async with SessionLocal() as db:
        clip = await db.get(MediaClip, clip_hash)
        if not clip:
            return
        av = await db.get(Avatar, clip.avatar_id)
        if "want_video" not in (clip.qc or {}):
            # scripted, name-free lines get full-body video; personalised lines stay audio + animated portrait
            names = await learner_names(db)
            clip.qc = {**(clip.qc or {}), "want_video": not any(f" {n}" in f" {clip.text}" for n in names)}
        want_video = bool((clip.qc or {}).get("want_video"))
        audio_path = root / "audio" / f"{clip.hash}.mp3"
        try:
            if not clip.audio_url or not audio_path.exists():
                samples, sr = await asyncio.to_thread(synth, clip.text, av.voice_id)
                await asyncio.to_thread(to_mp3, samples, sr, audio_path)
                clip.envelope = envelope(samples, sr)
                clip.duration = round(len(samples) / sr, 3)
                clip.audio_url = f"/media/audio/{clip.hash}.mp3"
                clip.status = "audio"
                clip.engine = "kokoro-onnx-v1.0"
                await db.commit()
            if want_video and s.fal_key and VIDEO_LINES:
                os.environ["FAL_KEY"] = s.fal_key
                clip.status = "rendering"
                clip.attempts += 1
                await db.commit()
                portrait = Path(s.assets_dir) / av.portrait.removeprefix("/assets/")
                raw = root / "video" / f"{clip.hash}.raw.mp4"
                final = root / "video" / f"{clip.hash}.mp4"
                meta = await asyncio.to_thread(render_video, portrait, audio_path, raw)
                qc = await asyncio.to_thread(qc_video, raw, clip.duration or probe_duration(audio_path))
                await asyncio.to_thread(faststart, raw, final)
                raw.unlink(missing_ok=True)
                clip.qc = {**(clip.qc or {}), **qc, **meta}
                clip.video_url = f"/media/video/{clip.hash}.mp4"
                clip.status = "ready" if qc["duration_ok"] else "review"
                clip.engine = meta["engine"]
                clip.error = None
                await db.commit()
                log.info("video %s %s (%ss)", clip.hash[:10], clip.status, meta["seconds"])
        except Exception as e:  # keep the audio if it exists; retry video later
            log.exception("render failed %s", clip_hash[:10])
            clip.error = str(e)[:1000]
            clip.status = "failed" if clip.attempts >= MAX_ATTEMPTS else ("audio" if clip.audio_url else "pending")
            if clip.status == "audio" and want_video:
                clip.qc = {**(clip.qc or {}), "retry_video": True}
            await db.commit()


async def next_batch(limit: int = 4) -> list[str]:
    s = get_settings()
    async with SessionLocal() as db:
        q = select(MediaClip.hash).where(or_(
            MediaClip.status == "pending",
            ((MediaClip.status == "audio") & (MediaClip.attempts < MAX_ATTEMPTS) & MediaClip.qc["want_video"].as_boolean().is_(True)) if (s.fal_key and VIDEO_LINES) else false(),
        )).order_by(MediaClip.created_at).limit(limit)
        return list((await db.execute(q)).scalars())


async def main():
    log.info("render worker up · video engine %s · fal %s · %s", VIDEO_ENGINE, "configured" if get_settings().fal_key else "NOT configured",
             "per-line video ON" if VIDEO_LINES else "per-line video off (studio pipeline renders lectures)")
    await asyncio.to_thread(kokoro)
    while True:
        try:
            batch = await next_batch()
        except Exception:
            log.exception("db poll failed")
            batch = []
        if not batch:
            await asyncio.sleep(5)
            continue
        # audio is CPU-bound → sequential; video calls are I/O-bound but metered → small concurrency
        await asyncio.gather(*(process(h) for h in batch))


if __name__ == "__main__":
    asyncio.run(main())
