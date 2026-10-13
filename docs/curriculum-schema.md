# Course curriculum files — `backend/app/seed/curriculum/<course_id>.json`

One JSON file per course holds the whole table of contents **and** the real teaching content of every item.
The loader (`python -m app.seed.curriculum`) upserts modules, virtual-faculty lessons, quizzes and assignments from these files;
the render worker voices every spoken line with the course's virtual lecturer. Validate with
`python3 tools/validate_curriculum.py backend/app/seed/curriculum/<id>.json` (must print `OK`).

All content is synthetic teaching material for a University of Mauritius concept platform. Write accurate, university-level
content (first/second-year undergraduate unless the course says otherwise), British English, with Mauritian / small-island
examples where natural (sugar cane, tourism, lagoons, CEB electricity, Port Louis, cyclones, the EEZ…). Never invent named
real people, real statistics presented as fact, or claims about the real University; use round illustrative figures and say so.

## Top level
```json
{
  "course": "c2",
  "presenter": "arjun",                // the course's virtual lecturer id (given to you) — narrates every video lesson
  "modules": [ { "id": "m1", "title": "Module 1 · <title>", "items": [ ...items ] }, ... ]
}
```
4 modules, 2–4 items each, 10–13 items total. Item ids: `<course>-L<n>` numbered across the course (`c2-L1`…), except
course c1 which keeps `L1`…`L10`. Every module mixes types; the course must have exactly **one** `virtual` item (in module 1 or 2),
4–5 `video`, 3–4 `reading`, 2 `quiz`, 1 `assignment` (c1 already has its assessments — see the c1 brief).

## Item types
Common fields: `id`, `type`, `title` (≤ 90 chars), `dur` (minutes, integer), `objectives` (3–4 short outcome statements,
except quiz/assignment), `chips` (3 short questions a student might ask the study assistant about this item).

### `video` — narrated lecture (voiced and lip-synced by the virtual lecturer, slides on screen)
```json
{ "id": "c2-L2", "type": "video", "title": "...", "dur": 8, "objectives": [...], "chips": [...],
  "chapters": [ { "title": "Chapter title", "slide": <slide>, "narration": ["sentence or two", "..."] }, ... ] }
```
4–6 chapters; each chapter 3–6 narration lines; each line 1–2 sentences, 12–40 words. Total 750–1,100 words.
`dur` = round(total words / 140). Narration is **spoken aloud by TTS**: write as a lecturer talks — first person, warm, clear,
no markdown, no bullet symbols, no arrows/emoji, no parentheses-heavy text, no URLs; write numbers the way they are said when
ambiguous ("about two hundred and fifty kilowatt-hours" is fine, "250 kWh" is also fine); avoid unexplained abbreviations.
The first chapter opens the topic (no "welcome to the course" boilerplate); the last chapter recaps in 2–3 lines.

