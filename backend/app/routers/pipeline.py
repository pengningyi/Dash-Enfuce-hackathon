"""Pipeline evaluation endpoints — uses the real screening_service."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time

import pandas as pd
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.helpers import DATA_DIR, rebuild_services, init_stats
from app.models.schemas import Decision, ScreenResult

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


def _dump_flagged_csv(results_map: dict, clients: list, true_indices: set[int]) -> None:
    """Dump all non-AUTO_CLEAR results + all TP results to CSV for rule analysis."""
    try:
        out = DATA_DIR / "pipeline_flagged_results.csv"
        rows = []
        for i, r in results_map.items():
            is_tp = i in true_indices
            if r.decision.value == "AUTO_CLEAR" and not is_tp:
                continue
            name, dob, country = clients[i]
            top = r.matches[0] if r.matches else None
            bd = r.signal_breakdown
            rows.append({
                "index": i, "client_name": name, "client_dob": dob, "client_country": country,
                "is_tp": i in true_indices, "decision": r.decision.value,
                "match_name": top.full_name if top else "", "match_id": top.sanctions_id if top else "",
                "match_dob": top.date_of_birth if top else "", "match_country": top.nationality if top else "",
                "score": round(top.similarity_score, 3) if top else 0,
                "jw": bd.name_jw.score if bd else 0, "phonetic": bd.phonetic.score if bd else 0,
                "embedding": bd.embedding.score if bd else 0, "dob_score": bd.dob.score if bd else 0,
                "country_score": bd.country.score if bd else 0,
                "country_missing": bd.country.missing if bd else True,
                "dob_missing": bd.dob.missing if bd else True,
                "reasoning": r.reasoning or "",
            })
        df = pd.DataFrame(rows)
        df.to_csv(out, index=False)
        logger.info("Dumped %d flagged results to %s", len(df), out)
    except Exception:
        logger.warning("Failed to dump flagged CSV", exc_info=True)


def _confusion(results: dict, true_indices: set[int], total: int) -> dict:
    tp = fp = fn = tn = 0
    for i in range(total):
        r = results.get(i)
        is_tp = i in true_indices
        is_flagged = r is not None and r.decision.value != "AUTO_CLEAR"
        if is_tp and is_flagged: tp += 1
        elif is_tp and not is_flagged: fn += 1
        elif not is_tp and is_flagged: fp += 1
        else: tn += 1
    total_n = tp + fp + fn + tn
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": round(tp / max(tp + fp, 1), 4),
        "recall": round(tp / max(tp + fn, 1), 4),
        "accuracy": round((tp + tn) / max(total_n, 1), 4),
        "total": total_n,
    }


@router.get("/pairs-preview")
async def pairs_preview(request: Request, count: int = 10) -> dict:
    count = max(1, min(count, 200))
    pool = getattr(request.app.state, "valid_pairs_pool", [])
    if not pool:
        raise HTTPException(status_code=503, detail="Pairs pool not ready")
    sampled = random.sample(pool, min(count, len(pool)))
    return {"pairs": sampled, "valid_pool_size": len(pool)}


@router.get("/datasets")
async def datasets() -> dict:
    sanctions = sorted(f.name for f in DATA_DIR.glob("*.csv") if "sanction" in f.name.lower())
    clients = sorted(f.name for f in DATA_DIR.glob("*.csv") if "client" in f.name.lower())
    return {"sanctions": sanctions, "clients": clients}


@router.post("/start")
async def start(request: Request, body: dict = None) -> dict:
    body = body or {}
    clients_csv = body.get("clients_csv", "clients_generated100.csv")
    sanctions_csv = body.get("sanctions_csv", "sanction_list_100.csv")
    injected_pairs = body.get("injected_pairs", [])

    if not (DATA_DIR / clients_csv).exists():
        raise HTTPException(status_code=404, detail=f"Client file not found: {clients_csv}")
    if not (DATA_DIR / sanctions_csv).exists():
        raise HTTPException(status_code=404, detail=f"Sanctions file not found: {sanctions_csv}")

    t0 = time.perf_counter()

    # Load sanctions — handle both CSV schemas
    sanctions_df = pd.read_csv(DATA_DIR / sanctions_csv, low_memory=False)
    if "name" in sanctions_df.columns and "Full_Name" not in sanctions_df.columns:
        sanctions_df = sanctions_df.rename(columns={"id": "Sanction_ID", "name": "Full_Name", "birth_date": "Date_of_Birth", "countries": "Nationality"})
        if "aliases" in sanctions_df.columns:
            aliases = sanctions_df["aliases"].str.split(";", n=2, expand=True)
            if aliases is not None:
                for i, col in enumerate(aliases.columns[:2]):
                    sanctions_df[f"Alias_{i+1}"] = aliases[col].str.strip()
        if "Nationality" in sanctions_df.columns:
            sanctions_df["Nationality"] = sanctions_df["Nationality"].str.split(";").str[0].str.strip()

    for col in sanctions_df.columns:
        sanctions_df[col] = sanctions_df[col].where(sanctions_df[col].notna(), None)

    # Inject sanctions from pairs
    true_client_indices: set[int] = set()
    clients_to_inject: list[dict] = []

    for pair in injected_pairs:
        s = pair.get("sanction", {})
        new_row = {"Sanction_ID": s.get("id", ""), "Full_Name": s.get("name", ""), "Date_of_Birth": s.get("birth_date"), "Nationality": s.get("country")}
        for i, alias in enumerate(s.get("aliases", [])[:2]):
            new_row[f"Alias_{i+1}"] = alias
        sanctions_df = pd.concat([sanctions_df, pd.DataFrame([new_row])], ignore_index=True)
        clients_to_inject.append(pair.get("client", {}))

    # Build services
    embedding_service, blocking_service, screening_service = rebuild_services(sanctions_df)

    # Parse clients — vectorized (iterrows is ~100x slower on 100K rows)
    clients_df = pd.read_csv(DATA_DIR / clients_csv, low_memory=False)

    # Resolve name column
    if "first_name" in clients_df.columns:
        ln = clients_df.get("last_name", pd.Series("", index=clients_df.index)).fillna("")
        name_s = (clients_df["first_name"].fillna("") + " " + ln).str.strip()
    elif "Full_Name" in clients_df.columns:
        name_s = clients_df["Full_Name"].fillna("")
    else:
        name_s = pd.Series("", index=clients_df.index)

    # Resolve DOB column
    dob_s = pd.Series(pd.NA, index=clients_df.index)
    for dcol in ["birth_of_date", "Date_of_Birth", "date_of_birth"]:
        if dcol in clients_df.columns:
            dob_s = clients_df[dcol]; break
    dob_s = dob_s.where(dob_s.notna(), None).astype(object).where(dob_s.notna(), None)

    # Resolve country column
    country_s = pd.Series(pd.NA, index=clients_df.index)
    for ccol in ["nationality", "Country", "country"]:
        if ccol in clients_df.columns:
            country_s = clients_df[ccol]; break
    country_s = country_s.where(country_s.notna(), None).astype(object).where(country_s.notna(), None)

    clients_data: list[tuple[str, str | None, str | None]] = list(zip(
        name_s.tolist(),
        [str(v).strip() if v is not None and v is not pd.NA else None for v in dob_s.tolist()],
        [str(v).strip() if v is not None and v is not pd.NA else None for v in country_s.tolist()],
    ))

    # Append injected clients
    for c in clients_to_inject:
        name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
        clients_data.append((name, c.get("birth_date"), c.get("country")))
        true_client_indices.add(len(clients_data) - 1)

    # Store state
    request.app.state.pipeline_screening = screening_service
    request.app.state.pipeline_clients = clients_data
    request.app.state.pipeline_true_indices = true_client_indices
    request.app.state.pipeline_results = {}
    request.app.state.pipeline_needs_review = []

    elapsed = time.perf_counter() - t0
    return {
        "client_count": len(clients_data),
        "sanction_count": len(sanctions_df),
        "index_size": embedding_service.index_size,
        "use_hnsw": False,
        "load_time_s": round(elapsed, 2),
        "injected_pairs": len(injected_pairs),
    }


@router.post("/layer/1")
async def layer1(request: Request) -> StreamingResponse:
    svc = getattr(request.app.state, "pipeline_screening", None)
    clients = getattr(request.app.state, "pipeline_clients", [])
    if not svc:
        raise HTTPException(status_code=400, detail="Pipeline not started")

    async def event_stream():
        bs = svc._blocking.index_stats
        total = len(clients)
        stats = {
            "total_pairs_before": total * len(svc._sanctions_by_id),
            "total_pairs_after": total * len(svc._sanctions_by_id),
            "pairs_eliminated": 0, "reduction_percent": 0,
            "clients_with_dob": sum(1 for _, dob, _ in clients if dob),
            "sanctions_with_dob": bs.get("dob_years", 0),
            "blocking_dob_years": bs.get("dob_years", 0),
            "blocking_phonetic_codes": bs.get("phonetic_codes", 0),
        }
        cm = _confusion({}, getattr(request.app.state, "pipeline_true_indices", set()), total)
        yield f"event: layer_complete\ndata: {json.dumps({'layer': 1, 'stats': stats, 'confusion_matrix': cm})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@router.post("/layer/2")
async def layer2(request: Request) -> StreamingResponse:
    svc = getattr(request.app.state, "pipeline_screening", None)
    clients = getattr(request.app.state, "pipeline_clients", [])
    if not svc:
        raise HTTPException(status_code=400, detail="Pipeline not started")

    async def event_stream():
        loop = asyncio.get_event_loop()
        total = len(clients)
        true_indices = getattr(request.app.state, "pipeline_true_indices", set())
        chunk = 50
        all_results: list = []
        running_decisions = {"AUTO_CLEAR": 0, "ESCALATE": 0, "NEEDS_REVIEW": 0}
        running_tp = 0; running_fp = 0; running_fn = 0; running_tn = 0

        for s in range(0, total, chunk):
            batch = clients[s:s + chunk]
            results = await loop.run_in_executor(None, svc.screen_many, batch, 0.55, chunk)
            all_results.extend(results)

            # Update running counts
            for j, r in enumerate(results):
                idx = s + j
                dec = r.decision.value
                running_decisions[dec] = running_decisions.get(dec, 0) + 1
                is_tp = idx in true_indices
                is_flagged = dec != "AUTO_CLEAR"
                if is_tp and is_flagged: running_tp += 1
                elif is_tp and not is_flagged: running_fn += 1
                elif not is_tp and is_flagged: running_fp += 1
                else: running_tn += 1

            processed = min(s + chunk, total)
            scored = running_tp + running_fp + running_fn + running_tn
            yield f"event: progress\ndata: {json.dumps({'processed': processed, 'total': total, 'percent': round(processed / total * 100, 1), 'phase': 'screening', 'decisions': running_decisions, 'confusion_matrix': {'tp': running_tp, 'fp': running_fp, 'fn': running_fn, 'tn': running_tn, 'precision': round(running_tp / max(running_tp + running_fp, 1), 4), 'recall': round(running_tp / max(running_tp + running_fn, 1), 4), 'accuracy': round((running_tp + running_tn) / max(scored, 1), 4), 'total': scored}})}\n\n"

        results_map = {}
        needs_review = []
        for i, r in enumerate(all_results):
            results_map[i] = r
            if r.decision.value == "NEEDS_REVIEW":
                needs_review.append(i)

        request.app.state.pipeline_results = results_map
        request.app.state.pipeline_needs_review = needs_review

        # Auto-dump flagged results to CSV for analysis
        _dump_flagged_csv(results_map, clients, true_indices)

        cm = _confusion(results_map, true_indices, total)
        yield f"event: layer_complete\ndata: {json.dumps({'layer': 2, 'stats': {'decisions': running_decisions, 'needs_review_count': len(needs_review)}, 'confusion_matrix': cm})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@router.post("/layer/3")
async def layer3(request: Request) -> StreamingResponse:
    results_map = getattr(request.app.state, "pipeline_results", {})
    clients = getattr(request.app.state, "pipeline_clients", [])
    needs_review = getattr(request.app.state, "pipeline_needs_review", [])
    true_indices = getattr(request.app.state, "pipeline_true_indices", set())
    llm_svc = getattr(request.app.state, "llm_service", None)

    if not results_map:
        raise HTTPException(status_code=400, detail="Layer 2 not complete")

    async def event_stream():
        total = len(needs_review)
        if total == 0 or llm_svc is None:
            reason = "no NEEDS_REVIEW cases" if total == 0 else "LLM service not available"
            cm = _confusion(results_map, true_indices, len(clients))
            yield f"event: layer_complete\ndata: {json.dumps({'layer': 3, 'stats': {'reason': reason, 'reviewed': 0}, 'confusion_matrix': cm})}\n\n"
            return

        # Signal all cases as analyzing simultaneously
        for idx in needs_review:
            name = clients[idx][0]
            yield f"event: llm_analyzing\ndata: {json.dumps({'client_index': idx, 'client_name': name})}\n\n"

        # Fire all LLM calls in parallel with concurrency limit
        CONCURRENCY = 20
        semaphore = asyncio.Semaphore(CONCURRENCY)
        result_queue: asyncio.Queue = asyncio.Queue()

        async def analyze_one(idx: int):
            r = results_map[idx]
            name, dob, country = clients[idx]
            try:
                async with semaphore:
                    llm_result = await llm_svc.analyze(name, dob, country, r.matches[:3])
                new_decision = Decision[llm_result["decision"]]
                results_map[idx] = ScreenResult(
                    query_name=name, matches=r.matches, decision=new_decision,
                    layer_reached=3, threshold_used=r.threshold_used,
                    signal_breakdown=r.signal_breakdown, reasoning=r.reasoning,
                    llm_reasoning=llm_result.get("reasoning"), llm_confidence=llm_result.get("confidence"),
                    llm_evidence=llm_result.get("evidence"), llm_matched_entity=llm_result.get("matched_entity"),
                )
                score = round(r.matches[0].similarity_score, 3) if r.matches else 0
                await result_queue.put(("ok", idx, name, llm_result, score))
            except Exception:
                logger.exception("LLM failed for client %d", idx)
                await result_queue.put(("error", idx, name, None, 0))

        # Launch all tasks
        tasks = [asyncio.create_task(analyze_one(idx)) for idx in needs_review]

        # Stream results as they complete
        completed = 0
        while completed < total:
            status, idx, name, llm_result, score = await result_queue.get()
            completed += 1
            if status == "ok" and llm_result:
                yield f"event: llm_result\ndata: {json.dumps({'client_index': idx, 'client_name': name, 'decision': llm_result['decision'], 'confidence': llm_result.get('confidence'), 'reasoning': llm_result.get('reasoning'), 'matched_entity': llm_result.get('matched_entity'), 'match_score': score, 'is_true_positive': idx in true_indices, 'evidence': llm_result.get('evidence', {})})}\n\n"
            yield f"event: progress\ndata: {json.dumps({'processed': completed, 'total': total, 'percent': round(completed / total * 100, 1), 'phase': 'llm'})}\n\n"

        # Ensure all tasks are done
        await asyncio.gather(*tasks, return_exceptions=True)

        decisions = {"AUTO_CLEAR": 0, "ESCALATE": 0, "NEEDS_REVIEW": 0}
        for r in results_map.values():
            decisions[r.decision.value] = decisions.get(r.decision.value, 0) + 1
        cm = _confusion(results_map, true_indices, len(clients))
        yield f"event: layer_complete\ndata: {json.dumps({'layer': 3, 'stats': {'decisions': decisions, 'reviewed': total}, 'confusion_matrix': cm})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@router.get("/clients")
async def pipeline_clients(request: Request, offset: int = 0, limit: int = 100, filter: str = "all") -> dict:
    clients = getattr(request.app.state, "pipeline_clients", [])
    results_map = getattr(request.app.state, "pipeline_results", {})
    true_indices = getattr(request.app.state, "pipeline_true_indices", set())

    # Build filtered index list
    if filter == "flagged":
        indices = [i for i in range(len(clients)) if (r := results_map.get(i)) and r.decision.value != "AUTO_CLEAR"]
    elif filter == "escalated":
        indices = [i for i in range(len(clients)) if (r := results_map.get(i)) and r.decision.value == "ESCALATE"]
    elif filter == "review":
        indices = [i for i in range(len(clients)) if (r := results_map.get(i)) and r.decision.value == "NEEDS_REVIEW"]
    elif filter == "tp":
        indices = [i for i in range(len(clients)) if i in true_indices]
    else:
        indices = list(range(len(clients)))

    total = len(indices)
    page_indices = indices[offset:offset + limit]
    result = []
    for i in page_indices:
        name, dob, country = clients[i]
        r = results_map.get(i)
        top = r.matches[0] if r and r.matches else None
        entry: dict = {
            "index": i, "name": name, "dob": dob, "country": country,
            "is_tp": i in true_indices,
            "decision": r.decision.value if r else None,
            "score": round(top.similarity_score, 3) if top else None,
            "match_name": top.full_name if top else None,
            "match_id": top.sanctions_id if top else None,
            # Match details
            "match_dob": top.date_of_birth if top else None,
            "match_country": top.nationality if top else None,
            "match_program": top.sanctions_program if top else None,
            "match_reason": top.reason_for_listing if top else None,
            # Layer info
            "layer_reached": r.layer_reached if r else None,
            # Rule engine reasoning
            "reasoning": r.reasoning if r else None,
            # Signal breakdown
            "signal_breakdown": {
                "dob": {"signal_name": r.signal_breakdown.dob.signal_name, "score": r.signal_breakdown.dob.score, "detail": r.signal_breakdown.dob.detail, "missing": r.signal_breakdown.dob.missing},
                "name_jw": {"signal_name": r.signal_breakdown.name_jw.signal_name, "score": r.signal_breakdown.name_jw.score, "detail": r.signal_breakdown.name_jw.detail, "missing": r.signal_breakdown.name_jw.missing},
                "phonetic": {"signal_name": r.signal_breakdown.phonetic.signal_name, "score": r.signal_breakdown.phonetic.score, "detail": r.signal_breakdown.phonetic.detail, "missing": r.signal_breakdown.phonetic.missing},
                "embedding": {"signal_name": r.signal_breakdown.embedding.signal_name, "score": r.signal_breakdown.embedding.score, "detail": r.signal_breakdown.embedding.detail, "missing": r.signal_breakdown.embedding.missing},
                "country": {"signal_name": r.signal_breakdown.country.signal_name, "score": r.signal_breakdown.country.score, "detail": r.signal_breakdown.country.detail, "missing": r.signal_breakdown.country.missing},
            } if r and r.signal_breakdown else None,
            # LLM info
            "llm_reasoning": r.llm_reasoning if r else None,
            "llm_confidence": r.llm_confidence if r else None,
            "llm_evidence": r.llm_evidence if r else None,
            "llm_matched_entity": r.llm_matched_entity if r else None,
        }
        result.append(entry)
    return {"items": result, "total": total, "offset": offset, "limit": limit, "has_more": offset + limit < total}
