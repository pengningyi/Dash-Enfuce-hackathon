"""Sanctions list management: list, add, switch datasets."""

from __future__ import annotations

import logging
import time

import pandas as pd
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.models.schemas import SanctionsAddRequest, SanctionsEntry
from app.helpers import DATA_DIR, SANCTIONS_SETS, clean_nan_records, rebuild_services, init_stats

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["sanctions"])


@router.get("/sanctions", response_model=list[SanctionsEntry], response_model_by_alias=False)
async def get_sanctions(request: Request) -> list[dict]:
    sanctions_df = getattr(request.app.state, "sanctions_df", None)
    if sanctions_df is None or sanctions_df.empty:
        raise HTTPException(status_code=503, detail="Sanctions data not loaded")
    records = sanctions_df.to_dict(orient="records")
    return clean_nan_records(records)


@router.get("/sanctions/sets")
async def list_sanctions_sets(request: Request) -> list[dict]:
    current = getattr(request.app.state, "active_sanctions_set", "enfuce-30")
    result = []
    for key, info in SANCTIONS_SETS.items():
        csv_path = DATA_DIR / info["file"]
        cust_path = DATA_DIR / info["customers"]
        result.append({
            "id": key,
            "label": info["label"],
            "customers_label": info["customers_label"],
            "available": csv_path.exists(),
            "customers_available": cust_path.exists(),
            "active": key == current,
        })
    return result


@router.post("/sanctions/switch")
async def switch_sanctions_set(request: Request, request_body: dict) -> dict:
    set_id = request_body.get("set_id", "")
    if set_id not in SANCTIONS_SETS:
        raise HTTPException(status_code=400, detail=f"Unknown set: {set_id}")

    info = SANCTIONS_SETS[set_id]
    csv_path = DATA_DIR / info["file"]
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {info['file']}")

    t0 = time.perf_counter()
    logger.info("Switching sanctions set to '%s'...", set_id)

    sanctions_df = pd.read_csv(csv_path)
    embedding_service, blocking_service, screening_service = rebuild_services(sanctions_df)

    request.app.state.sanctions_df = sanctions_df
    request.app.state.embedding_service = embedding_service
    request.app.state.screening_service = screening_service
    request.app.state.blocking_service = blocking_service
    request.app.state.active_sanctions_set = set_id
    request.app.state.screening_stats = init_stats()

    elapsed = time.perf_counter() - t0
    logger.info("Sanctions set switched to '%s': %d entries, %.2fs", set_id, len(sanctions_df), elapsed)

    return {
        "status": "switched",
        "set_id": set_id,
        "label": info["label"],
        "sanctions_count": len(sanctions_df),
        "index_size": embedding_service.index_size,
        "load_time_s": round(elapsed, 2),
    }


@router.post("/sanctions/add")
async def sanctions_add(request: Request, req: SanctionsAddRequest) -> dict:
    embedding_svc = getattr(request.app.state, "embedding_service", None)
    screening_svc = getattr(request.app.state, "screening_service", None)
    blocking_svc = getattr(request.app.state, "blocking_service", None)
    sanctions_df = getattr(request.app.state, "sanctions_df", None)

    if embedding_svc is None or screening_svc is None or sanctions_df is None:
        raise HTTPException(status_code=503, detail="Service not initialized")

    new_row = {
        "Sanction_ID": req.sanction_id,
        "Full_Name": req.full_name,
        "Alias_1": req.alias_1,
        "Alias_2": req.alias_2,
        "Date_of_Birth": req.date_of_birth,
        "Nationality": req.nationality,
        "Passport_Number": req.passport_number,
        "Sanctions_Program": req.sanctions_program,
        "Reason_for_Listing": req.reason_for_listing,
    }

    request.app.state.sanctions_df = pd.concat([sanctions_df, pd.DataFrame([new_row])], ignore_index=True)
    screening_svc.add_sanction_record(new_row)

    vectors_added = 0
    embedding_svc.add_entry(req.full_name, req.sanction_id, "full_name")
    vectors_added += 1
    if req.alias_1 and req.alias_1.strip():
        embedding_svc.add_entry(req.alias_1, req.sanction_id, "alias_1")
        vectors_added += 1
    if req.alias_2 and req.alias_2.strip():
        embedding_svc.add_entry(req.alias_2, req.sanction_id, "alias_2")
        vectors_added += 1

    if blocking_svc:
        aliases_list = [a for a in [req.alias_1, req.alias_2] if a and a.strip()]
        blocking_svc.add_entry(req.sanction_id, req.full_name, req.date_of_birth, aliases_list)

    logger.info("Added sanctions entry: sid=%s name='%s' vectors=%d", req.sanction_id, req.full_name, vectors_added)
    return {"status": "added", "sanction_id": req.sanction_id, "vectors_added": vectors_added}
