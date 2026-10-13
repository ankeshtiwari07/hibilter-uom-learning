"""Lecturer policy: turns concept evidence into a verdict. The LLM never decides progression (LLD §6.3)."""
POLICY_VERSION = "v1"


def apply_policy(cp: dict, raw: dict, threshold: str = "required") -> dict:
    ids = [c["id"] for c in cp["concepts"]]
    req = [c["id"] for c in cp["concepts"] if c.get("required")]
    found = [i for i in raw["found"] if i in ids]
    missing = [i for i in ids if i not in found]
    mis_ids = {m["id"] for m in cp.get("misconceptions", [])}
    mis = [m for m in raw.get("mis", []) if m in mis_ids]
    req_ok = all(i in found for i in req)
    all_ok = not missing
    if raw.get("unclear") and not found:
        verdict = "unclear"
    elif (all_ok if threshold == "all" else req_ok) and not mis:
        verdict = "correct"
    elif found:
        verdict = "partial"
    else:
        verdict = "incorrect"
    if "reversed" in mis or "same" in mis:
        verdict = "partial" if (found and req_ok) else "incorrect"
    return {"verdict": verdict, "found": found, "missing": missing, "mis": mis, "engine": raw.get("engine", "rubric"),
            "confidence": raw.get("confidence", "high"), "ai_feedback": raw.get("ai_feedback"), "policy": POLICY_VERSION}
