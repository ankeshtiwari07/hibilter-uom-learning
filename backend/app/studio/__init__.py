"""Lecture studio: turns a narrated lecture (curriculum `video` item) into a produced, broadcast-style video.

  plan     the lecture's chapters → shots: close-ups of the lecturer (the exact portrait PNG), "stage" shots with the lecturer
           standing beside the chapter slide (bullets revealed as they are spoken), chapter cards, intro and end cards
  voice    every line is voiced with the course lecturer's neural voice (same audio the platform already plays)
  engines  fal.ai: OmniHuman 1.5 animates the lecturer from the keyframe + shot audio (lip sync, head, hands, body);
           a one-off image edit builds each lecturer's standing "stage" keyframe from the portrait. All paid calls go through
           a ledger with a hard budget cap and a content-addressed cache, so nothing is ever paid for twice.
  compose  ffmpeg: slow push-ins, slide panels, transitions, brand bug, lower third → 1080p MP4 + WebVTT captions + poster

Run: python -m app.studio.build <course>:<item> [--draft] [--max-seconds 60] [--publish]   (see build.py)
"""
