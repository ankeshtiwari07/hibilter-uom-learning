"""Broadcast graphics, drawn as HTML and rasterised with headless Chromium: slide panels (one image per reveal state),
the intro title panel, chapter and end cards, the lower third and the corner brand bug. Hibilter brand: navy, teal, logo blue."""
from __future__ import annotations

import base64
from html import escape
from pathlib import Path

from .source import Lecture, assets_dir

W, H = 1920, 1080
PANEL = (80, 120, 1080, 840)   # x, y, w, h of the slide panel on the stage frame (lecturer stands on the right third)

FONTS = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&'
         'family=IBM+Plex+Sans:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=block">')

CSS = """
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent;font-family:'IBM Plex Sans',sans-serif;color:#0A1A33;-webkit-font-smoothing:antialiased}
:root{--navy:#17345E;--ink:#0A1A33;--teal:#0C7773;--blue:#1C6FE0;--sky:#38A8F0;--muted:#4D5D72}
.panel{position:absolute;inset:0;border-radius:30px;overflow:hidden;
  background:linear-gradient(160deg,rgba(255,255,255,.95),rgba(232,240,250,.92));
  box-shadow:0 30px 80px rgba(6,18,40,.38),inset 0 0 0 1.5px rgba(255,255,255,.75)}
.panel:before{content:"";position:absolute;left:0;right:0;top:0;height:8px;background:linear-gradient(90deg,var(--teal),var(--blue),var(--sky))}
.fit{position:absolute;inset:60px 68px 56px;display:flex;flex-direction:column;justify-content:center;gap:calc(26px*var(--s))}
.eyebrow{font:600 calc(20px*var(--s))/1 'IBM Plex Sans';letter-spacing:.14em;text-transform:uppercase;color:var(--teal)}
h1{font:600 calc(54px*var(--s))/1.12 'Newsreader',serif;color:var(--ink);letter-spacing:-.01em}
ul.pts{list-style:none;display:flex;flex-direction:column;gap:calc(20px*var(--s))}
ul.pts li{display:flex;gap:calc(20px*var(--s));font:400 calc(31px*var(--s))/1.35 'IBM Plex Sans';color:#1A2B42}
ul.pts li:before{content:"";flex:none;width:calc(16px*var(--s));height:calc(16px*var(--s));margin-top:calc(14px*var(--s));border-radius:3px;
  background:linear-gradient(135deg,var(--sky),var(--blue));box-shadow:0 0 14px rgba(56,168,240,.55)}
ol.steps{list-style:none;display:flex;flex-direction:column;gap:calc(18px*var(--s))}
ol.steps li{display:grid;grid-template-columns:calc(58px*var(--s)) 1fr;column-gap:calc(20px*var(--s));align-items:start}
ol.steps .n{grid-row:span 2;width:calc(58px*var(--s));height:calc(58px*var(--s));border-radius:50%;display:grid;place-items:center;color:#fff;
  font:600 calc(27px*var(--s))/1 'IBM Plex Sans';background:linear-gradient(135deg,var(--teal),var(--blue));box-shadow:0 6px 18px rgba(28,111,224,.35)}
ol.steps b{font:600 calc(30px*var(--s))/1.3 'IBM Plex Sans';color:var(--ink);margin-top:calc(6px*var(--s))}
ol.steps span{font:400 calc(24px*var(--s))/1.35 'IBM Plex Sans';color:var(--muted)}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:calc(20px*var(--s))}
.card{border-radius:20px;padding:calc(24px*var(--s)) calc(26px*var(--s));background:#fff;box-shadow:0 8px 26px rgba(13,33,64,.10);border-top:5px solid var(--blue)}
.card:nth-child(2n){border-top-color:var(--teal)}
.card .l{font:600 calc(19px*var(--s))/1.2 'IBM Plex Sans';letter-spacing:.08em;text-transform:uppercase;color:var(--teal);margin-bottom:calc(10px*var(--s))}
.card .t{font:400 calc(25px*var(--s))/1.35 'IBM Plex Sans';color:#1A2B42}
.stats{display:flex;gap:calc(24px*var(--s));flex-wrap:wrap}
.stat{flex:1 1 0;min-width:30%;border-radius:22px;padding:calc(30px*var(--s)) calc(26px*var(--s));background:linear-gradient(160deg,#0D2140,#17345E);color:#fff;box-shadow:0 12px 30px rgba(13,33,64,.3)}
.stat b{display:block;font:600 calc(64px*var(--s))/1 'Newsreader',serif;color:#7FD3F7;margin-bottom:calc(14px*var(--s))}
.stat span{font:400 calc(24px*var(--s))/1.35 'IBM Plex Sans';color:#E3ECF7}
.cols{display:grid;gap:calc(22px*var(--s))}
.col{border-radius:20px;padding:calc(24px*var(--s));background:#fff;box-shadow:0 8px 26px rgba(13,33,64,.10)}
.col .l{font:600 calc(22px*var(--s))/1.2 'IBM Plex Sans';color:var(--navy);margin-bottom:calc(14px*var(--s));padding-bottom:calc(12px*var(--s));border-bottom:2px solid #DCE6F2}
.col ul.pts li{font-size:calc(25px*var(--s))}
.formula{font:500 calc(40px*var(--s))/1.3 'IBM Plex Mono',monospace;color:var(--ink);background:#fff;border-radius:20px;padding:calc(30px*var(--s));
  text-align:center;box-shadow:0 8px 26px rgba(13,33,64,.10);border-left:6px solid var(--blue)}
pre{font:400 calc(23px*var(--s))/1.45 'IBM Plex Mono',monospace;color:#DDE7F5;background:#0B1830;border-radius:18px;padding:calc(26px*var(--s)) calc(30px*var(--s));
  white-space:pre-wrap;box-shadow:0 12px 30px rgba(6,18,40,.35)}
.note{display:flex;gap:16px;align-items:flex-start;border-radius:16px;padding:calc(18px*var(--s)) calc(22px*var(--s));background:#E4ECF8;color:#173E7A;
  font:500 calc(23px*var(--s))/1.4 'IBM Plex Sans'}
.note.warn{background:#FBEFD9;color:#7A4800}
.hide{visibility:hidden}
"""


