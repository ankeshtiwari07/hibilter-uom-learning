#!/usr/bin/env python3
"""Validate a course curriculum file against docs/curriculum-schema.md and grade every checkpoint's calibration answers
with the live rubric engine + lecturer policy. Usage: python3 tools/validate_curriculum.py backend/app/seed/curriculum/c2.json [...]"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, rel: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rubric = _load("rubric", "backend/app/evaluation/rubric.py")
policy = _load("policy", "backend/app/evaluation/policy.py")

SLIDE_KINDS = {"bullets", "steps", "compare", "cards", "stat", "formula", "code"}
BAD_RX = [r"\(\?<[=!]", r"\(\?P", r"\(\?>", r"\\A", r"\\Z", r"\*\+", r"\+\+"]
TTS_BAD = re.compile(r"[→←⇒•✓✔*#`_\[\]{}<>|]|https?://")


def words(s: str) -> int:
    return len(re.findall(r"[A-Za-zÀ-ÿ0-9']+", s))


def check(path: str) -> list[str]:
    errs, warns = [], []
    E = errs.append
    d = json.loads(Path(path).read_text())
    cid = d.get("course")
    if not cid or not d.get("presenter"):
        E("missing course/presenter")
    mods = d.get("modules") or []
    if not 3 <= len(mods) <= 5:
        E(f"expected 4 modules, got {len(mods)}")
    items = [i for m in mods for i in m.get("items", [])]
    ids = [i.get("id") for i in items]
    if len(ids) != len(set(ids)):
        E("duplicate item ids")
    types = [i.get("type") for i in items]
    if types.count("virtual") != 1:
        E(f"need exactly one virtual item, got {types.count('virtual')}")
    all_rx: list[str] = []

    def slide(s, where):
        if not isinstance(s, dict) or s.get("kind") not in SLIDE_KINDS:
            E(f"{where}: bad slide {str(s)[:80]}")
            return
        k = s["kind"]
        need = {"bullets": "points", "steps": "steps", "compare": "columns", "cards": "cards", "stat": "stats", "formula": "formula", "code": "code"}[k]
        if not s.get(need) or not s.get("heading"):
            E(f"{where}: slide {k} needs heading + {need}")

    for m in mods:
        if not m.get("id") or not m.get("title"):
            E("module missing id/title")
        for it in m.get("items", []):
            w = it.get("id", "?")
            t = it.get("type")
            if not it.get("title") or not isinstance(it.get("dur"), int):
                E(f"{w}: title/dur")
            if t in ("video", "reading", "virtual") and not (3 <= len(it.get("objectives") or []) <= 5):
                E(f"{w}: objectives 3–4")
            if t in ("video", "reading", "virtual") and len(it.get("chips") or []) < 2:
                E(f"{w}: chips")
            if t == "video":
                ch = it.get("chapters") or []
                if not 3 <= len(ch) <= 7:
                    E(f"{w}: chapters {len(ch)}")
                n = 0
                for j, c in enumerate(ch):
                    slide(c.get("slide"), f"{w} ch{j + 1}")
                    for line in c.get("narration") or []:
                        n += words(line)
                        if TTS_BAD.search(line):
                            E(f"{w} ch{j + 1}: TTS-unfriendly characters in: {line[:70]}")
                        if words(line) > 55:
                            warns.append(f"{w}: long line ({words(line)} words)")
                if not 600 <= n <= 1300:
                    E(f"{w}: narration {n} words (want 750–1100)")
            elif t == "reading":
                b = it.get("body") or ""
                n = words(b)
                if not 800 <= n <= 1800:
                    E(f"{w}: reading {n} words (want 900–1500)")
                for h in ("## Key takeaways", "## Check your understanding"):
                    if h not in b:
                        E(f"{w}: reading missing '{h}'")
            elif t in ("quiz", "assignment") and it.get("assessment"):
                pass  # linked to an existing assessment row
            elif t == "quiz":
                q = it.get("quiz") or {}
                qs = q.get("questions") or []
                if not 5 <= len(qs) <= 10:
                    E(f"{w}: quiz questions {len(qs)}")
                for k, x in enumerate(qs):
                    if len(x.get("o") or []) != 4 or not isinstance(x.get("a"), int) or not 0 <= x["a"] < 4 or not x.get("q") or not x.get("ex"):
                        E(f"{w}: quiz q{k + 1} malformed")
                if qs and len({x.get("a") for x in qs}) == 1:
                    E(f"{w}: correct option always in the same position")
            elif t == "assignment":
                a = it.get("assignment") or {}
                r = a.get("rubric") or []
                if not a.get("brief") or not r:
                    E(f"{w}: assignment brief/rubric")
                elif sum(x.get("max", 0) for x in r) != a.get("max", 100):
                    E(f"{w}: rubric maxima sum {sum(x.get('max', 0) for x in r)} != {a.get('max', 100)}")
            elif t == "virtual":
                L = it.get("lesson") or {}
                segs = L.get("segments") or []
                if len(segs) != 3:
                    E(f"{w}: need 3 segments")
                if not L.get("closing") or not L.get("summary"):
                    E(f"{w}: closing/summary")
                for j, s in enumerate(segs):
                    sw = f"{w} {s.get('id')}"
                    slide(s.get("slide"), sw)
                    for line in (s.get("speech") or []) + (s.get("simpler") or []) + (L.get("closing") or []):
                        if TTS_BAD.search(line.replace("{name}", "")):
                            E(f"{sw}: TTS-unfriendly characters in: {line[:70]}")
                    if len(s.get("speech") or []) < 3 or len(s.get("simpler") or []) < 2:
                        E(f"{sw}: speech/simpler too short")
                    cp = s.get("checkpoint") or {}
                    if not cp.get("question") or not cp.get("model") or not cp.get("reteach") or len(cp.get("hints") or []) < 1:
                        E(f"{sw}: checkpoint text fields")
                    concepts = cp.get("concepts") or []
                    if sum(1 for c in concepts if c.get("required")) < 1:
                        E(f"{sw}: no required concept")
                    for c in concepts + (cp.get("misconceptions") or []):
                        for r in c.get("rx") or []:
                            src = r.get("re", "")
                            all_rx.append(src)
                            try:
                                re.compile(src, re.I)
                            except re.error as e:
                                E(f"{sw} {c.get('id')}: regex error {e}: {src}")
                            for b in BAD_RX:
                                if re.search(b, src):
                                    E(f"{sw} {c.get('id')}: non-portable regex construct {b}: {src}")
                        if not c.get("rx"):
                            E(f"{sw} {c.get('id')}: no rx")
                    cal = cp.get("calibration") or []
                    if len(cal) < 8:
                        E(f"{sw}: calibration {len(cal)} (want 10)")
                    agree = 0
                    for smp in cal:
                        try:
                            v = policy.apply_policy(cp, rubric.rubric_eval(cp, smp["answer"]))["verdict"]
                        except Exception as e:  # malformed checkpoint
                            E(f"{sw}: grading crashed: {e}")
                            break
                        if v == smp["expected"]:
                            agree += 1
                        else:
                            E(f"{sw}: calibration mismatch — expected {smp['expected']}, rubric says {v}: \"{smp['answer']}\"")
                    if cal:
                        print(f"  {sw}: calibration {agree}/{len(cal)}")
                    model_v = policy.apply_policy(cp, rubric.rubric_eval(cp, cp.get("model", "")))["verdict"] if concepts else None
                    if model_v != "correct":
                        E(f"{sw}: model answer graded {model_v}")
            else:
                E(f"{w}: unknown type {t}")
    # JavaScript compile check
    if all_rx and shutil.which("node"):
        js = "const a=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const s of a){try{new RegExp(s,'i')}catch(e){console.log('JSERR '+s+' :: '+e.message)}}"
        out = subprocess.run(["node", "-e", js], input=json.dumps(all_rx), capture_output=True, text=True).stdout
        for line in out.splitlines():
            E(f"regex fails in JavaScript: {line}")
    for x in warns[:10]:
        print("  warn:", x)
    return errs


if __name__ == "__main__":
    bad = 0
    for p in sys.argv[1:]:
        print(p)
        es = check(p)
        for e in es:
            print("  ERROR:", e)
        bad += len(es)
        print("  OK" if not es else f"  {len(es)} error(s)")
    sys.exit(1 if bad else 0)
