"""Embedding service: SentenceTransformer model + FAISS index for sanctions name matching."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Sequence

import faiss
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)


def _detect_device() -> str:
    """Return 'cuda' if a usable GPU is available, otherwise 'cpu'.
    
    Note: On macOS (ARM), importing torch and calling cuda.is_available()
    can cause segfaults when combined with faiss-cpu. We guard the import
    behind a platform check — macOS never has CUDA anyway.
    """
    import sys
    if sys.platform == "darwin":
        logger.info("macOS detected — using CPU (no CUDA)")
        return "cpu"
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            logger.info("CUDA GPU detected: %s", name)
            return "cuda"
    except Exception:
        pass
    logger.info("No CUDA GPU detected — using CPU")
    return "cpu"


def _try_gpu_index(cpu_index: faiss.Index) -> faiss.Index:
    """Move a FAISS index to GPU if possible, otherwise return CPU index."""
    # Only attempt GPU if CUDA is actually available
    if _detect_device() != "cuda":
        return cpu_index
    # faiss-cpu doesn't have StandardGpuResources — check before calling
    if not hasattr(faiss, "StandardGpuResources"):
        logger.info("faiss-gpu not installed — keeping index on CPU")
        return cpu_index
    try:
        res = faiss.StandardGpuResources()
        gpu_index = faiss.index_cpu_to_gpu(res, 0, cpu_index)
        logger.info("FAISS index moved to GPU")
        return gpu_index
    except Exception:
        logger.info("FAISS GPU transfer failed — keeping index on CPU")
        return cpu_index

MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
EMBEDDING_DIM = 384
MODEL_LOAD_TIMEOUT_S = 120
ENCODE_BATCH_SIZE = 256
CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / ".index_cache"


@dataclass
class IndexEntry:
    """Maps an index position to a sanctions entry + name variant."""

    sanctions_id: str
    name_type: str  # "full_name", "alias_1", "alias_2"
    original_name: str


class EmbeddingService:
    """Manages a SentenceTransformer model and FAISS index over sanctions names."""

    def __init__(self) -> None:
        self._model: SentenceTransformer | None = None
        self._index: faiss.IndexFlatIP | None = None
        self._entries: list[IndexEntry] = []

    @property
    def model_loaded(self) -> bool:
        return self._model is not None

    @property
    def index_size(self) -> int:
        return self._index.ntotal if self._index is not None else 0

    def load_model(self) -> None:
        """Load the SentenceTransformer model. Raises RuntimeError on failure."""
        t0 = time.perf_counter()
        self._device = _detect_device()
        try:
            # On macOS, passing device= can conflict with faiss-cpu; let ST pick automatically
            import sys
            if sys.platform == "darwin":
                self._model = SentenceTransformer(MODEL_NAME)
            else:
                self._model = SentenceTransformer(MODEL_NAME, device=self._device)
        except Exception:
            # GPU load failed — fall back to CPU
            if self._device != "cpu":
                logger.warning("Failed to load model on %s — falling back to CPU", self._device)
                self._device = "cpu"
                self._model = SentenceTransformer(MODEL_NAME)
            else:
                raise
        elapsed = time.perf_counter() - t0
        logger.info("Loaded model '%s' on %s in %.2fs", MODEL_NAME, self._device, elapsed)

    def load_and_index(self, sanctions_source: str | Path | pd.DataFrame) -> None:
        """Read sanctions data, embed all name variants, build a FAISS inner-product index.
        
        Uses disk cache: if the sanctions CSV hasn't changed (same hash),
        loads pre-built index + entries from disk instead of re-encoding.
        """
        if self._model is None:
            self.load_model()

        if isinstance(sanctions_source, pd.DataFrame):
            df = sanctions_source
            source_name = "DataFrame"
        else:
            sanctions_csv_path = Path(sanctions_source)
            df = pd.read_csv(sanctions_csv_path)
            source_name = sanctions_csv_path.name

        logger.info("Read %d sanctions entries from %s", len(df), source_name)

        # Compute hash of the source data for cache key
        data_hash = _dataframe_hash(df)
        cache_key = f"{data_hash}_{MODEL_NAME}"

        # Try loading from cache
        if self._load_cache(cache_key):
            logger.info(
                "Loaded FAISS index from cache: %d vectors (hash=%s)",
                self._index.ntotal, data_hash[:12],
            )
            return

        # Cache miss — build from scratch
        entries: list[IndexEntry] = []
        texts: list[str] = []
        for row in df.itertuples(index=False):
            sid = row.Sanction_ID
            entries.append(IndexEntry(sid, "full_name", row.Full_Name))
            texts.append(row.Full_Name)

            a1 = getattr(row, "Alias_1", None)
            if _has_text(a1):
                entries.append(IndexEntry(sid, "alias_1", str(a1)))
                texts.append(str(a1))

            a2 = getattr(row, "Alias_2", None)
            if _has_text(a2):
                entries.append(IndexEntry(sid, "alias_2", str(a2)))
                texts.append(str(a2))

        logger.info("Collected %d name variants for indexing", len(texts))

        t0 = time.perf_counter()
        embeddings = self._encode_texts(texts)
        encode_elapsed = time.perf_counter() - t0
        logger.info("Encoded %d texts in %.2fs", len(texts), encode_elapsed)

        self._index = faiss.IndexFlatIP(EMBEDDING_DIM)
        if len(entries) > 0:
            self._index.add(embeddings)
        self._entries = entries

        logger.info(
            "FAISS index built: %d vectors, dim=%d (%.2fs encode)",
            self._index.ntotal, EMBEDDING_DIM, encode_elapsed,
        )

        # Save to cache (always save CPU index)
        self._save_cache(cache_key)

        # Try moving index to GPU
        self._index = _try_gpu_index(self._index)

    def _save_cache(self, cache_key: str) -> None:
        """Save FAISS index + entries to disk."""
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            index_path = CACHE_DIR / f"{cache_key}.faiss"
            entries_path = CACHE_DIR / f"{cache_key}.entries.json"

            faiss.write_index(self._index, str(index_path))
            entries_data = [asdict(e) for e in self._entries]
            entries_path.write_text(json.dumps(entries_data))

            logger.info("Saved index cache: %s (%d vectors)", cache_key[:12], self._index.ntotal)
        except Exception:
            logger.warning("Failed to save index cache", exc_info=True)

    def _load_cache(self, cache_key: str) -> bool:
        """Load FAISS index + entries from disk. Returns True if successful."""
        index_path = CACHE_DIR / f"{cache_key}.faiss"
        entries_path = CACHE_DIR / f"{cache_key}.entries.json"

        if not index_path.exists() or not entries_path.exists():
            return False

        try:
            t0 = time.perf_counter()
            self._index = faiss.read_index(str(index_path))
            entries_data = json.loads(entries_path.read_text())
            self._entries = [
                IndexEntry(e["sanctions_id"], e["name_type"], e["original_name"])
                for e in entries_data
            ]
            elapsed = time.perf_counter() - t0
            logger.info("Loaded index from cache in %.2fs", elapsed)
            # Try moving index to GPU
            self._index = _try_gpu_index(self._index)
            return True
        except Exception:
            logger.warning("Failed to load index cache — will rebuild", exc_info=True)
            return False

    def add_entry(self, name: str, sanctions_id: str, name_type: str) -> None:
        """Add a single name variant to the live FAISS index.

        Encodes the name into a normalized embedding, adds it to the index,
        and appends the corresponding IndexEntry.
        """
        if self._model is None or self._index is None:
            raise RuntimeError("EmbeddingService not initialized — call load_and_index first")

        embedding = self._encode_texts([name])
        self._index.add(embedding)
        self._entries.append(IndexEntry(sanctions_id, name_type, name))
        logger.info(
            "Added entry to index: sid=%s type=%s name='%s' (index_size=%d)",
            sanctions_id,
            name_type,
            name,
            self._index.ntotal,
        )

    def search(self, query: str, k: int = 5) -> list[dict]:
        """Search the FAISS index for the k nearest sanctions names.

        Returns list of dicts with keys: sanctions_id, name_type, original_name, score.
        Scores are cosine similarities (inner product of L2-normalized vectors).
        """
        results = self.search_many([query], k=k)
        return results[0] if results else []

    def search_many(self, queries: Sequence[str], k: int = 5) -> list[list[dict]]:
        """Search the FAISS index for many queries in one batched model encode/search."""
        if self._index is None or self._model is None:
            raise RuntimeError("EmbeddingService not initialized — call load_and_index first")
        if not queries:
            return []

        query_embeddings = self._encode_texts(list(queries))
        return self._search_embeddings(query_embeddings, k)

    def _encode_texts(self, texts: Sequence[str]) -> np.ndarray:
        """Encode text into float32 cosine-ready embeddings."""
        if self._model is None:
            raise RuntimeError("EmbeddingService model not loaded")
        if not texts:
            return np.empty((0, EMBEDDING_DIM), dtype=np.float32)

        embeddings = self._model.encode(
            list(texts),
            batch_size=ENCODE_BATCH_SIZE,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        embeddings = np.asarray(embeddings, dtype=np.float32)
        if embeddings.ndim == 1:
            embeddings = embeddings.reshape(1, -1)
        if embeddings.shape[1] != EMBEDDING_DIM:
            raise ValueError(
                f"Expected embedding dim={EMBEDDING_DIM}, got {embeddings.shape[1]}"
            )
        return embeddings

    def _search_embeddings(self, query_embeddings: np.ndarray, k: int) -> list[list[dict]]:
        """Run a FAISS search for precomputed query embeddings."""
        if self._index is None:
            raise RuntimeError("EmbeddingService index not initialized")

        scores, indices = self._index.search(query_embeddings, k)
        all_results: list[list[dict]] = []

        for row_scores, row_indices in zip(scores, indices):
            row_results: list[dict] = []
            for score, idx in zip(row_scores, row_indices):
                if idx == -1:
                    continue  # FAISS returns -1 for missing results when k > ntotal
                entry = self._entries[idx]
                row_results.append(
                    {
                        "sanctions_id": entry.sanctions_id,
                        "name_type": entry.name_type,
                        "original_name": entry.original_name,
                        "score": float(score),
                    }
                )
            all_results.append(row_results)

        return all_results


def _has_text(value: object) -> bool:
    """Return True when a dataframe field contains a non-empty text value."""
    return pd.notna(value) and str(value).strip() != ""


def _dataframe_hash(df: pd.DataFrame) -> str:
    """Fast hash of DataFrame content for cache invalidation."""
    # Hash row count + first/last rows + column names
    sig = f"{len(df)}|{list(df.columns)}|{df.iloc[0].to_dict() if len(df) > 0 else ''}|{df.iloc[-1].to_dict() if len(df) > 0 else ''}"
    return hashlib.md5(sig.encode()).hexdigest()