def logo_uri() -> str:
    return "data:image/png;base64," + base64.b64encode((assets_dir() / "brand" / "hibilter.png").read_bytes()).decode()


def _doc(body: str, extra_css: str = "", fit: bool = False) -> str:
    js = """<script>
    async function go(){ await document.fonts.ready;
      const f=document.querySelector('.fit'); if(f){ let s=1.6; f.style.setProperty('--s',s);
        while(s>0.55 && (f.scrollHeight>f.clientHeight+1 || f.scrollWidth>f.clientWidth+1)){ s-=0.03; f.style.setProperty('--s',s) } }
      document.body.dataset.ready=1 }
    go()</script>""" if fit else "<script>document.fonts.ready.then(()=>document.body.dataset.ready=1)</script>"
    return f"<!doctype html><html><head><meta charset=utf-8>{FONTS}<style>{CSS}{extra_css}</style></head><body>{body}{js}</body></html>"


def _pts(points, start: int, k: int) -> tuple[str, int]:
    out = []
    for p in points or []:
        out.append(f'<li class="{"" if start < k else "hide"}">{escape(p)}</li>')
        start += 1
    return f'<ul class="pts">{"".join(out)}</ul>', start


def slide_panel(slide: dict, k: int, eyebrow: str) -> str:
    """The chapter slide with the first k elements visible (heading always)."""
    kind = slide.get("kind")
    i, body = 0, ""
    vis = lambda: "" if i < k else "hide"  # noqa: E731
    if kind == "bullets":
        body, i = _pts(slide.get("points"), 0, k)
    elif kind == "steps":
        lis = []
        for x in slide.get("steps") or []:
            sub = f'<span>{escape(x["sub"])}</span>' if x.get("sub") else ""
            lis.append(f'<li class="{vis()}"><span class="n">{i + 1}</span><b>{escape(x["title"])}</b>{sub}</li>')
            i += 1
        body = f'<ol class="steps">{"".join(lis)}</ol>'
    elif kind == "cards":
        cs = []
        for c in slide.get("cards") or []:
            cs.append(f'<div class="card {vis()}"><div class="l">{escape(c["label"])}</div><div class="t">{escape(c["text"])}</div></div>')
            i += 1
        body = f'<div class="cards">{"".join(cs)}</div>'
    elif kind == "stat":
        cs = []
        for c in slide.get("stats") or []:
            cs.append(f'<div class="stat {vis()}"><b>{escape(c["value"])}</b><span>{escape(c["label"])}</span></div>')
            i += 1
        body = f'<div class="stats">{"".join(cs)}</div>'
    elif kind == "compare":
        cols = slide.get("columns") or []
        cs = []
        for c in cols:
            inner = "".join(f"<li>{escape(p)}</li>" for p in c.get("points") or [])
            cs.append(f'<div class="col {vis()}"><div class="l">{escape(c["title"])}</div><ul class="pts">{inner}</ul></div>')
            i += 1
        body = f'<div class="cols" style="grid-template-columns:repeat({min(3, max(1, len(cols)))},1fr)">{"".join(cs)}</div>'
    elif kind in ("formula", "code"):
        blk = (f'<div class="formula {vis()}">{escape(slide.get("formula") or "")}</div>' if kind == "formula"
               else f'<pre class="{vis()}">{escape(slide.get("code") or "")}</pre>')
        i += 1
        pts, i = _pts(slide.get("points"), i, k)
        body = blk + pts
    note = slide.get("note") or {}
    if note.get("text"):
        body += f'<div class="note {"warn" if note.get("tone") == "warn" else ""} {vis()}">{escape(note["text"])}</div>'
    return _doc(f'<div class="panel"><div class="fit"><div class="eyebrow">{escape(eyebrow)}</div>'
                f'<h1>{escape(slide.get("heading") or "")}</h1>{body}</div></div>', fit=True)


