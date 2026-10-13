import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from sqlalchemy import text
from starlette.responses import Response

from .classroom.router import router as vf_router
from .core.config import get_settings
from .core.db import engine
from .routers.auth import router as auth_router

log = logging.getLogger("uom")
REQS = Counter("http_requests_total", "Requests", ["method", "route", "status"])
LAT = Histogram("http_request_seconds", "Latency", ["route"])

app = FastAPI(title="UoM Learning API", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
s = get_settings()
if s.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins.split(","), allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def metrics_and_headers(request: Request, call_next):
    t0 = time.perf_counter()
    try:
        resp = await call_next(request)
    except Exception:
        log.exception("unhandled")
        resp = JSONResponse({"detail": "Something went wrong on our side. Try again."}, status_code=500)
    route = request.scope.get("route")
    path = getattr(route, "path", "unmatched")
    REQS.labels(request.method, path, resp.status_code).inc()
    LAT.labels(path).observe(time.perf_counter() - t0)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


@app.get("/api/health")
async def health():
    async with engine.connect() as c:
        await c.execute(text("select 1"))
    return {"ok": True}


@app.get("/api/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


app.include_router(auth_router)
app.include_router(vf_router)
