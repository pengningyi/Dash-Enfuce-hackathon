"""Pipeline service: layered sanctions screening with progress tracking and confusion matrix.

Layer 1: DOB pre-filter + country normalization
Layer 2: Embedding similarity (FAISS HNSW for large lists) + composite scoring (no DOB weight)
Layer 3: LLM reasoning for NEEDS_REVIEW cases
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import faiss
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer

from app.services.embedding_service import (
    EMBEDDING_DIM,
    ENCODE_BATCH_SIZE,
    CACHE_DIR,
    IndexEntry,
    MODEL_NAME,
    _has_text,
)
from app.services.screening_service import (
    _best_token_jw,
    _phonetic_score,
    _normalize_country,
)

logger = logging.getLogger(__name__)

# ── Composite weights (DOB is a hard pre-filter, not a composite signal) ──
PW_EMBEDDING = 0.25
PW_TOKEN_JW  = 0.45
PW_PHONETIC  = 0.10
PW_COUNTRY   = 0.20

# ── Thresholds ──
P_EMBEDDING_THRESHOLD = 0.55
P_COMPOSITE_ESCALATE  = 0.65
P_COMPOSITE_REVIEW    = 0.45

# HNSW parameters
HNSW_M               = 32   # connections per node (higher = better recall, more RAM)
HNSW_EF_CONSTRUCTION = 200  # index build quality
HNSW_EF_SEARCH       = 100  # search quality (set at query time)
HNSW_THRESHOLD       = 10_000  # use HNSW when sanctions count exceeds this


# ── Data records ──

@dataclass
class ClientRecord:
    index: int
    full_name: str
    dob: str | None
    country: str | None
    country_norm: str | None = None


@dataclass
class SanctionRecord:
    sanctions_id: str
    full_name: str
    aliases: list[str] = field(default_factory=list)
    dob: str | None = None
    country: str | None = None
    country_norm: str | None = None


@dataclass
class ClientDecision:
    decision: str  # AUTO_CLEAR | ESCALATE | NEEDS_REVIEW
    best_score: float = 0.0
    best_sanctions_id: str | None = None
    best_match_name: str | None = None


@dataclass
class ConfusionMatrix:
    tp: int = 0
    fp: int = 0
    tn: int = 0
    fn: int = 0

    def to_dict(self) -> dict:
        total = self.tp + self.fp + self.tn + self.fn
        return {
            "tp": self.tp,
            "fp": self.fp,
            "tn": self.tn,
            "fn": self.fn,
            "precision": round(self.tp / max(self.tp + self.fp, 1), 4),
            "recall": round(self.tp / max(self.tp + self.fn, 1), 4),
            "accuracy": round((self.tp + self.tn) / max(total, 1), 4),
            "total": total,
        }


@dataclass
class PipelineState:
    clients: list[ClientRecord]
    sanctions: list[SanctionRecord]
    sanctions_lookup: dict[str, SanctionRecord]
    true_pairs: set[int]             # client indices known to have a true match
    # Built index
    faiss_index: faiss.Index
    index_entries: list[IndexEntry]
    is_hnsw: bool                    # True → scores are sq-L2 distances, need conversion
    shared_model: SentenceTransformer
    # Layer 1
    dob_candidates: dict[int, set[str]] = field(default_factory=dict)
    layer1_stats: dict = field(default_factory=dict)
    layer1_complete: bool = False
    # Layer 2
    decisions: dict[int, ClientDecision] = field(default_factory=dict)
    needs_review_indices: list[int] = field(default_factory=list)
    layer2_stats: dict = field(default_factory=dict)
    layer2_complete: bool = False
    # Layer 3
    layer3_complete: bool = False
    current_layer: int = 0


# ── DOB helpers ──

def _dob_digits(dob_str: str | None) -> str | None:
    """Extract digits from DOB string → 'YYYYMMDD' or 'YYYY' or None."""
    if not dob_str:
        return None
    digits = re.sub(r"[^0-9]", "", dob_str)
    if len(digits) >= 8:
        return digits[:8]
    if len(digits) >= 4:
        return digits[:4]
    return None


def _dob_compatible(client_dob: str | None, sanction_dob: str | None, max_edit: int = 1) -> bool:
    """Return True if the two DOBs could belong to the same person (≤ max_edit digit differences)."""
    c = _dob_digits(client_dob)
    s = _dob_digits(sanction_dob)
    if not c or not s:
        return True  # Missing DOB → cannot filter
    min_len = min(len(c), len(s))
    diff = sum(1 for a, b in zip(c[:min_len], s[:min_len]) if a != b)
    return diff <= max_edit


# ── Schema helpers ──

def _safe(val: object) -> str | None:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    s = str(val).strip()
    return s if s else None


def _load_sanctions_from_df(df: pd.DataFrame) -> tuple[list[SanctionRecord], dict[str, SanctionRecord]]:
    """Parse a sanctions DataFrame into SanctionRecord list, supporting two schemas.

    Old schema: Sanction_ID, Full_Name, Alias_1, Alias_2, Date_of_Birth, Nationality
    New schema:  id, name, aliases (semicolon-sep), birth_date, countries (semicolon-sep ISO codes)
    """
    records: list[SanctionRecord] = []
    lookup: dict[str, SanctionRecord] = {}

    if "Full_Name" in df.columns:
        # Old schema
        for row in df.itertuples(index=False):
            sid = str(getattr(row, "Sanction_ID", ""))
            name = _safe(getattr(row, "Full_Name", None)) or ""
            if not name:
                continue
            aliases = []
            for col in ("Alias_1", "Alias_2"):
                a = _safe(getattr(row, col, None))
                if a:
                    aliases.append(a)
            country = _safe(getattr(row, "Nationality", None))
            rec = SanctionRecord(
                sanctions_id=sid,
                full_name=name,
                aliases=aliases,
                dob=_safe(getattr(row, "Date_of_Birth", None)),
                country=country,
                country_norm=_normalize_country(country) if country else None,
            )
            records.append(rec)
            lookup[sid] = rec

    elif "name" in df.columns:
        # New schema (large dataset)
        for row in df.itertuples(index=False):
            sid = _safe(getattr(row, "id", None)) or ""
            name = _safe(getattr(row, "name", None)) or ""
            if not name:
                continue
            # Semicolon-separated aliases (cap at 10 to avoid extreme outliers)
            aliases_raw = _safe(getattr(row, "aliases", None)) or ""
            aliases = [a.strip() for a in aliases_raw.split(";") if a.strip()][:10]
            # Take primary country (first semicolon-separated ISO code)
            countries_raw = _safe(getattr(row, "countries", None)) or ""
            country = countries_raw.split(";")[0].strip() or None
            rec = SanctionRecord(
                sanctions_id=sid,
                full_name=name,
                aliases=aliases,
                dob=_safe(getattr(row, "birth_date", None)),
                country=country,
                country_norm=_normalize_country(country) if country else None,
            )
            records.append(rec)
            lookup[sid] = rec
    else:
        raise ValueError(f"Unrecognized sanctions CSV schema. Columns: {list(df.columns)}")

    return records, lookup


# ── FAISS index builder with caching ──

def _df_hash(df: pd.DataFrame) -> str:
    sig = f"{len(df)}|{list(df.columns)}|{df.iloc[0].to_dict() if len(df) else ''}|{df.iloc[-1].to_dict() if len(df) else ''}"
    return hashlib.md5(sig.encode()).hexdigest()


def _build_and_cache_index(
    sanctions: list[SanctionRecord],
    model: SentenceTransformer,
    cache_key: str,
    use_hnsw: bool,
) -> tuple[faiss.Index, list[IndexEntry]]:
    """Build or load a FAISS index for the given sanctions records.

    Caches to disk so subsequent starts are fast.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    suffix = "hnsw" if use_hnsw else "flat"
    index_path   = CACHE_DIR / f"{cache_key}_{suffix}.faiss"
    entries_path = CACHE_DIR / f"{cache_key}_{suffix}.entries.json"

    # Cache hit
    if index_path.exists() and entries_path.exists():
        try:
            t0 = time.perf_counter()
            idx = faiss.read_index(str(index_path))
            raw = json.loads(entries_path.read_text())
            entries = [IndexEntry(e["sanctions_id"], e["name_type"], e["original_name"]) for e in raw]
            logger.info("Loaded pipeline index from cache in %.2fs (%d vectors)", time.perf_counter() - t0, idx.ntotal)
            from app.services.embedding_service import _try_gpu_index
            idx = _try_gpu_index(idx)
            return idx, entries
        except Exception:
            logger.warning("Cache load failed, rebuilding", exc_info=True)

    # Build from scratch (with checkpoint resume support)
    logger.info("Building pipeline index (%s, %d sanctions)…", suffix, len(sanctions))
    entries: list[IndexEntry] = []
    texts:   list[str]        = []
    for sanc in sanctions:
        entries.append(IndexEntry(sanc.sanctions_id, "full_name", sanc.full_name))
        texts.append(sanc.full_name)
        for i, alias in enumerate(sanc.aliases):
            entries.append(IndexEntry(sanc.sanctions_id, f"alias_{i + 1}", alias))
            texts.append(alias)

    total_texts = len(texts)
    checkpoint_path = CACHE_DIR / f"{cache_key}_{suffix}.checkpoint.npy"
    checkpoint_meta = CACHE_DIR / f"{cache_key}_{suffix}.checkpoint.json"

    # Resume from checkpoint if available
    resume_start = 0
    all_embeddings: list[np.ndarray] = []
    if checkpoint_path.exists() and checkpoint_meta.exists():
        try:
            meta = json.loads(checkpoint_meta.read_text())
            if meta.get("total") == total_texts:
                saved = np.load(str(checkpoint_path))
                resume_start = meta["encoded"]
                all_embeddings = [saved]
                logger.info("Resuming from checkpoint at %d/%d (%.0f%%)", resume_start, total_texts, resume_start / total_texts * 100)
            else:
                logger.info("Checkpoint total mismatch (%d vs %d), starting fresh", meta.get("total"), total_texts)
        except Exception:
            logger.warning("Failed to load checkpoint, starting fresh", exc_info=True)

    logger.info("Encoding %d name variants (starting at %d)…", total_texts, resume_start)
    t0 = time.perf_counter()

    # Checkpoint every ~10% of total texts
    checkpoint_interval = max(ENCODE_BATCH_SIZE, (total_texts // 10 // ENCODE_BATCH_SIZE) * ENCODE_BATCH_SIZE)

    for start in range(resume_start, total_texts, ENCODE_BATCH_SIZE):
        batch = texts[start : start + ENCODE_BATCH_SIZE]
        emb = model.encode(
            batch,
            batch_size=ENCODE_BATCH_SIZE,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        all_embeddings.append(np.asarray(emb, dtype=np.float32))

        encoded_so_far = start + len(batch)
        pct = encoded_so_far / total_texts * 100

        if (start // ENCODE_BATCH_SIZE) % 100 == 0:
            logger.info("  Encoding… %.0f%%", pct)

        # Save checkpoint every ~10%
        batches_done = (start - resume_start) // ENCODE_BATCH_SIZE + 1
        if batches_done > 0 and (start + ENCODE_BATCH_SIZE - resume_start) % checkpoint_interval < ENCODE_BATCH_SIZE:
            try:
                merged = np.vstack(all_embeddings)
                np.save(str(checkpoint_path), merged)
                checkpoint_meta.write_text(json.dumps({"encoded": len(merged), "total": total_texts}))
                logger.info("  Checkpoint saved at %.0f%% (%d/%d vectors)", pct, len(merged), total_texts)
            except Exception:
                logger.warning("Checkpoint save failed", exc_info=True)

    embeddings = np.vstack(all_embeddings) if all_embeddings else np.empty((0, EMBEDDING_DIM), dtype=np.float32)
    encode_elapsed = time.perf_counter() - t0
    logger.info("Encoded %d texts in %.1fs", total_texts, encode_elapsed)

    if use_hnsw:
        idx = faiss.IndexHNSWFlat(EMBEDDING_DIM, HNSW_M)
        idx.hnsw.efConstruction = HNSW_EF_CONSTRUCTION
        idx.hnsw.efSearch = HNSW_EF_SEARCH
        if len(entries) > 0:
            idx.add(embeddings)
    else:
        idx = faiss.IndexFlatIP(EMBEDDING_DIM)
        if len(entries) > 0:
            idx.add(embeddings)

    logger.info("FAISS index built: %d vectors (%.1fs)", idx.ntotal, time.perf_counter() - t0)

    # Save cache (always save CPU index before moving to GPU)
    try:
        faiss.write_index(idx, str(index_path))
        entries_path.write_text(json.dumps([asdict(e) for e in entries]))
        logger.info("Pipeline index cached at %s", cache_key[:12])
        # Clean up checkpoint files now that full cache is saved
        for p in (checkpoint_path, checkpoint_meta):
            if p.exists():
                p.unlink()
    except Exception:
        logger.warning("Failed to cache pipeline index", exc_info=True)

    # Try moving index to GPU
    from app.services.embedding_service import _try_gpu_index
    idx = _try_gpu_index(idx)

    return idx, entries


# ── Composite scoring ──

def _pipeline_composite(
    query_name: str,
    query_country_norm: str | None,
    match_name: str,
    match_alias: str,
    match_country_norm: str | None,
    embedding_score: float,
) -> float:
    """Composite score without DOB (DOB is a pre-filter, not a signal)."""
    token_jw = max(
        _best_token_jw(query_name, match_name),
        _best_token_jw(query_name, match_alias),
    )
    phonetic = _phonetic_score(query_name, match_name)
    country = 0.0
    if query_country_norm and match_country_norm:
        country = 0.5 if query_country_norm == match_country_norm else -0.1

    return (
        PW_EMBEDDING * embedding_score
        + PW_TOKEN_JW  * token_jw
        + PW_PHONETIC  * phonetic
        + PW_COUNTRY   * country
    )


# ── Main service ──

class PipelineService:
    """Manages layered screening with progress tracking and confusion matrix."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.state: PipelineState | None = None

    def start(self, clients_csv: str, sanctions_csv: str, shared_model=None, injected_pairs: list[dict] | None = None) -> dict:
        """Load datasets, build/load FAISS index, return dataset info."""
        t0 = time.perf_counter()

        # ── Load clients (first_name + last_name schema) ──
        clients_df = pd.read_csv(self.data_dir / clients_csv)
        clients: list[ClientRecord] = []
        for i, row in enumerate(clients_df.itertuples(index=False)):
            fn = str(getattr(row, "first_name", ""))
            ln = str(getattr(row, "last_name", ""))
            full_name = f"{fn} {ln}".strip()
            dob     = _safe(getattr(row, "birth_of_date", None))
            country = _safe(getattr(row, "nationality", None))
            clients.append(ClientRecord(
                index=i,
                full_name=full_name,
                dob=dob,
                country=country,
                country_norm=_normalize_country(country) if country else None,
            ))

        # ── Load sanctions (multi-schema) ──
        logger.info("Loading sanctions from %s…", sanctions_csv)
        sanctions_df = pd.read_csv(self.data_dir / sanctions_csv, low_memory=False)
        sanctions, sanctions_lookup = _load_sanctions_from_df(sanctions_df)

        # ── Build / load FAISS index ──
        use_hnsw = len(sanctions) > HNSW_THRESHOLD
        data_hash = _df_hash(sanctions_df)
        cache_key = f"{data_hash}_{MODEL_NAME}"

        if shared_model is None:
            from sentence_transformers import SentenceTransformer
            import sys
            if sys.platform == "darwin":
                shared_model = SentenceTransformer(MODEL_NAME)
            else:
                from app.services.embedding_service import _detect_device
                device = _detect_device()
                try:
                    shared_model = SentenceTransformer(MODEL_NAME, device=device)
                except Exception:
                    if device != "cpu":
                        logger.warning("Pipeline model GPU load failed — falling back to CPU")
                        shared_model = SentenceTransformer(MODEL_NAME)
                    else:
                        raise

        faiss_index, index_entries = _build_and_cache_index(
            sanctions, shared_model, cache_key, use_hnsw,
        )

        # ── Inject true pairs in-memory (sanctions must also be added to FAISS index) ──
        true_pairs: set[int] = set()
        if injected_pairs:
            inj_texts: list[str] = []
            inj_entries: list[IndexEntry] = []

            for pair in injected_pairs:
                # Inject sanction side
                sanction_data = pair["sanction"]
                inj_sanc = SanctionRecord(
                    sanctions_id=sanction_data["id"],
                    full_name=sanction_data["name"],
                    aliases=sanction_data.get("aliases") or [],
                    dob=sanction_data.get("birth_date"),
                    country=sanction_data.get("country"),
                    country_norm=_normalize_country(sanction_data["country"]) if sanction_data.get("country") else None,
                )
                sanctions.append(inj_sanc)
                sanctions_lookup[inj_sanc.sanctions_id] = inj_sanc

                # Collect texts to encode for FAISS
                inj_entries.append(IndexEntry(inj_sanc.sanctions_id, "full_name", inj_sanc.full_name))
                inj_texts.append(inj_sanc.full_name)
                for i, alias in enumerate(inj_sanc.aliases):
                    inj_entries.append(IndexEntry(inj_sanc.sanctions_id, f"alias_{i+1}", alias))
                    inj_texts.append(alias)

                # Inject client side
                client_data = pair["client"]
                client_idx = len(clients)
                client_country = client_data.get("country")
                inj_client = ClientRecord(
                    index=client_idx,
                    full_name=f"{client_data['first_name']} {client_data['last_name']}",
                    dob=client_data.get("birth_date"),
                    country=client_country,
                    country_norm=_normalize_country(client_country) if client_country else None,
                )
                clients.append(inj_client)
                true_pairs.add(client_idx)

            # Encode injected sanction names and add to FAISS index
            inj_embeddings = shared_model.encode(
                inj_texts,
                batch_size=ENCODE_BATCH_SIZE,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            inj_embeddings = np.asarray(inj_embeddings, dtype=np.float32)
            faiss_index.add(inj_embeddings)
            index_entries.extend(inj_entries)

            logger.info(
                "Injected %d true pairs: %d new FAISS vectors (index total: %d, clients now: %d)",
                len(injected_pairs), len(inj_texts), faiss_index.ntotal, len(clients),
            )

        self.state = PipelineState(
            clients=clients,
            sanctions=sanctions,
            sanctions_lookup=sanctions_lookup,
            true_pairs=true_pairs,
            faiss_index=faiss_index,
            index_entries=index_entries,
            is_hnsw=use_hnsw,
            shared_model=shared_model,
        )

        elapsed = time.perf_counter() - t0
        logger.info(
            "Pipeline ready: %d clients, %d sanctions, %d index vectors, hnsw=%s (%.2fs)",
            len(clients), len(sanctions), faiss_index.ntotal, use_hnsw, elapsed,
        )
        return {
            "client_count": len(clients),
            "sanction_count": len(sanctions),
            "index_size": faiss_index.ntotal,
            "use_hnsw": use_hnsw,
            "load_time_s": round(elapsed, 2),
            "injected_pairs": len(injected_pairs or []),
        }

    # ── Layer 1: DOB pre-filter ──

    def run_layer1(self):
        """Generator yielding (event_type, data) for Layer 1 (DOB pre-filter)."""
        state = self.state
        if state is None:
            yield ("error", {"message": "Pipeline not started"})
            return

        total = len(state.clients)
        all_ids = {s.sanctions_id for s in state.sanctions}

        total_pairs_after = 0
        for i, client in enumerate(state.clients):
            if client.dob:
                valid = set()
                for sanc in state.sanctions:
                    if _dob_compatible(client.dob, sanc.dob):
                        valid.add(sanc.sanctions_id)
                state.dob_candidates[i] = valid
            else:
                state.dob_candidates[i] = all_ids
            total_pairs_after += len(state.dob_candidates[i])

            if (i + 1) % 5000 == 0 or i == total - 1:
                yield ("progress", {
                    "processed": i + 1,
                    "total": total,
                    "percent": round((i + 1) / total * 100, 1),
                    "phase": "dob_filter",
                })

        total_pairs_before = total * len(state.sanctions)
        stats = {
            "total_pairs_before": total_pairs_before,
            "total_pairs_after": total_pairs_after,
            "pairs_eliminated": total_pairs_before - total_pairs_after,
            "reduction_percent": round(
                (1 - total_pairs_after / max(total_pairs_before, 1)) * 100, 1
            ),
            "clients_with_dob":   sum(1 for c in state.clients if c.dob),
            "sanctions_with_dob": sum(1 for s in state.sanctions if s.dob),
        }
        state.layer1_stats = stats
        state.layer1_complete = True
        state.current_layer = 1

        cm = self.get_confusion_matrix()
        yield ("layer_complete", {"layer": 1, "stats": stats, "confusion_matrix": cm.to_dict()})

    # ── Client embedding cache ──

    def _client_cache_path(self) -> Path:
        """Disk path for the cached client embedding matrix (.npy)."""
        state = self.state
        names = [c.full_name for c in state.clients]
        sig = f"{len(names)}|{names[0] if names else ''}|{names[-1] if names else ''}"
        key = hashlib.md5(sig.encode()).hexdigest()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        return CACHE_DIR / f"clients_{key}_{MODEL_NAME}.npy"

    def load_client_cache(self) -> np.ndarray | None:
        """Load cached client embeddings if they exist. Returns None on miss."""
        path = self._client_cache_path()
        if not path.exists():
            return None
        try:
            t0 = time.perf_counter()
            arr = np.load(str(path))
            logger.info("Loaded client embeddings from cache in %.2fs (%d vectors)", time.perf_counter() - t0, len(arr))
            return arr
        except Exception:
            logger.warning("Failed to load client embedding cache", exc_info=True)
            return None

    def save_client_cache(self, embeddings: np.ndarray) -> None:
        """Save client embeddings to disk for future runs."""
        path = self._client_cache_path()
        try:
            np.save(str(path), embeddings)
            size_mb = embeddings.nbytes / 1024 / 1024
            logger.info("Saved client embeddings cache: %.1f MB → %s", size_mb, path.name)
        except Exception:
            logger.warning("Failed to save client embedding cache", exc_info=True)

    # ── Layer 2 helpers (called from async endpoint) ──

    def encode_client_batch(self, start: int, batch_size: int = ENCODE_BATCH_SIZE) -> np.ndarray:
        """Encode a slice of client names. Run in thread executor."""
        state = self.state
        end = min(start + batch_size, len(state.clients))
        names = [state.clients[i].full_name for i in range(start, end)]
        emb = state.shared_model.encode(
            names,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return np.asarray(emb, dtype=np.float32)

    def score_clients(self, query_embeddings: np.ndarray, start_idx: int) -> list[ClientDecision]:
        """Search FAISS + use our rule-based decision engine for a batch of pre-encoded clients."""
        from app.models.schemas import SignalBreakdown, SignalScore, Decision
        from app.services.screening_service import ScreeningService

        state = self.state
        n = query_embeddings.shape[0]
        k = min(10, state.faiss_index.ntotal)

        raw_scores, raw_indices = state.faiss_index.search(query_embeddings, k)

        # HNSW returns squared L2 distances → convert to cosine similarity
        if state.is_hnsw:
            cos_scores = 1.0 - raw_scores / 2.0
        else:
            cos_scores = raw_scores

        # Create a temporary screening service instance for _apply_rules
        svc = ScreeningService.__new__(ScreeningService)

        decisions: list[ClientDecision] = []
        for offset in range(n):
            client_idx = start_idx + offset
            client = state.clients[client_idx]
            dob_valid = state.dob_candidates.get(client_idx)

            best_decision_str = "AUTO_CLEAR"
            best_composite = 0.0
            best_sid = None
            best_name = None

            for emb_score, raw_idx in zip(cos_scores[offset], raw_indices[offset]):
                if raw_idx == -1:
                    continue
                if emb_score < P_EMBEDDING_THRESHOLD:
                    continue
                entry = state.index_entries[raw_idx]
                sid = entry.sanctions_id
                # DOB pre-filter
                if dob_valid is not None and sid not in dob_valid:
                    continue
                sanc = state.sanctions_lookup.get(sid)
                if sanc is None:
                    continue

                # Compute all 5 signals like our real screening_service
                jw_score = _best_token_jw(client.full_name, sanc.full_name)
                ph_score = _phonetic_score(client.full_name, sanc.full_name)
                emb_clamped = max(0.0, min(1.0, float(emb_score)))

                # DOB scoring
                dob_score = 0.0
                dob_missing = True
                c_dob = _dob_digits(client.dob)
                s_dob = _dob_digits(sanc.dob)
                if c_dob and s_dob:
                    dob_missing = False
                    if len(c_dob) >= 8 and len(s_dob) >= 8 and c_dob == s_dob:
                        dob_score = 1.0
                    elif c_dob[:4] == s_dob[:4]:
                        dob_score = 0.8
                    elif abs(int(c_dob[:4]) - int(s_dob[:4])) <= 1:
                        dob_score = 0.4

                # Country scoring
                country_score = 0.0
                country_missing = True
                if client.country_norm and sanc.country_norm:
                    country_missing = False
                    country_score = 1.0 if client.country_norm == sanc.country_norm else 0.0

                # Use our real rule engine
                bd = SignalBreakdown(
                    dob=SignalScore(signal_name="dob", score=dob_score, detail="", missing=dob_missing),
                    name_jw=SignalScore(signal_name="name_jw", score=jw_score, detail="", missing=False),
                    phonetic=SignalScore(signal_name="phonetic", score=ph_score, detail="", missing=False),
                    embedding=SignalScore(signal_name="embedding", score=emb_clamped, detail="", missing=False),
                    country=SignalScore(signal_name="country", score=country_score, detail="", missing=country_missing),
                )
                decision, _ = svc._apply_rules(bd)

                # Aggregate score for ranking
                aggregate = (jw_score * 0.3 + emb_clamped * 0.25 + ph_score * 0.15 + dob_score * 0.2 + country_score * 0.1)

                decision_priority = {"ESCALATE": 3, "NEEDS_REVIEW": 2, "AUTO_CLEAR": 1}
                if decision_priority.get(decision.value, 0) > decision_priority.get(best_decision_str, 0) or \
                   (decision_priority.get(decision.value, 0) == decision_priority.get(best_decision_str, 0) and aggregate > best_composite):
                    best_decision_str = decision.value
                    best_composite = aggregate
                    best_sid = sid
                    best_name = entry.original_name

            decisions.append(ClientDecision(
                decision=best_decision_str,
                best_score=round(best_composite, 4),
                best_sanctions_id=best_sid,
                best_match_name=best_name,
            ))

        return decisions

    # ── Confusion matrix & summary ──

    def get_confusion_matrix(self) -> ConfusionMatrix:
        state = self.state
        if state is None:
            return ConfusionMatrix()
        cm = ConfusionMatrix()
        for i in range(len(state.clients)):
            dec = state.decisions.get(i)
            if dec is None:
                continue
            is_true   = i in state.true_pairs
            is_flagged = dec.decision in ("ESCALATE", "NEEDS_REVIEW")
            if   is_true and is_flagged:     cm.tp += 1
            elif is_true and not is_flagged: cm.fn += 1
            elif not is_true and is_flagged: cm.fp += 1
            else:                            cm.tn += 1
        return cm

    def get_decisions_summary(self) -> dict:
        state = self.state
        if state is None:
            return {}
        counts: dict[str, int] = {"AUTO_CLEAR": 0, "ESCALATE": 0, "NEEDS_REVIEW": 0}
        for dec in state.decisions.values():
            counts[dec.decision] = counts.get(dec.decision, 0) + 1
        return counts