def intro_panel(lec: Lecture) -> str:
    objs = "".join(f"<li>{escape(o)}</li>" for o in lec.objectives[:3])
    return _doc(f'''<div class="panel"><div class="fit" style="justify-content:center">
      <div class="eyebrow">{escape(lec.course_code)} · {escape(lec.module)}</div>
      <h1 style="font-size:calc(70px*var(--s))">{escape(lec.title)}</h1>
      <div style="font:500 calc(28px*var(--s))/1.3 'IBM Plex Sans';color:#17345E">with {escape(lec.lecturer.name)}</div>
      {f'<div class="eyebrow" style="margin-top:calc(18px*var(--s));color:#4D5D72">In this lecture</div><ul class="pts">{objs}</ul>' if objs else ''}
    </div></div>''', fit=True)


BACKDROP = """
.bg{position:absolute;inset:0;overflow:hidden;background:
  radial-gradient(900px 600px at 78% 40%,rgba(56,168,240,.35),transparent 60%),
  radial-gradient(700px 500px at 15% 85%,rgba(12,119,115,.35),transparent 60%),
  linear-gradient(135deg,#071021 0%,#0D2140 45%,#17345E 100%)}
.bg i{position:absolute;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,rgba(127,211,247,.9),transparent);
  filter:blur(.5px);box-shadow:0 0 18px rgba(127,211,247,.8);transform:rotate(-24deg)}
"""


def _streaks() -> str:
    return ('<i style="left:-10%;top:30%;width:70%"></i><i style="left:40%;top:78%;width:65%;opacity:.6"></i>'
            '<i style="left:55%;top:12%;width:45%;opacity:.45"></i>')


def chapter_card(lec: Lecture, ci: int, title: str) -> str:
    return _doc(f'''<div class="bg">{_streaks()}</div>
      <div style="position:absolute;left:160px;right:160px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:28px">
        <div style="font:600 26px/1 'IBM Plex Sans';letter-spacing:.2em;text-transform:uppercase;color:#7FD3F7">Chapter {ci + 1}</div>
        <div style="font:600 92px/1.08 'Newsreader',serif;color:#fff;max-width:1400px">{escape(title)}</div>
        <div style="width:160px;height:6px;border-radius:6px;background:linear-gradient(90deg,#0C7773,#1C6FE0,#38A8F0)"></div>
        <div style="font:500 26px/1.3 'IBM Plex Sans';color:#A9B8CC">{escape(lec.course_code)} · {escape(lec.title)}</div>
      </div>
      <img src="{logo_uri()}" style="position:absolute;right:80px;bottom:70px;width:64px;opacity:.95">''', BACKDROP)


