"""Health and stats endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from app.models.schemas import StatsResponse

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    emb = getattr(request.app.state, "embedding_service", None)
    return {
        "status": "healthy",
        "model_loaded": getattr(request.app.state, "model_loaded", False),
        "index_size": emb.index_size if emb else 0,
    }


@router.get("/stats", response_model=StatsResponse)
async def get_stats(request: Request) -> StatsResponse:
    sanctions_df = getattr(request.app.state, "sanctions_df", None)
    embedding_svc = getattr(request.app.state, "embedding_service", None)
    stats = getattr(request.app.state, "screening_stats", None)

    total_screenings = 0
    decision_distribution: dict = {}
    avg_ms = 0.0

    if stats:
        total_screenings = stats["total_screenings"]
        decision_distribution = dict(stats["decisions"])
        times = stats["processing_times"]
        avg_ms = sum(times) / len(times) if times else 0.0

    return StatsResponse(
        sanctions_count=len(sanctions_df) if sanctions_df is not None else 0,
        index_size=embedding_svc.index_size if embedding_svc else 0,
        model_loaded=getattr(request.app.state, "model_loaded", False),
        threshold=0.6,
        total_screenings=total_screenings,
        decision_distribution=decision_distribution,
        avg_processing_time_ms=round(avg_ms, 2),
    )
