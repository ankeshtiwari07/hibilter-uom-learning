import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.core.deps import owner_id, require, trial_expired


def _u(**kw):
    base = dict(id="u1", role="lecturer", acts_for=None, expires_at=None, status="active")
    return SimpleNamespace(**{**base, **kw})


def test_trial_expiry():
    now = datetime.now(timezone.utc)
    assert not trial_expired(_u())
    assert not trial_expired(_u(expires_at=now + timedelta(days=1)))
    assert trial_expired(_u(expires_at=now - timedelta(seconds=1)))


def test_owner_id_mirrors():
    assert owner_id(_u()) == "u1"
    assert owner_id(_u(acts_for="lect9")) == "lect9"


def _call(user, method):
    dep = require("lecturer", "admin")
    return asyncio.run(dep(request=SimpleNamespace(method=method), user=user))


def test_mirror_lecturer_is_view_only():
    m = _u(acts_for="lect9")
    assert _call(m, "GET") is m
    with pytest.raises(HTTPException) as e:
        _call(m, "POST")
    assert e.value.status_code == 403
    assert _call(_u(), "POST").id == "u1"  # real lecturers unaffected


def test_role_still_enforced():
    with pytest.raises(HTTPException) as e:
        _call(_u(role="student"), "GET")
    assert e.value.status_code == 403
