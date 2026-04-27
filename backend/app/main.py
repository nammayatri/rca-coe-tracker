import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

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
    from app.database import engine
    await engine.dispose()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="RCA COE Tracker",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
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


@app.get("/api/_debug/headers")
async def debug_headers(request: Request):
    """Echo proxy-relevant headers so we can see what the upstream proxy
    actually sends. Unauthenticated by design — this is only reachable
    behind the trusted proxy."""
    interesting = {}
    for k, v in request.headers.items():
        kl = k.lower()
        if kl.startswith(("x-pomerium", "x-forwarded", "x-auth-request", "x-real-ip")):
            interesting[k] = v if len(v) <= 256 else v[:256] + "…"
    return {"headers": interesting}


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
