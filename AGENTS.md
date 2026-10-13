# UoM Learning — engineering conventions

Production prototype → MVP of the Hibilter × University of Mauritius "Virtual Faculty" LMS.
Source of truth for screen content/behaviour: `docs/reference/concept-demo.html` (the original single-file concept demo,
images stripped). Each screen is a `reg({ n: <no>, id: '<screen-id>', ... render: () => ... })` block in that file, plus its
`SPEC[<no>]` entry (purpose, components, actions, validation, states, acceptance criteria) near the "Engineering handoff" section.
**Port the screen faithfully (same sections, copy, interactions), but backed by real APIs and the database — no in-browser fake state.**

## Stack
- `backend/` FastAPI (Python 3.12, async SQLAlchemy 2, Postgres 16, Redis). App package `app`.
- `frontend/` React 18 + TypeScript + Vite + react-router 6 + @tanstack/react-query 5. Design system = the demo's CSS (`src/styles/app.css`) — use its classes (`card`, `kpi`, `btn pri|teal|ghost|sm`, `b good|warn|bad|info|teal|gold|out`, `tbl-wrap` + `table.t`, `g g2|g3|g4|g-21`, `row`, `col`, `list`/`li`, `note`, `tabs`, `field`/`inp`, `ccard` + `cv-1..6`, `cal`, `qopt`, `chat`/`msg`, …). No new CSS frameworks; small additions go in `src/styles/extra.css`.
- Shared UI: `src/components/ui.tsx` (Badge, AiTag, Card, Kpi, Bar, Ring, Avatar, Empty, Note, Loading, ErrorBox, PageHead, Tabs, Seg, Switch, Field, Modal, useToast, LineChart, HBars, VBars), `src/components/Icon.tsx` (`<Icon n="..."/>`, names in `src/lib/icons.ts`).
- API client: `src/lib/api.ts` (`get`, `post`, `put`, `patch`, `del`, `download`; throws `ApiError` with `.status`, `.message`). Auth: `useAuth()` from `src/lib/auth.tsx` (`me`, `setPrefs`).

## Running (shared dev stack — already up)
- API (hot reload, source bind-mounted): http://127.0.0.1:8001/api/... — docs at /api/docs. Through nginx: http://127.0.0.1:8150.
- Web (Vite dev server, hot reload): http://127.0.0.1:5173 (proxies /api, /assets).
- Demo logins (password `Demo-UoM-2026!`): student `sagar.ramdin@demo.student.example`, lecturer `m.lallchand@demo.uom.example`, admin `admin@demo.uom.example`. Other students: `GET /api/...` or the seed data in `backend/app/seed/demo_data.json`.
- API calls from scripts need the session cookie + `x-csrf` header equal to the `uom_csrf` cookie for non-GET requests (see `tools/smoke_classroom.py`).
- Typecheck frontend: `cd frontend && npx tsc -b`. Python syntax check: `docker compose -f deploy/docker-compose.yml exec -T api python -c "import app.routers.<module>"`. Logs: `docker compose -f deploy/docker-compose.yml logs api --tail 50`.
- Do NOT run `docker compose up/down/build` or restart containers — other engineers share the stack. Do not modify `deploy/`.

## Ownership rules (parallel work — avoid collisions)
- Backend: put your endpoints in NEW files `backend/app/routers/<area>_<topic>.py`, each exporting `router = APIRouter(prefix="/api/<area>", ...)`. They are auto-registered by `main.py`; a module that fails to import is skipped and logged, so check the logs.
  - student → prefix `/api/student/...`, files `routers/student_*.py`; lecturer → `/api/lecturer/...`, `routers/lecturer_*.py`; admin → `/api/admin/...`, `routers/admin_*.py`. Shared read endpoints that several portals need may live in your area; don't edit other areas' files.
- Frontend: only edit the page files you own (`src/pages/student/*`, `src/pages/lecturer/*`, `src/pages/admin/*`, `src/pages/common/*`). Routes already exist in `src/routes.tsx` and point at these files — don't edit `routes.tsx`, `App.tsx`, `Shell.tsx`, `ui.tsx`, `api.ts`, `auth.tsx`, or the classroom. If you need a shared helper, create it inside your own folder.
- **Database schema is frozen** (`backend/app/models.py`, migrations). Do not add tables/columns or migrations. Use existing JSON columns (`Course.meta`, `Assessment.settings/questions/rubric`, `User.prefs/risk`, `Event.payload`, `Setting.value`, `Submission.answers`) for extra data. If something is truly impossible without a schema change, stop and report it.
- Never edit `classroom/*`, `evaluation/*`, `core/*`, `seed/*`, `main.py`.

## Quality bar (production grade)
- Every mutation: role check (`Depends(require("lecturer"))` etc. from `app.core.deps`), ownership check (lecturer only their courses; student only own data/enrolled courses), input validation with pydantic (lengths/ranges), and an audit entry for grade/content/access/export/settings changes (`from app.core.audit import audit`; `await audit(db, user, "Published grades", "grade", "<object>", reason=...)`).
- Viewing an individual student's record as staff in admin screens requires a reason that is audited (see demo SPEC for a-directory).
- Every screen handles loading (`<Loading/>`), empty (`<Empty/>`), error (`<ErrorBox/>`) and success (toast) states and is usable at 400px width. Forms show inline validation errors. Buttons that mutate are disabled while pending.
- AI-generated content is always labelled (`<AiTag/>`). AI never sets official grades.
- CSV exports stream from the API (`text/csv`, `Content-Disposition`) and are audited.
- Keep copy plain and specific. No lorem ipsum. Synthetic data only.
- Timestamps: API returns ISO strings; format with `src/lib/format.ts`.