### `reading`
```json
{ "id": "c2-L3", "type": "reading", "title": "...", "dur": 15, "objectives": [...], "chips": [...], "body": "<markdown>" }
```
900–1,500 words. Markdown subset only: `## ` / `### ` headings, paragraphs, `- ` and `1. ` lists, `**bold**`, `*italic*`,
`` `code` ``, fenced code blocks (```` ```python ```` — only where the course is technical), simple pipe tables, `> ` call-outs.
Structure: short intro → 3–5 `##` sections (at least one worked example / case box) → `## Key takeaways` (4–6 bullets) →
`## Check your understanding` (3 numbered questions, each followed by `*Answer:* …` on the next line). `dur` = round(words/180)+3.

### `virtual` — interactive virtual-faculty lesson (the flagship item; same schema as the existing L1)
```json
{ "id": "c2-L1", "type": "virtual", "title": "...", "dur": 20, "objectives": [3 items], "chips": [...],
  "lesson": {
    "summary": ["key idea 1", "key idea 2", "key idea 3"],          // shown on the final slide
    "segments": [ <segment>, <segment>, <segment> ],                   // exactly 3
    "closing": ["Excellent work today, {name}.", "Let me summarise…", "...", "..."]   // 4–5 lines; {name} only in line 1
  } }
```
Segment:
```json
{ "id": "seg1", "title": "...", "slide": <slide>,
  "speech":  [4 lines, 1–2 sentences each — the teaching],
  "simpler": [3 lines — the same idea re-explained very simply with an everyday analogy],
  "checkpoint": {
    "id": "cp1", "mandatory": true, "maxAttempts": 3,
    "question": "one open question answerable in 1–2 sentences",
    "concepts": [ { "id": "short_id", "label": "what a good answer must express", "required": true,
                    "rx": [ { "re": "<regex>", "flags": "i" }, ... ] }, ... ],      // 2 required + 1–2 optional
    "misconceptions": [ { "id": "short_id", "label": "...", "rx": [ ... ] } ],      // 0–2 common wrong ideas
    "hints": [3 escalating hints, the last almost gives the answer],
    "model": "a model answer (1–2 sentences)",
    "reteach": "a different explanation with a fresh analogy (2–3 sentences)",
    "calibration": [ { "answer": "...", "expected": "correct|partial|incorrect|unclear" }, ... ]   // 10 per checkpoint
  } }
```
seg1 and seg2 checkpoints are `mandatory: true, maxAttempts: 3`; seg3 is optional: `mandatory: false, maxAttempts: 2`
and its question starts with "Optional check: ".

**Answer-checking rules (important — this rubric is the live grader when the LLM is unavailable).**
Verdict policy: `correct` = every *required* concept found and no misconception; `partial` = some concept found but not all
required; `incorrect` = nothing found (or a misconception with required concepts missing); `unclear` = "I don't know",
gibberish, or < 3 words with nothing found. A misconception with id `same` or `reversed` downgrades `correct` to `partial`.
- Regexes run with Python `re` (case-insensitive) **and** JavaScript — use only the common subset: no look-behind,
  no named groups, no possessive/atomic groups, no `\A`/`\Z`. Escape backslashes for JSON (`"\\b"`).
- Each concept gets 2–5 alternative patterns covering the different ways students actually phrase the idea
  (synonyms, word order, British/American spelling, singular/plural, common abbreviations). Prefer `\b(word1|word2)\w*`
  stems and bounded gaps like `[^.]{0,50}` over exact phrases. Do not make patterns so loose that unrelated answers match.
- 10 calibration answers per checkpoint written like real first-year students (varied length, informal, some typos):
  4 correct (different phrasings), 3 partial (one required concept missing), 2 incorrect (wrong idea / misconception),
  1 unclear ("idk", "not sure tbh"). The validator grades them with the rubric — **all 10 must agree** with `expected`.

### `quiz`
```json
{ "id": "c2-L6", "type": "quiz", "title": "Quiz 1: ...", "dur": 15,
  "quiz": { "time": 15, "weight": 5, "questions": [ { "q": "...", "o": ["A","B","C","D"], "a": 1, "ex": "why" } ] } }
```
6–8 multiple-choice questions on the preceding items; 4 options; `a` = 0-based index of the correct option (vary its position);
plausible distractors; `ex` explains the right answer in one sentence. Mix recall, application and scenario questions.

A quiz or assignment that already exists as an assessment is linked instead: `{ "id": "L6", "type": "quiz", "title": "…", "dur": 15, "assessment": "as1" }`.

### `assignment`
```json
{ "id": "c2-L9", "type": "assignment", "title": "Assignment: ...", "dur": 120,
  "assignment": { "weight": 25, "max": 100, "brief": "<task, deliverables, word limit, data provided>",
                  "rubric": [ { "criterion": "...", "max": 30, "desc": "what earns full marks" }, ... ] } }   // 4–5 criteria summing to max
```

## Slides (`slide` in video chapters and virtual segments)
One object; pick the kind that best fits the chapter. All text short (headings ≤ 60 chars, points ≤ 90 chars).
- `{"kind":"bullets","heading":"…","points":["…", "…"]}` — 3–5 points
- `{"kind":"steps","heading":"…","steps":[{"title":"…","sub":"…"}]}` — a process / pipeline, 3–5 steps
- `{"kind":"compare","heading":"…","columns":[{"title":"…","points":["…"]},{"title":"…","points":["…"]}]}` — 2–3 columns
- `{"kind":"cards","heading":"…","cards":[{"label":"…","text":"…"}]}` — 2–6 examples / categories
- `{"kind":"stat","heading":"…","stats":[{"value":"…","label":"…"}]}` — 2–4 big numbers (illustrative; say so in a note)
- `{"kind":"formula","heading":"…","formula":"LCOE = total lifetime cost / total lifetime energy","points":["…"]}`
- `{"kind":"code","heading":"…","lang":"python","code":"df = pd.read_csv('arrivals.csv')\n…","points":["…"]}` (technical courses only; ≤ 12 lines)
Any slide may add `"note": {"tone":"info"|"warn","text":"…"}`.
