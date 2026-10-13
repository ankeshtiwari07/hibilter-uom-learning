"""End-to-end classroom smoke test against a running API (rubric engine)."""
import sys
import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
c = httpx.Client(base_url=BASE, timeout=30)
r = c.post("/api/auth/login", json={"email": "sagar.ramdin@demo.student.example", "password": "Demo-UoM-2026!"})
assert r.status_code == 200, r.text
csrf = c.cookies.get("uom_csrf")
H = {"x-csrf": csrf}
s = c.post("/api/vf/sessions", json={"lesson_id": "L1", "avatar_id": "henri"}, headers=H).json()
print("start", s["state"], s["version"])


def act(a, **p):
    global s
    r = c.post(f"/api/vf/sessions/{s['id']}/actions", json={"action": a, "version": s["version"], "payload": p}, headers=H)
    body = r.json()
    if r.status_code >= 500 or ("session" not in body and r.status_code != 200): print(a, r.status_code, body); raise SystemExit(1)
    s = body.get("session", body) if r.status_code != 200 else body
    print(f"{a:14} {r.status_code} -> {s['state']:20} say={len(s['say'])} {s.get('blocked') or ''} {(s.get('result') or {}).get('verdict', '')}")
    return r.status_code


act("start", hour=10)
act("welcomed")
act("taught")
act("asked")
act("answer", text="Machine learning is when computers learn from data.", engine="rubric", idempotency_key="k1")
act("feedback_done")
assert act("continue") == 422  # locked: partial on a mandatory checkpoint
act("hint")
act("answer", text="ML is a subset of AI where systems learn patterns from data.", engine="rubric", idempotency_key="k2")
act("feedback_done")
act("continue")
assert s["seg"] == 1
act("pause", sent=1)
act("resume")
act("taught"); act("asked")
act("answer", text="", engine="rubric")
act("answer", text="x", engine="rubric", simulate_failure=True, idempotency_key="k3")
assert s["state"] == "ERROR_RECOVERY"
act("back_to_answer")
act("answer", text="The labels tell the model the right answer for each example so it can check its predictions.", engine="rubric", idempotency_key="k4")
act("feedback_done"); act("continue")
act("taught"); act("asked")
act("skip")
assert s["state"] == "COMPLETED", s["state"]
print("trace:", " → ".join(s["trace"]))
# stale version → 409
r = c.post(f"/api/vf/sessions/{s['id']}/actions", json={"action": "repeat", "version": 0, "payload": {}}, headers=H)
print("stale version", r.status_code)
# no CSRF → 403
r = c.post(f"/api/vf/sessions/{s['id']}/actions", json={"action": "repeat", "payload": {}})
print("no csrf", r.status_code)
print("OK")
