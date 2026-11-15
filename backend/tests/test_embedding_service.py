"""Tests for EmbeddingService — model loading, index building, and answer-key accuracy."""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd
import pytest

from app.services.embedding_service import EmbeddingService

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SANCTIONS_CSV = DATA_DIR / "sanctions_list.csv"
ANSWER_KEY_CSV = DATA_DIR / "answer_key.csv"

logger = logging.getLogger(__name__)


@pytest.fixture(scope="module")
def embedding_service() -> EmbeddingService:
    """Load model and build FAISS index once for all tests in this module."""
    svc = EmbeddingService()
    svc.load_and_index(SANCTIONS_CSV)
    return svc


@pytest.fixture(scope="module")
def answer_key() -> pd.DataFrame:
    return pd.read_csv(ANSWER_KEY_CSV)


class TestModelAndIndex:
    """Basic service initialization tests."""

    def test_model_loads_successfully(self, embedding_service: EmbeddingService) -> None:
        assert embedding_service.model_loaded is True

    def test_index_has_89_entries(self, embedding_service: EmbeddingService) -> None:
        """30 full names + 30 alias_1 + 29 alias_2 (EU-0026 alias_2 is NaN) = 89."""
        assert embedding_service.index_size == 89

    def test_search_returns_list_of_dicts(self, embedding_service: EmbeddingService) -> None:
        results = embedding_service.search("test name", k=5)
        assert isinstance(results, list)
        assert len(results) <= 5
        for r in results:
            assert "sanctions_id" in r
            assert "name_type" in r
            assert "original_name" in r
            assert "score" in r

    def test_search_many_matches_single_search(self, embedding_service: EmbeddingService) -> None:
        queries = [
            "Kasim Suleymani",
            "John Michael Thompson",
            "A",
        ]
        batch_results = embedding_service.search_many(queries, k=5)
        assert len(batch_results) == len(queries)

        for query, batch_result in zip(queries, batch_results):
            single_result = embedding_service.search(query, k=5)
            assert batch_result == single_result


class TestAnswerKeyAccuracy:
    """All 10 answer-key targets must appear in top-5 with correct sanctions_id."""

    def test_all_10_targets_found_in_top5(
        self,
        embedding_service: EmbeddingService,
        answer_key: pd.DataFrame,
    ) -> None:
        """Core accuracy test: each obfuscated name must match the expected sanctions entry."""
        failures: list[str] = []

        for _, row in answer_key.iterrows():
            query = row["Obfuscated_Name_in_Customer_List"]
            expected_id = row["Original_Sanction_ID"]
            results = embedding_service.search(query, k=5)

            top_ids = [r["sanctions_id"] for r in results]
            top_score = results[0]["score"] if results else 0.0

            # Log actual scores for threshold tuning
            logger.info(
                "Query: %-30s | Expected: %s | Top match: %s (%.4f) | Top-5 IDs: %s",
                query,
                expected_id,
                top_ids[0] if top_ids else "NONE",
                top_score,
                top_ids,
            )

            if expected_id not in top_ids:
                failures.append(
                    f"'{query}' → expected {expected_id} in top-5, got {top_ids}"
                )

        assert not failures, "Answer key targets not found in top-5:\n" + "\n".join(failures)

    def test_all_10_targets_score_above_060(
        self,
        embedding_service: EmbeddingService,
        answer_key: pd.DataFrame,
    ) -> None:
        """All targets must score ≥ 0.60 to pass the default threshold."""
        below_threshold: list[str] = []

        for _, row in answer_key.iterrows():
            query = row["Obfuscated_Name_in_Customer_List"]
            expected_id = row["Original_Sanction_ID"]
            results = embedding_service.search(query, k=5)

            # Find the score for the expected sanctions entry
            target_score: float | None = None
            for r in results:
                if r["sanctions_id"] == expected_id:
                    target_score = r["score"]
                    break

            if target_score is None:
                below_threshold.append(
                    f"'{query}' → {expected_id} not found in top-5 at all"
                )
            elif target_score < 0.60:
                below_threshold.append(
                    f"'{query}' → {expected_id} score={target_score:.4f} (below 0.60)"
                )
            else:
                logger.info(
                    "✓ %-30s → %s score=%.4f (above 0.60)",
                    query,
                    expected_id,
                    target_score,
                )

        assert not below_threshold, (
            "Targets below threshold 0.60:\n" + "\n".join(below_threshold)
        )


class TestEdgeCases:
    """Boundary conditions and malformed inputs."""

    def test_gibberish_returns_low_scores(self, embedding_service: EmbeddingService) -> None:
        """Random nonsense should score well below 0.60."""
        results = embedding_service.search("xyzzyplugh42 qwfpgjluy", k=5)
        assert results, "Should still return results even for gibberish"
        for r in results:
            assert r["score"] < 0.60, f"Gibberish matched {r['original_name']} at {r['score']:.4f}"

    def test_empty_string_returns_results(self, embedding_service: EmbeddingService) -> None:
        """Empty string query should return results (with low scores), not crash."""
        results = embedding_service.search("", k=5)
        assert isinstance(results, list)

    def test_single_character_name(self, embedding_service: EmbeddingService) -> None:
        results = embedding_service.search("A", k=5)
        assert isinstance(results, list)
        assert len(results) <= 5

    def test_long_name_200_chars(self, embedding_service: EmbeddingService) -> None:
        long_name = "A" * 200
        results = embedding_service.search(long_name, k=5)
        assert isinstance(results, list)

    def test_special_characters_in_name(self, embedding_service: EmbeddingService) -> None:
        results = embedding_service.search("O'Brien-Smith #123", k=5)
        assert isinstance(results, list)
