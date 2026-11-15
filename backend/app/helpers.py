"""Shared helpers, constants, and sanctions dataset config."""

from __future__ import annotations

import csv as csv_mod
import logging
import math
import time
from pathlib import Path

import pandas as pd
from fastapi import HTTPException

from app.models.schemas import BatchCustomerInput
from app.services.blocking_service import BlockingService
from app.services.embedding_service import EmbeddingService
from app.services.screening_service import ScreeningService

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SANCTIONS_CSV = DATA_DIR / "sanctions_list.csv"
BATCH_SCREEN_CHUNK_SIZE = 256

SANCTIONS_SETS = {
    "enfuce-30": {
        "file": "sanctions_list.csv",
        "label": "Enfuce Demo (30 entries)",
        "customers": "customers.csv",
        "customers_label": "100K Customers",
    },
    "real-1m": {
        "file": "sanctions_list_v3.csv",
        "label": "Real Sanctions (1M entries)",
        "customers": "customers_v3.csv",
        "customers_label": "400K Customers",
    },
    "pairs-benchmark": {
        "file": "sanctions_pairs.csv",
        "label": "Pairs Benchmark (101K sanctions)",
        "customers": "customers_pairs.csv",
        "customers_label": "152K Customers (146K matches)",
    },
    "demo-5k": {
        "file": "sanctions_5k.csv",
        "label": "Demo Sanctions (5K entries)",
        "customers": "customers_5k.csv",
        "customers_label": "500K Customers (50 hidden)",
    },
}


def update_stats(stats: dict, decision: str, processing_time_ms: float | None) -> None:
    """Increment screening stats accumulator."""
    stats["total_screenings"] += 1
    if decision in stats["decisions"]:
        stats["decisions"][decision] += 1
    if processing_time_ms is not None:
        stats["processing_times"].append(processing_time_ms)


def load_customers_from_csv(customers_csv: Path) -> list[BatchCustomerInput]:
    """Load batch customers from a server-side CSV file."""
    loaded: list[BatchCustomerInput] = []
    with open(customers_csv, newline="", encoding="utf-8") as f:
        reader = csv_mod.DictReader(f)
        for row in reader:
            loaded.append(
                BatchCustomerInput(
                    name=row["Full_Name"],
                    date_of_birth=row.get("Date_of_Birth") or None,
                    country=row.get("Country") or None,
                )
            )
    return loaded


def load_sanctions_df(csv_path: Path) -> pd.DataFrame:
    """Load and clean a sanctions CSV, handling NaN values."""
    df = pd.read_csv(csv_path, low_memory=False)
    return df


def clean_nan_records(records: list[dict]) -> list[dict]:
    """Replace float NaN with None in a list of dicts (for JSON serialization)."""
    for rec in records:
        for k, v in rec.items():
            if isinstance(v, float) and math.isnan(v):
                rec[k] = None
    return records


def rebuild_services(sanctions_df: pd.DataFrame) -> tuple[EmbeddingService, BlockingService, ScreeningService]:
    """Build embedding, blocking, and screening services from a sanctions DataFrame."""
    embedding_service = EmbeddingService()
    embedding_service.load_and_index(sanctions_df)

    blocking_service = BlockingService()
    blocking_service.build_indexes(sanctions_df)

    screening_service = ScreeningService(embedding_service, blocking_service, sanctions_df)
    return embedding_service, blocking_service, screening_service


def init_stats() -> dict:
    """Create a fresh screening stats dict."""
    return {
        "total_screenings": 0,
        "decisions": {"AUTO_CLEAR": 0, "ESCALATE": 0, "NEEDS_REVIEW": 0},
        "processing_times": [],
    }
