"""Produce a lecture video.

  python -m app.studio.build c1:L2 --plan                  shot list + cost estimate, nothing rendered or spent
  python -m app.studio.build c1:L2 --draft                 full edit with still frames instead of generated video (free)
  python -m app.studio.build c1:L2 --max-seconds 60        paid pilot: the first ~60 s of narration
  python -m app.studio.build c1:L2 --publish               paid full lecture, then shown to students in the course
  python -m app.studio.build c1 --publish                  every lecture in course c1
Spend is capped by STUDIO_BUDGET_USD (ledger: <media>/studio/ledger.json); unchanged shots come from cache and cost nothing.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import compose, engines, graphics
from .plan import plan, intro_text, spoken_seconds
from .source import Lecture, items, load, media_root, voice

log = logging.getLogger("studio")


def out_dir(lec: Lecture) -> Path:
    return media_root() / "studio" / "out" / lec.course_id / lec.item_id


def produce(ref: str, *, draft: bool, max_seconds: float | None, publish: bool, only_plan: bool) -> dict:
    lec = load(ref)
    t_start = time.monotonic()
    intro = voice(lec.lecturer, intro_text(lec))
    voiced, total = [], intro.dur
    for ch in lec.chapters:  # voice only what the cut needs
        if max_seconds and total > max_seconds:
            break
        lines = []
        for t in ch["narration"]:
            ln = voice(lec.lecturer, t)
            lines.append(ln)
            total += ln.dur
        voiced.append(lines)
    shots = plan(lec, voiced, intro, max_seconds)
    secs = spoken_seconds(shots)
    need_kf = not draft and not (engines.studio_dir() / "keyframes" / lec.lecturer.id / "stage.png").exists() \
        and any(s.kind in ("stage", "intro") for s in shots)
    est = engines.estimate(secs, int(need_kf))
    print(f"\n{ref} · {lec.title} · {lec.lecturer.name}")
    for i, s in enumerate(shots):
        txt = (s.lines[0].text[:70] + "…") if s.lines else s.title
        print(f"  {i:2d} {s.kind:8s} {s.duration:5.1f}s  ch{s.chapter + 1 if s.chapter >= 0 else '-'}  reveal={s.reveal or '-'}  {txt}")
    print(f"  spoken {secs:.0f}s · total ~{sum(s.duration for s in shots) - compose.XF * (len(shots) - 1):.0f}s · "
          f"estimated cost ${0 if draft else est:.2f} · ledger ${engines.spent():.2f} of ${engines.budget():.2f}\n")
    if only_plan:
        return {"ref": ref, "estimate": est, "seconds": secs}
    if not draft and engines.spent() + est > engines.budget():
        raise engines.BudgetExceeded(f"estimated ${est:.2f} exceeds remaining budget ${engines.budget() - engines.spent():.2f}")

    tag = ("draft-" if draft else "") + lec.digest + (f"-{int(max_seconds)}s" if max_seconds else "")
    work = media_root() / "studio" / "work" / lec.course_id / lec.item_id / tag
    work.mkdir(parents=True, exist_ok=True)

    # graphics
    R = graphics.Renderer()
    try:
        bug = R.png(graphics.bug(), work / "g_bug.png")
        lower = R.png(graphics.lower_third(lec), work / "g_lower.png")
        stage_src = None
        if draft:
            stage_src = R.png(graphics.stage_draft(lec), work / "g_stage_draft.png", transparent=False)
        pw, ph = graphics.PANEL[2], graphics.PANEL[3]
        panels: dict[int, list[Path]] = {}
        for i, s in enumerate(shots):
            if s.kind == "intro":
                panels[i] = [R.png(graphics.intro_panel(lec), work / f"g_intro.png", pw, ph)]
            elif s.kind == "stage" and s.slide:
                eyebrow = f"{lec.course_code} · Chapter {s.chapter + 1}"
                panels[i] = [R.png(graphics.slide_panel(s.slide, k, eyebrow), work / f"g_ch{s.chapter + 1}_k{k}.png", pw, ph)
                             for k in compose.states(s)]
            elif s.kind == "chapter":
                panels[i] = [R.png(graphics.chapter_card(lec, s.chapter, s.title), work / f"g_card{s.chapter + 1}.png", transparent=False)]
            elif s.kind == "end":
                panels[i] = [R.png(graphics.end_card(lec), work / "g_end.png", transparent=False)]
    finally:
        R.close()

    # generated performance + segments
    if not draft and stage_src is None and any(s.kind in ("stage", "intro") for s in shots):
        stage_src = engines.stage_keyframe(lec.lecturer)
    segs, audios = [], []
    for i, s in enumerate(shots):
        seg = work / f"s{i:02d}_{s.kind}.mp4"
        if s.kind in ("chapter", "end"):
            compose.segment(s, panels[i][0], seg)
            segs.append(seg)
            audios.append(None)
            continue
        wav = compose.shot_audio(s, work / f"s{i:02d}.wav")
        img = lec.lecturer.portrait if s.kind == "closeup" else stage_src
        if draft:
            src = img
        else:
            prompt = engines.CLOSEUP_PROMPT if s.kind == "closeup" else engines.STAGE_PROMPT
            src = engines.talk(img, wav, prompt, f"{ref} shot {i} {s.kind}")
        prev = shots[i - 1] if i else None
        cont = s.kind == "stage" and prev is not None and prev.kind == "stage" and prev.chapter == s.chapter
        compose.segment(s, src, seg, panels=panels.get(i), lower=lower if s.lower_third else None, bug=bug, enter=not cont)
        segs.append(seg)
        audios.append(wav)
        log.info("segment %d/%d %s", i + 1, len(shots), s.kind)

    final = work / "lecture.mp4"
    timing = compose.assemble(shots, segs, audios, final)
    cues = compose.vtt(shots, timing["starts"], work / "captions.vtt")
    first_close = next((i for i, s in enumerate(shots) if s.kind == "closeup"), 0)
    compose.poster(final, timing["starts"][first_close] + 1.5, work / "poster.jpg")
    chapters = [{"title": s.title, "t": round(timing["starts"][i], 2)} for i, s in enumerate(shots) if s.kind == "chapter"]
    rel = lambda p: "/media/" + str(p.relative_to(media_root()))  # noqa: E731
    manifest = {"ref": ref, "course": lec.course_id, "item": lec.item_id, "title": lec.title, "lecturer": lec.lecturer.id,
                "digest": lec.digest, "draft": draft, "partial": bool(max_seconds), "duration": timing["duration"],
                "video_url": rel(final), "poster_url": rel(work / "poster.jpg"), "captions_url": rel(work / "captions.vtt"),
                "chapters": chapters, "cues": cues, "shots": [{"kind": s.kind, "t": round(t, 2), "dur": round(s.duration, 2)}
                                                               for s, t in zip(shots, timing["starts"])],
                "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "build_seconds": round(time.monotonic() - t_start),
                "ledger_spent": engines.spent()}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=1))
    if publish:
        od = out_dir(lec)
        od.mkdir(parents=True, exist_ok=True)
        tmp = od / "current.json.tmp"
        tmp.write_text(json.dumps(manifest, indent=1))
        tmp.replace(od / "current.json")
    print(f"done: {final} ({timing['duration']}s){' · published' if publish else ''} · ledger ${engines.spent():.2f}")
    return manifest


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s studio %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref", help="c1:L2 for one lecture, or c1 for every lecture in a course")
    ap.add_argument("--plan", action="store_true", help="print shot list and cost estimate only")
    ap.add_argument("--draft", action="store_true", help="still frames instead of generated video; costs nothing")
    ap.add_argument("--max-seconds", type=float, default=None, help="only the first N seconds of narration (pilot)")
    ap.add_argument("--publish", action="store_true", help="make this the version students see")
    a = ap.parse_args()
    refs = [a.ref] if ":" in a.ref else items(a.ref)
    try:
        for r in refs:
            produce(r, draft=a.draft, max_seconds=a.max_seconds, publish=a.publish, only_plan=a.plan)
    except engines.BudgetExceeded as e:
        print(f"STOPPED: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
