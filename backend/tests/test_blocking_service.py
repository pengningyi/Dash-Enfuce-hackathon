"""Tests for BlockingService — recall, selectivity, edge cases, and negative paths."""

from __future__ import annotations

import os

import pandas as pd
import pytest

from app.services.blocking_service import BlockingService, _extract_year, _metaphone_codes


# ── Fixtures ──

@pytest.fixture(scope="module")
def sanctions_df() -> pd.DataFrame:
    return pd.read_csv("data/sanctions_list.csv")


@pytest.fixture(scope="module")
def customers_df() -> pd.DataFrame:
    return pd.read_csv("data/customers.csv")


@pytest.fixture(scope="module")
def answer_key() -> pd.DataFrame:
    return pd.read_csv("data/answer_key.csv")


@pytest.fixture(scope="module")
def blocking_service(sanctions_df: pd.DataFrame) -> BlockingService:
    svc = BlockingService()
    svc.build_indexes(sanctions_df)
    return svc


# ── Index build tests ──

class TestBuildIndexes:
    def test_build_indexes_counts(self, blocking_service: BlockingService, sanctions_df: pd.DataFrame) -> None:
        stats = blocking_service.index_stats
        # Should index all 30 sanctions entries
        assert stats["sanctions_entries"] == 30
        # Should have DOB years for entries with parseable dates
        assert stats["dob_years"] > 0
        # Should have phonetic codes
        assert stats["phonetic_codes"] > 0

    def test_index_stats(self, blocking_service: BlockingService) -> None:
        stats = blocking_service.index_stats
        assert set(stats.keys()) == {"dob_years", "phonetic_codes", "sanctions_entries"}
        assert all(isinstance(v, int) for v in stats.values())
        assert stats["sanctions_entries"] == 30

    def test_nan_alias_handling(self, blocking_service: BlockingService) -> None:
        """EU-0026 has NaN Alias_2 — build should not error (K001)."""
        stats = blocking_service.index_stats
        # If we got here without error, NaN was handled. Double-check EU-0026 is indexed.
        assert "EU-0026" in blocking_service._sanctions_data


# ── Recall tests — all 10 answer-key targets must be found ──

# (customer_name, customer_dob, expected_sanction_id, label)
ANSWER_KEY_TARGETS = [
    ("A. Bortnikow", "1951-11-15", "EU-0001", "Bortnikov via German transliteration"),
    ("Kadyrow Ramsan", "1976-10-05", "EU-0002", "Kadyrov reversed + German"),
    ("Hasan Nasrollah", "1960-08-31", "EU-0004", "Nasrallah phonetic variant"),
    ("M. Javad Zarief", "1960-01-08", "EU-0007", "Zarif initial + spelling"),
    ("Kasim Suleymani", "1957-03-11", "EU-0009", "Soleimani Turkish phonetic"),
    ("S.K. Shoigu", "1955-05-21", "EU-0015", "Shoigu abbreviated initials"),
    ("Hussein Selami", "1960-09-22", "EU-0025", "Salami Arabic/Turkish variant"),
    ("Olek Deripaska", "1968-01-02", "EU-0027", "Deripaska typo g→k"),
    ("Ismael Haniye", "1963-01-29", "EU-0029", "Haniyeh French spelling"),
    ("Margarita Simonjan", "1980-04-06", "EU-0030", "Simonyan phonetic yan→jan"),
]


class TestRecall:
    @pytest.mark.parametrize(
        "customer_name,customer_dob,expected_sid,label",
        ANSWER_KEY_TARGETS,
        ids=[t[3] for t in ANSWER_KEY_TARGETS],
    )
    def test_target_found(
        self,
        blocking_service: BlockingService,
        customer_name: str,
        customer_dob: str,
        expected_sid: str,
        label: str,
    ) -> None:
        candidates = blocking_service.get_candidates(customer_name, customer_dob)
        found_ids = {c.sanction_id for c in candidates}
        assert expected_sid in found_ids, (
            f"Target {expected_sid} ({label}) not found in candidates: {found_ids}"
        )

    def test_all_ten_targets_found(self, blocking_service: BlockingService) -> None:
        """Belt-and-suspenders: verify all 10 targets in one sweep."""
        missed = []
        for name, dob, expected_sid, label in ANSWER_KEY_TARGETS:
            candidates = blocking_service.get_candidates(name, dob)
            found_ids = {c.sanction_id for c in candidates}
            if expected_sid not in found_ids:
                missed.append(f"{expected_sid} ({label})")
        assert not missed, f"Missed targets: {missed}"


# ── Selectivity tests ──

class TestSelectivity:
    def test_selectivity_fast(self, blocking_service: BlockingService) -> None:
        """Quick check: 10 targets produce a bounded number of candidates."""
        total_pairs = 0
        for name, dob, _, _ in ANSWER_KEY_TARGETS:
            total_pairs += len(blocking_service.get_candidates(name, dob))
        # 10 targets should produce far fewer than 500 total pairs
        assert total_pairs < 200, f"10 targets produced {total_pairs} pairs (expect <200)"

    @pytest.mark.skipif(
        not os.environ.get("RUN_SLOW_TESTS"),
        reason="Slow: iterates 100K customers. Set RUN_SLOW_TESTS=1 to run.",
    )
    def test_selectivity_under_500(
        self,
        blocking_service: BlockingService,
        customers_df: pd.DataFrame,
    ) -> None:
        """Full 100K customer sweep: total candidate pairs must be < 500."""
        total_pairs = 0
        for _, row in customers_df.iterrows():
            name = str(row["Full_Name"])
            dob_raw = row.get("Date_of_Birth")
            dob = str(dob_raw) if pd.notna(dob_raw) else None
            total_pairs += len(blocking_service.get_candidates(name, dob))
        assert total_pairs < 500, f"100K customers produced {total_pairs} pairs (expect <500)"


