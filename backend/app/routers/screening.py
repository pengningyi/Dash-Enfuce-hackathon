"""Single and batch screening endpoints."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.models.schemas import (
    BatchCustomerInput, BatchCustomerResult, BatchScreenRequest,
    BatchScreenResponse, Decision, ScreenRequest, ScreenResult,
)
from app.helpers import DATA_DIR, SANCTIONS_SETS, BATCH_SCREEN_CHUNK_SIZE, update_stats, load_customers_from_csv

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["screening"])


@router.post("/screen", response_model=ScreenResult)
async def screen(request: Request, req: ScreenRequest) -> ScreenResult:
    screening_service = getattr(request.app.state, "screening_service", None)
    if screening_service is None:
        raise HTTPException(status_code=503, detail="Screening service not initialized")

    result = screening_service.screen(name=req.name, dob=req.date_of_birth, country=req.country, threshold=req.threshold)

    # Layer 3: LLM
    llm_service = getattr(request.app.state, "llm_service", None)
    if result.decision == Decision.NEEDS_REVIEW and llm_service is not None:
        try:
            llm_result = await llm_service.analyze(req.name, req.date_of_birth, req.country, result.matches)
            result.decision = Decision(llm_result["decision"])
            result.llm_reasoning = llm_result["reasoning"]
            result.llm_confidence = llm_result["confidence"]
            result.llm_evidence = llm_result.get("evidence")
            result.llm_matched_entity = llm_result.get("matched_entity")
            result.processing_time_ms = llm_result["processing_time_ms"]
            result.layer_reached = 3
        except HTTPException:
            raise
        except Exception:
            logger.exception("LLM analysis failed for '%s'", req.name)

    stats = getattr(request.app.state, "screening_stats", None)
    if stats:
        update_stats(stats, result.decision.value, result.processing_time_ms)

    return result


@router.post("/screen-stream")
async def screen_stream(request: Request, req: ScreenRequest) -> StreamingResponse:
    """SSE endpoint that streams layer-by-layer screening progress."""
    screening_service = getattr(request.app.state, "screening_service", None)
    if screening_service is None:
        raise HTTPException(status_code=503, detail="Screening service not initialized")

    async def event_gen():
        t0 = time.time()

        # Layer 1: Embedding + Blocking search
        yield f"event: layer\ndata: {json.dumps({'layer': 1, 'status': 'running', 'label': 'Embedding Search'})}\n\n"

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            screening_service.screen,
            req.name, req.date_of_birth, req.country, req.threshold,
        )
        l1_ms = (time.time() - t0) * 1000

        # Layer 1 done
        yield f"event: layer\ndata: {json.dumps({'layer': 1, 'status': 'done', 'label': 'Embedding Search', 'ms': round(l1_ms), 'matches': len(result.matches)})}\n\n"

        # Layer 2: Rule engine (already computed inside screen()) — always report it
        yield f"event: layer\ndata: {json.dumps({'layer': 2, 'status': 'done', 'label': 'Rule Engine', 'decision': result.decision.value, 'reasoning': result.reasoning})}\n\n"

        # If AUTO_CLEAR or ESCALATE without LLM → done
        llm_service = getattr(request.app.state, "llm_service", None)
        if result.decision != Decision.NEEDS_REVIEW or llm_service is None:
            # Update stats
            stats = getattr(request.app.state, "screening_stats", None)
            if stats:
                update_stats(stats, result.decision.value, result.processing_time_ms)
            yield f"event: result\ndata: {json.dumps(result.model_dump(mode='json'))}\n\n"
            return

        # Layer 3: LLM (only if NEEDS_REVIEW)
        yield f"event: layer\ndata: {json.dumps({'layer': 3, 'status': 'running', 'label': 'LLM Analysis'})}\n\n"
        try:
            llm_result = await llm_service.analyze(req.name, req.date_of_birth, req.country, result.matches)
            result.decision = Decision(llm_result["decision"])
            result.llm_reasoning = llm_result["reasoning"]
            result.llm_confidence = llm_result["confidence"]
            result.llm_evidence = llm_result.get("evidence")
            result.llm_matched_entity = llm_result.get("matched_entity")
            result.processing_time_ms = llm_result["processing_time_ms"]
            result.layer_reached = 3
            l3_ms = result.processing_time_ms or 0
            yield f"event: layer\ndata: {json.dumps({'layer': 3, 'status': 'done', 'label': 'LLM Analysis', 'ms': round(l3_ms), 'decision': result.decision.value})}\n\n"
        except HTTPException:
            raise
        except Exception:
            logger.exception("LLM analysis failed for '%s'", req.name)
            yield f"event: layer\ndata: {json.dumps({'layer': 3, 'status': 'error', 'label': 'LLM Analysis'})}\n\n"

        # Update stats
        stats = getattr(request.app.state, "screening_stats", None)
        if stats:
            update_stats(stats, result.decision.value, result.processing_time_ms)

        yield f"event: result\ndata: {json.dumps(result.model_dump(mode='json'))}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@router.post("/batch-screen-stream")
async def batch_screen_stream(request: Request, req: BatchScreenRequest) -> StreamingResponse:
    screening_service = getattr(request.app.state, "screening_service", None)
    if screening_service is None:
        raise HTTPException(status_code=503, detail="Screening service not initialized")

    customers = req.customers
    if not customers:
        active_set = getattr(request.app.state, "active_sanctions_set", "enfuce-30")
        customers_csv = DATA_DIR / SANCTIONS_SETS[active_set]["customers"]
        if not customers_csv.exists():
            raise HTTPException(status_code=404, detail=f"Customer file not found")
        customers = load_customers_from_csv(customers_csv)

    total = len(customers)

    async def event_stream():
        yield f"event: init\ndata: {json.dumps({'total': total})}\n\n"

        stats = getattr(request.app.state, "screening_stats", None)
        llm_service = getattr(request.app.state, "llm_service", None)
        loop = asyncio.get_event_loop()

        needs_review_indices: list[int] = []
        sent_results: dict[int, dict] = {}

        # L1+L2: batch screen
        for chunk_start in range(0, total, BATCH_SCREEN_CHUNK_SIZE):
            chunk_end = min(chunk_start + BATCH_SCREEN_CHUNK_SIZE, total)
            chunk = customers[chunk_start:chunk_end]
            tuples = [(c.name, c.date_of_birth, c.country) for c in chunk]
            results = await loop.run_in_executor(None, screening_service.screen_many, tuples, 0.55, BATCH_SCREEN_CHUNK_SIZE)

            for offset, result in enumerate(results):
                idx = chunk_start + offset
                cust = customers[idx]

                if stats:
                    update_stats(stats, result.decision.value, result.processing_time_ms)

                top = result.matches[0] if result.matches else None
                row = {
                    "index": idx,
                    "query_name": cust.name,
                    "query_dob": cust.date_of_birth,
                    "query_country": cust.country,
                    "decision": result.decision.value,
                    "top_match_name": top.full_name if top else None,
                    "top_match_score": round(top.similarity_score, 4) if top else None,
                    "top_match_dob": top.date_of_birth if top else None,
                    "top_match_country": top.nationality if top else None,
                    "sanctions_id": top.sanctions_id if top else None,
                    "top_match_program": top.sanctions_program if top else None,
                    "top_match_reason": top.reason_for_listing if top else None,
                    "layer_reached": result.layer_reached,
                    "signal_breakdown": result.signal_breakdown.model_dump() if result.signal_breakdown else None,
                    "reasoning": result.reasoning,
                    "processing_time_ms": result.processing_time_ms,
                }
                sent_results[idx] = row
                yield f"event: result\ndata: {json.dumps(row)}\n\n"

                if result.decision == Decision.NEEDS_REVIEW:
                    needs_review_indices.append(idx)

        # L3: LLM for NEEDS_REVIEW — sequential to allow SSE yielding
        if llm_service and needs_review_indices:
            for idx in needs_review_indices:
                cust = customers[idx]
                try:
                    screening_result = screening_service.screen(cust.name, cust.date_of_birth, cust.country, 0.55)
                    llm_result = await llm_service.analyze(cust.name, cust.date_of_birth, cust.country, screening_result.matches)
                    new_decision = llm_result["decision"]
                    if stats:
                        old = sent_results[idx]["decision"]
                        if old in stats["decisions"]:
                            stats["decisions"][old] = max(0, stats["decisions"][old] - 1)
                        if new_decision in stats["decisions"]:
                            stats["decisions"][new_decision] += 1
                    sent_results[idx]["decision"] = new_decision
                    yield f"event: llm_update\ndata: {json.dumps({'index': idx, 'decision': new_decision, 'llm_reasoning': llm_result.get('reasoning'), 'llm_confidence': llm_result.get('confidence'), 'llm_evidence': llm_result.get('evidence'), 'llm_matched_entity': llm_result.get('matched_entity'), 'processing_time_ms': llm_result.get('processing_time_ms'), 'layer_reached': 3})}\n\n"
                except Exception:
                    logger.exception("LLM failed for idx=%d", idx)

        # Done
        summary = {
            "total": total,
            "auto_cleared": sum(1 for r in sent_results.values() if r["decision"] == "AUTO_CLEAR"),
            "escalated": sum(1 for r in sent_results.values() if r["decision"] == "ESCALATE"),
            "needs_review": sum(1 for r in sent_results.values() if r["decision"] == "NEEDS_REVIEW"),
            "processing_time_ms": 0,
        }
        yield f"event: done\ndata: {json.dumps(summary)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