def end_card(lec: Lecture) -> str:
    return _doc(f'''<div class="bg">{_streaks()}</div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;text-align:center">
        <img src="{logo_uri()}" style="width:120px">
        <div style="font:600 30px/1 'IBM Plex Sans';letter-spacing:.24em;text-transform:uppercase;color:#fff">Hibilter Virtual Faculty</div>
        <div style="font:600 64px/1.15 'Newsreader',serif;color:#fff;max-width:1400px">{escape(lec.title)}</div>
        <div style="font:500 26px/1.4 'IBM Plex Sans';color:#A9B8CC">Lecture complete · continue with the next item in {escape(lec.course_code)}</div>
        <div style="margin-top:30px;font:400 20px/1.4 'IBM Plex Sans';color:#7F92AA">Presented by {escape(lec.lecturer.name)}, a virtual lecturer. This video is AI-generated.</div>
      </div>''', BACKDROP)


def lower_third(lec: Lecture) -> str:
    return _doc(f'''<div style="position:absolute;left:90px;bottom:96px;display:flex;align-items:stretch;border-radius:14px;overflow:hidden;
        box-shadow:0 18px 40px rgba(4,12,28,.45)">
        <div style="width:10px;background:linear-gradient(180deg,#38A8F0,#0C7773)"></div>
        <div style="background:rgba(10,26,51,.92);padding:20px 34px 20px 26px">
          <div style="font:600 40px/1.1 'Newsreader',serif;color:#fff">{escape(lec.lecturer.name)}</div>
          <div style="font:500 22px/1.3 'IBM Plex Sans';color:#9FD8F5;margin-top:6px">Virtual lecturer · {escape(lec.lecturer.subject)}</div>
        </div></div>''')


def bug() -> str:
    return _doc(f'''<div style="position:absolute;right:56px;top:46px;display:flex;align-items:center;gap:14px;padding:10px 18px 10px 12px;
        border-radius:12px;background:rgba(255,255,255,.88);box-shadow:0 6px 20px rgba(4,12,28,.25)">
        <img src="{logo_uri()}" style="width:40px">
        <div><div style="font:700 19px/1 'IBM Plex Sans';letter-spacing:.16em;color:#0A1A33">HIBILTER</div>
        <div style="font:500 14px/1.3 'IBM Plex Sans';color:#4D5D72;margin-top:3px">Virtual Faculty · AI-generated</div></div></div>''')


def stage_draft(lec: Lecture) -> str:
    """Draft-only stand-in for the generated stage keyframe: studio backdrop + the portrait on the right third."""
    uri = "data:image/png;base64," + base64.b64encode(lec.lecturer.portrait.read_bytes()).decode()
    return _doc(f'''<div class="bg">{_streaks()}</div>
      <div style="position:absolute;right:0;top:0;width:820px;height:1080px;background:url({uri}) 50% 30%/auto 1080px no-repeat;
        -webkit-mask-image:linear-gradient(90deg,transparent,#000 30%)"></div>''', BACKDROP)


class Renderer:
    def __init__(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(args=["--font-render-hinting=none"])

    def png(self, html: str, out: Path, w: int = W, h: int = H, transparent: bool = True) -> Path:
        out.parent.mkdir(parents=True, exist_ok=True)
        page = self._browser.new_page(viewport={"width": w, "height": h})
        try:
            page.set_content(html, wait_until="networkidle")
            page.wait_for_selector("body[data-ready]", state="attached", timeout=30000)
            page.screenshot(path=str(out), omit_background=transparent)
        finally:
            page.close()
        return out

    def close(self):
        self._browser.close()
        self._pw.stop()