# ── Edge cases and fallbacks ──

class TestEdgeCases:
    def test_missing_dob_fallback(self, blocking_service: BlockingService) -> None:
        """Customer with no DOB should use phonetic-only fallback."""
        candidates = blocking_service.get_candidates("Hassan Nasrallah", None)
        found_ids = {c.sanction_id for c in candidates}
        assert "EU-0004" in found_ids, f"EU-0004 not found in phonetic fallback: {found_ids}"
        # Verify the reason is the fallback path
        eu4 = [c for c in candidates if c.sanction_id == "EU-0004"][0]
        assert "phonetic_no_dob" in eu4.blocking_reasons

    def test_bortnikov_phonetic_miss(self) -> None:
        """EU-0001 'Bortnikow' vs 'Bortnikov' have different Metaphone codes,
        confirming why DOB intersection is essential for this case."""
        import jellyfish

        code_w = jellyfish.metaphone("bortnikow")
        code_v = jellyfish.metaphone("bortnikov")
        assert code_w != code_v, (
            f"Expected different codes but got {code_w} == {code_v}"
        )
        # But the alias 'Bortnikow Aleksandr' in sanctions data bridges via the alias index

    def test_add_entry_live_reindex(self, sanctions_df: pd.DataFrame) -> None:
        """Live add_entry() makes new entries immediately searchable (K008)."""
        svc = BlockingService()
        svc.build_indexes(sanctions_df)
        initial_count = svc.index_stats["sanctions_entries"]

        svc.add_entry(
            sanction_id="TEST-001",
            full_name="John Testington",
            dob="1990-06-15",
            aliases=["J. Testington", "Johnny Test"],
        )

        assert svc.index_stats["sanctions_entries"] >= initial_count + 1

        # New entry should be findable
        candidates = svc.get_candidates("John Testington", "1990-06-15")
        found_ids = {c.sanction_id for c in candidates}
        assert "TEST-001" in found_ids

    def test_blocking_reasons_populated(self, blocking_service: BlockingService) -> None:
        """Blocking reasons should be non-empty frozensets."""
        candidates = blocking_service.get_candidates("Kadyrow Ramsan", "1976-10-05")
        assert len(candidates) > 0
        for c in candidates:
            assert isinstance(c.blocking_reasons, frozenset)
            assert len(c.blocking_reasons) > 0


# ── Negative tests ──

class TestNegativePaths:
    def test_empty_name_returns_empty(self, blocking_service: BlockingService) -> None:
        assert blocking_service.get_candidates("", "1990-01-01") == []

    def test_whitespace_name_returns_empty(self, blocking_service: BlockingService) -> None:
        assert blocking_service.get_candidates("   ", "1990-01-01") == []

    def test_none_dob_uses_fallback(self, blocking_service: BlockingService) -> None:
        """None DOB should not crash — uses phonetic-only fallback."""
        candidates = blocking_service.get_candidates("Some Name", None)
        assert isinstance(candidates, list)

    def test_no_match_returns_empty(self, blocking_service: BlockingService) -> None:
        """Customer matching zero sanctions entries → empty list."""
        candidates = blocking_service.get_candidates("Zzzzxyzzy Qqqqqwerty", "2005-01-01")
        assert candidates == []

    def test_many_matches_all_returned(self, blocking_service: BlockingService) -> None:
        """Customer matching many entries → all should be returned."""
        # Hassan Nasrallah with DOB should match at least EU-0004
        # May also match other entries sharing year 1960 + phonetic overlap
        candidates = blocking_service.get_candidates("Hassan Nasrallah", "1960-08-31")
        assert len(candidates) >= 1
        found_ids = {c.sanction_id for c in candidates}
        assert "EU-0004" in found_ids


# ── Helper function tests ──

class TestHelpers:
    @pytest.mark.parametrize(
        "date_str,expected",
        [
            ("1990-01-15", 1990),
            ("15/01/1990", 1990),
            ("1990", 1990),
            ("2000-12-31", 2000),
            ("no date", None),
            ("", None),
            (None, None),
        ],
    )
    def test_extract_year(self, date_str: str | None, expected: int | None) -> None:
        assert _extract_year(date_str) == expected

    def test_metaphone_codes_basic(self) -> None:
        codes = _metaphone_codes("Hassan Nasrallah")
        assert "HSN" in codes
        assert "NSRL" in codes

    def test_metaphone_codes_skip_short_tokens(self) -> None:
        """Single-char tokens (like initials) should be skipped."""
        codes = _metaphone_codes("A. Bortnikow")
        # 'a' is <2 chars after cleaning, should be skipped
        # 'bortnikow' should produce a code
        assert len(codes) >= 1
        assert "BRTNK" in codes
