"""
Blue Origin - FastAPI entry point.

Run:  uvicorn app.main:app --reload --port 8000
Docs: http://localhost:8000/docs   (Swagger)   |   http://localhost:8000/redoc
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.repositories import get_repository
from app.services.sync_service import scheduler


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    # Automatic pipeline: poll the Dropbox inbox in the background (SYNC_INTERVAL_MINUTES, 0 = off)
    scheduler.start(get_repository, settings)
    yield
    scheduler.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=settings.LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        description="Sales & Retailer Growth Management Platform - backend API. "
                    "Dropbox is the data store: BO Excel/CSV files are uploaded, validated and stored there.",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url=f"{settings.API_PREFIX}/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    app.add_middleware(GZipMiddleware, minimum_size=2048)  # large tables / the deliverables payload
    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.API_PREFIX)

    @app.get("/", include_in_schema=False)
    def root():
        return {"app": settings.APP_NAME, "docs": "/docs", "health": f"{settings.API_PREFIX}/health"}

    return app


app = create_app()
