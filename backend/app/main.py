import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.auth import require_admin
from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting RCA COE Tracker API...")
    yield
    # Give in-flight fire-and-forget work (Slack DMs, AI summaries, enrich) a
    # brief window to finish before the event loop tears down, so we don't drop
    # notifications/summaries mid-send on a rollout.
    import asyncio

    from app.services import ai_summary, notify, user_enrich

    pending = [
        *notify._background_tasks,
        *ai_summary._background_tasks,
        *user_enrich._background_tasks,
    ]
    if pending:
        logger.info("Awaiting %d in-flight background task(s) before shutdown...", len(pending))
        try:
            await asyncio.wait(pending, timeout=10)
        except Exception:
            logger.exception("error while draining background tasks")

    from app.database import engine
    await engine.dispose()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="RCA COE Tracker",
    version="0.1.0",
    lifespan=lifespan,
)

# Browsers forbid credentialed requests with a wildcard origin, and a
# credentialed wildcard is a CSRF-adjacent footgun. So only enable credentials
# when the origins are an explicit allow-list (never "*").
_cors_origins = settings.cors_origin_list
_cors_allow_credentials = bool(_cors_origins) and "*" not in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_allow_credentials,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

from app.api import me, users, rcas, admin_users  # noqa: E402

app.include_router(me.router)
app.include_router(users.router)
app.include_router(rcas.router)
app.include_router(admin_users.router)


@app.get("/api/health")
async def health():
    from app.database import async_session_maker
    try:
        async with async_session_maker() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Health check DB probe failed: {e}")
        return JSONResponse(status_code=503, content={"status": "unhealthy"})


@app.get("/api/version")
async def version():
    return {
        "version": settings.app_version,
        "commit": settings.app_commit,
        "ai_model": settings.ai_model,
        "ai_fast_model": settings.ai_fast_model,
    }


_LOGGED_OUT_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="theme-color" content="#1D4ED8">
  <title>Signed out · RCA Tracker</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      -webkit-font-smoothing: antialiased;
      background: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #0f172a;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 1px 0 rgba(15,23,42,0.04), 0 8px 24px -8px rgba(15,23,42,0.16), 0 18px 48px -12px rgba(15,23,42,0.12);
      border: 1px solid rgba(226,232,240,0.7);
      padding: 36px 32px;
      max-width: 380px;
      width: 100%;
      text-align: center;
      animation: fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes fade-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .icon-wrap {
      width: 56px; height: 56px;
      margin: 0 auto 18px;
      border-radius: 14px;
      background: linear-gradient(135deg, #60A5FA, #1D4ED8);
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 16px -4px rgba(29,78,216,0.35);
    }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
    p { font-size: 13.5px; color: #64748b; line-height: 1.55; margin: 0 0 22px; }
    a.btn {
      display: inline-flex; align-items: center; gap: 7px;
      background: #2563eb; color: #ffffff; text-decoration: none;
      padding: 10px 20px; border-radius: 10px;
      font-size: 14px; font-weight: 500;
      transition: all 0.15s ease;
      box-shadow: 0 1px 2px rgba(37,99,235,0.2);
    }
    a.btn:hover { background: #1d4ed8; transform: translateY(-1px); box-shadow: 0 4px 10px -2px rgba(37,99,235,0.35); }
    a.btn:active { transform: scale(0.97); }
    .meta { font-size: 11px; color: #94a3b8; margin-top: 18px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="icon-wrap">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
    </div>
    <h1>You've been signed out</h1>
    <p>Your session has been cleared. Click below to sign back in to RCA Tracker.</p>
    <a class="btn" href="/">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
        <polyline points="10 17 15 12 10 7"/>
        <line x1="15" y1="12" x2="3" y2="12"/>
      </svg>
      Log in again
    </a>
    <p class="meta">RCA Tracker</p>
  </main>
</body>
</html>"""


@app.get("/logged-out", response_class=HTMLResponse, include_in_schema=False)
async def logged_out():
    """Static signed-out landing page. Pomerium has a public route to this
    path so an unauthenticated browser still gets a friendly UI after a
    sign-out instead of bouncing on Pomerium's home page."""
    return HTMLResponse(_LOGGED_OUT_HTML)


@app.get("/api/_debug/headers")
async def debug_headers(request: Request, _admin=Depends(require_admin)):
    """Echo proxy-relevant headers + decoded JWT claims so we can see what
    the upstream proxy is actually sending. Admin-only: it surfaces identity
    claims, so it must not be reachable by non-admins even if a proxy route
    rule is ever misconfigured."""
    from app.auth import _decode_jwt_claims

    interesting: dict[str, str] = {}
    jwt_token: str | None = None
    for k, v in request.headers.items():
        kl = k.lower()
        if kl.startswith(("x-pomerium", "x-forwarded", "x-auth-request", "x-real-ip")):
            interesting[k] = v if len(v) <= 256 else v[:256] + "…"
        if kl in ("x-pomerium-jwt-assertion", "x-pomerium-assertion"):
            jwt_token = v

    claims: dict | None = None
    if jwt_token:
        decoded = _decode_jwt_claims(jwt_token)
        if decoded:
            # Redact noisy / sensitive raw values; keep keys + scalar values for shape.
            claims = {
                k: (v if not isinstance(v, str) or len(v) <= 256 else v[:256] + "…")
                for k, v in decoded.items()
            }

    return {"headers": interesting, "jwt_claims": claims}


_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.exists():
    app.mount("/assets", StaticFiles(directory=str(_static_dir / "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        file_path = _static_dir / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(_static_dir / "index.html"))
