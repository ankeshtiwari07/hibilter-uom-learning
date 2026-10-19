"""Assembly with ffmpeg: per-shot segments (push-in, slide panel reveals, lower third, brand bug) → dissolves → one MP4.

Lip sync is preserved by construction: each spoken shot's video is generated from exactly the audio file that is laid back
under it, at exactly the timeline position where its first frame appears."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .graphics import PANEL, H, W
from .plan import GAP, PAD, Shot  # noqa: F401

SR = 48000
FPS = 30
XF = 0.35  # dissolve length between shots


def _run(args: list[str]):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"ffmpeg failed: {r.stderr[-1500:]}")


def _decode(path: Path) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def shot_audio(shot: Shot, out: Path) -> Path:
    """PAD + line + GAP + line … + PAD, mono 48 kHz WAV — the exact audio the video engine animates to."""
    sil = lambda s: np.zeros(int(round(s * SR)), dtype=np.float32)  # noqa: E731
    parts = [sil(PAD)]
    for i, ln in enumerate(shot.lines):
        if i:
            parts.append(sil(GAP))
        a = _decode(ln.audio)
        parts.append(a[: int(round(ln.dur * SR))] if len(a) > ln.dur * SR else np.concatenate([a, sil(ln.dur - len(a) / SR)]))
    parts.append(sil(PAD))
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, np.concatenate(parts), SR, subtype="PCM_16")
    return out


def _push(zoom: float, dur: float, fy: float = 0.5) -> str:
    """Slow push-in on a 1.5× source so the per-frame crop is sub-pixel smooth at output size."""
    n = max(1, int(round(dur * FPS)))
    return (f"scale={W * 3 // 2}:{H * 3 // 2}:force_original_aspect_ratio=increase,crop={W * 3 // 2}:{H * 3 // 2},"
            f"zoompan=z='1+{zoom}*on/{n}':x='iw/2-(iw/zoom/2)':y='ih*{fy}-(ih/zoom*{fy})':d=1:s={W}x{H}:fps={FPS}")


def segment(shot: Shot, src: Path, out: Path, *, panels: list[Path] | None = None, lower: Path | None = None, bug: Path | None = None,
            enter: bool = True) -> Path:
    """Render one shot to a silent 1080p segment of exactly shot.duration seconds."""
    d = shot.duration
    still = src.suffix.lower() in (".png", ".jpg", ".jpeg")
    args = (["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", str(src)] if still else ["-i", str(src)])
    chain = [] if still else [f"fps={FPS}", "tpad=stop_mode=clone:stop_duration=5", f"trim=duration={d:.3f}", "setpts=PTS-STARTPTS"]
    if shot.kind == "closeup":
        chain.append(_push(0.07, d, 0.38))
    elif shot.kind in ("stage", "intro"):
        chain.append(_push(0.025, d, 0.45))
    else:
        chain.append(_push(0.05, d, 0.5))
    graph = [f"[0:v]{','.join(chain)},format=yuv420p,setsar=1[v0]"]
    cur, idx = "v0", 1
    px, py, _, _ = PANEL
    sl = state_lines(shot)
    for k, p in enumerate(panels or []):
        args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", str(p)]
        t0 = (0.25 if enter else 0.0) if k == 0 else shot.starts[sl[k]]
        t1 = shot.starts[sl[k + 1]] + 0.4 if k + 1 < len(panels) else d + 1
        fade = 0.45 if k == 0 else 0.3
        x = f"if(lt(t,{t0 + 0.6:.2f}),{px}-140*pow(1-(t-{t0:.2f})/0.6,3),{px})" if k == 0 and enter else str(px)
        fin = f"fade=in:st={t0:.2f}:d={fade}:alpha=1" if (k or enter) else "null"
        graph.append(f"[{idx}:v]format=rgba,{fin}[p{idx}]")
        graph.append(f"[{cur}][p{idx}]overlay=x='{x}':y={py}:enable='between(t,{t0:.2f},{t1:.2f})'[v{idx}]")
        cur, idx = f"v{idx}", idx + 1
    if lower:
        args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", str(lower)]
        e = min(d - 0.4, 6.5)
        graph.append(f"[{idx}:v]format=rgba,fade=in:st=0.6:d=0.4:alpha=1,fade=out:st={e - 0.4:.2f}:d=0.4:alpha=1[p{idx}]")
        graph.append(f"[{cur}][p{idx}]overlay=0:0:enable='between(t,0.6,{e:.2f})'[v{idx}]")
        cur, idx = f"v{idx}", idx + 1
    if bug:
        args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", str(bug)]
        graph.append(f"[{cur}][{idx}:v]overlay=0:0[v{idx}]")
        cur, idx = f"v{idx}", idx + 1
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([*args, "-filter_complex", ";".join(graph), "-map", f"[{cur}]", "-t", f"{d:.3f}", "-r", str(FPS),
          "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-an", str(out)])
    return out


def state_lines(shot: Shot) -> list[int]:
    """Index of the line at which each distinct reveal state first appears."""
    out, prev = [], None
    for i, r in enumerate(shot.reveal):
        if r != prev:
            out.append(i)
            prev = r
    return out


def states(shot: Shot) -> list[int]:
    out: list[int] = []
    for r in shot.reveal:
        if not out or r != out[-1]:
            out.append(r)
    return out


def assemble(shots: list[Shot], segs: list[Path], audios: list[Path | None], out: Path) -> dict:
    """Dissolve the segments together and lay each spoken shot's audio at the exact time its video starts."""
    starts, t = [], 0.0
    for i, s in enumerate(shots):
        starts.append(t)
        t += s.duration - XF
    total = t + XF
    args: list[str] = []
    for p in segs:
        args += ["-i", str(p)]
    graph, cur = [], "0:v"
    for i in range(1, len(segs)):
        kind = "smoothleft" if shots[i].kind == "chapter" or shots[i - 1].kind == "chapter" else "fade"
        graph.append(f"[{cur}][{i}:v]xfade=transition={kind}:duration={XF}:offset={starts[i]:.3f}[x{i}]")
        cur = f"x{i}"
    aud = []
    n = len(segs)
    for i, a in enumerate(audios):
        if a is None:
            continue
        args += ["-i", str(a)]
        ms = int(round(starts[i] * 1000))
        graph.append(f"[{n}:a]aresample={SR},adelay={ms}|{ms},apad[a{i}]")
        aud.append(f"[a{i}]")
        n += 1
    graph.append(f"{''.join(aud)}amix=inputs={len(aud)}:normalize=0:duration=longest,atrim=0:{total:.3f},"
                 f"loudnorm=I=-16:TP=-1.5:LRA=11,aresample={SR}[aout]")
    vmap = f"[{cur}]" if len(segs) > 1 else "0:v"
    out.parent.mkdir(parents=True, exist_ok=True)
    _run([*args, "-filter_complex", ";".join(graph), "-map", vmap, "-map", "[aout]", "-t", f"{total:.3f}",
          "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", str(FPS),
          "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", str(out)])
    return {"starts": starts, "duration": round(total, 2)}


def vtt(shots: list[Shot], starts: list[float], out: Path) -> list[dict]:
    def ts(x: float) -> str:
        h, r = divmod(x, 3600)
        m, s = divmod(r, 60)
        return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
    cues = []
    for s, t0 in zip(shots, starts):
        for ln, st in zip(s.lines, s.starts):
            cues.append({"t": round(t0 + st, 2), "end": round(t0 + st + ln.dur, 2), "text": ln.text})
    body = "WEBVTT\n\n" + "\n".join(f"{i + 1}\n{ts(c['t'])} --> {ts(c['end'])}\n{c['text']}\n" for i, c in enumerate(cues))
    out.write_text(body)
    return cues


def poster(video: Path, at: float, out: Path):
    _run(["-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", "-q:v", "3", str(out)])


