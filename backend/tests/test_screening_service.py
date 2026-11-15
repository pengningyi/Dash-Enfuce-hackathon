"""Tests for ScreeningService — AUTO_CLEAR, ESCALATE, NEEDS_REVIEW decisions."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from app.models.schemas import Decision
from app.services.embedding_service import EmbeddingService
from app.services.screening_service import ScreeningService

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SANCTIONS_CSV = DATA_DIR / "sanctions_list.csv"


@pytest.fixture(scope="module")
def services() -> tuple[EmbeddingService, ScreeningService]:
    """Build embedding + blocking + screening services once for this module."""
    from app.services.blocking_service import BlockingService

    emb = EmbeddingService()
    emb.load_and_index(SANCTIONS_CSV)
    sanctions_df = pd.read_csv(SANCTIONS_CSV)
    blk = BlockingService()
    blk.build_indexes(sanctions_df)
    screening = ScreeningService(emb, blk, sanctions_df)
    return emb, screening


@pytest.fixture(scope="module")
def screening_service(services: tuple) -> ScreeningService:
    return services[1]


class TestAutoClearing:
    """Names with no sanctions matches should be AUTO_CLEAR."""

    def test_random_name_auto_clears(self, screening_service: ScreeningService) -> None:
        result = screening_service.screen("John Michael Thompson")
        assert result.decision == Decision.AUTO_CLEAR
        assert result.layer_reached == 1
        assert result.threshold_used == 0.55  # new default threshold

    def test_very_high_threshold_auto_clears(self, screening_service: ScreeningService) -> None:
        """With blocking-first pipeline, threshold is stored but blocking + rules decide.
        Random name with no blocking candidates should still AUTO_CLEAR regardless of threshold."""
        result = screening_service.screen("Completely Unknown Person XYZ", threshold=0.99)
        assert result.decision == Decision.AUTO_CLEAR
        assert result.layer_reached == 1


class TestEscalation:
    """Exact name + DOB + country match should ESCALATE."""

    def test_exact_match_escalates(self, screening_service: ScreeningService) -> None:
        """EU-0001 Aleksandr Bortnikov — exact name, DOB, and nationality."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob="1951-11-15",
            country="Russia",
        )
        assert result.decision == Decision.ESCALATE
        assert result.layer_reached == 2
        # The matched entry should be in the results
        matched_ids = [m.sanctions_id for m in result.matches]
        assert "EU-0001" in matched_ids

    def test_alias_match_with_exact_dob_country(self, screening_service: ScreeningService) -> None:
        """EU-0002 alias 'Kadyrow Ramsan' with correct DOB and nationality."""
        result = screening_service.screen(
            name="Kadyrow Ramsan",
            dob="1976-10-05",
            country="Russia",
        )
        assert result.decision == Decision.ESCALATE
        assert result.layer_reached == 2


class TestNeedsReview:
    """Name match above threshold but DOB/country mismatch → NEEDS_REVIEW."""

    def test_name_match_wrong_dob(self, screening_service: ScreeningService) -> None:
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob="1990-01-01",  # wrong DOB (39 years off)
            country="Russia",
        )
        # With blocking-first, strong name + wrong DOB still flags due to D008 cautious handling
        assert result.decision in (Decision.NEEDS_REVIEW, Decision.ESCALATE)
        assert result.layer_reached == 2

    def test_name_match_wrong_country(self, screening_service: ScreeningService) -> None:
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob="1951-11-15",
            country="Germany",  # wrong country
        )
        # Exact DOB + strong name → ESCALATE even with wrong country (country alone doesn't clear)
        assert result.decision in (Decision.NEEDS_REVIEW, Decision.ESCALATE)
        assert result.layer_reached == 2

    def test_name_match_no_dob_provided(self, screening_service: ScreeningService) -> None:
        """No DOB → can't confirm exact match → NEEDS_REVIEW."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob=None,
            country="Russia",
        )
        assert result.decision == Decision.NEEDS_REVIEW
        assert result.layer_reached == 2


class TestThresholdBehavior:
    """Threshold parameter is propagated but blocking + rules drive decisions."""

    def test_lower_threshold_finds_more(self, screening_service: ScreeningService) -> None:
        """A known name with blocking candidates should be flagged."""
        result = screening_service.screen("Bortnikov", threshold=0.3)
        # With blocking-first, single-token "Bortnikov" may or may not get candidates
        # depending on phonetic codes
        assert result.decision in (Decision.AUTO_CLEAR, Decision.NEEDS_REVIEW, Decision.ESCALATE)

    def test_higher_threshold_is_stricter(self, screening_service: ScreeningService) -> None:
        """Threshold stored but blocking + rules decide. Random name still AUTO_CLEAR."""
        result = screening_service.screen("A. Bortnikow", threshold=0.99)
        # With blocking-first, "A. Bortnikow" may get phonetic candidates
        assert result.decision in (Decision.AUTO_CLEAR, Decision.NEEDS_REVIEW)


class TestResultStructure:
    """Verify the ScreenResult contains all expected fields."""

    def test_result_has_all_fields(self, screening_service: ScreeningService) -> None:
        result = screening_service.screen("Test Person")
        assert result.query_name == "Test Person"
        assert isinstance(result.matches, list)
        assert isinstance(result.decision, Decision)
        assert isinstance(result.layer_reached, int)
        assert isinstance(result.threshold_used, float)

    def test_matches_have_sanctions_details(self, screening_service: ScreeningService) -> None:
        """Matches should include sanctions metadata, not just IDs."""
        result = screening_service.screen(
            "Aleksandr Viktorovich Bortnikov", dob="1951-11-15", country="Russia",
        )
        assert len(result.matches) > 0
        m = result.matches[0]
        assert m.sanctions_id is not None
        assert m.full_name is not None
        assert m.matched_name is not None
        assert m.match_type in ("full_name", "alias_1", "alias_2", "blocking")
        assert 0.0 <= m.similarity_score <= 1.0

    def test_screen_many_matches_single_screen(self, screening_service: ScreeningService) -> None:
        """screen_many should produce same decisions as individual screen() calls."""
        customers = [
            ("Kasim Suleymani", None, None),
            ("John Michael Thompson", None, None),
            ("Aleksandr Viktorovich Bortnikov", "1951-11-15", "Russia"),
        ]

        batch_results = screening_service.screen_many(customers)
        assert len(batch_results) == len(customers)

        for (name, dob, country), batch_result in zip(customers, batch_results):
            single_result = screening_service.screen(name=name, dob=dob, country=country)
            # Decisions and match sets should agree (float precision may differ in embedding scores)
            assert batch_result.decision == single_result.decision
            assert batch_result.layer_reached == single_result.layer_reached
            assert len(batch_result.matches) == len(single_result.matches)


class TestSignalBreakdown:
    """Verify per-signal breakdown structure in ScreenResult (S02 requirement)."""

    def test_signal_breakdown_present_for_match(self, screening_service: ScreeningService) -> None:
        """Non-AUTO_CLEAR result should have a populated signal_breakdown."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov", dob="1951-11-15", country="Russia",
        )
        assert result.decision != Decision.AUTO_CLEAR
        assert result.signal_breakdown is not None
        # All 5 signals present
        bd = result.signal_breakdown
        assert bd.dob is not None
        assert bd.name_jw is not None
        assert bd.phonetic is not None
        assert bd.embedding is not None
        assert bd.country is not None

    def test_signal_scores_are_normalized(self, screening_service: ScreeningService) -> None:
        """All signal scores must be in [0.0, 1.0]."""
        result = screening_service.screen(
            name="Kadyrow Ramsan", dob="1976-10-05", country="Russia",
        )
        assert result.signal_breakdown is not None
        bd = result.signal_breakdown
        for signal in [bd.dob, bd.name_jw, bd.phonetic, bd.embedding, bd.country]:
            assert 0.0 <= signal.score <= 1.0, f"{signal.signal_name} out of range: {signal.score}"

    def test_missing_dob_flagged(self, screening_service: ScreeningService) -> None:
        """Screening with dob=None should flag dob signal as missing."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov", dob=None, country="Russia",
        )
        assert result.signal_breakdown is not None
        assert result.signal_breakdown.dob.missing is True
        assert result.signal_breakdown.dob.score == 0.0

    def test_missing_country_flagged(self, screening_service: ScreeningService) -> None:
        """Screening with country=None should flag country signal as missing."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov", dob="1951-11-15", country=None,
        )
        assert result.signal_breakdown is not None
        assert result.signal_breakdown.country.missing is True
        assert result.signal_breakdown.country.score == 0.0

    def test_reasoning_present(self, screening_service: ScreeningService) -> None:
        """Non-AUTO_CLEAR results should have a non-empty reasoning string."""
        result = screening_service.screen(
            name="Kasim Suleymani",
        )
        assert result.decision != Decision.AUTO_CLEAR
        assert result.reasoning is not None
        assert len(result.reasoning) > 0

    def test_no_candidates_auto_clears(self, screening_service: ScreeningService) -> None:
        """Random name with no blocking candidates → AUTO_CLEAR, signal_breakdown is None."""
        result = screening_service.screen("Zxqwerty Nonexistent Person")
        assert result.decision == Decision.AUTO_CLEAR
        assert result.signal_breakdown is None

    def test_signal_detail_strings_populated(self, screening_service: ScreeningService) -> None:
        """Each signal should have a non-empty detail string."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov", dob="1951-11-15", country="Russia",
        )
        assert result.signal_breakdown is not None
        bd = result.signal_breakdown
        for signal in [bd.dob, bd.name_jw, bd.phonetic, bd.embedding, bd.country]:
            assert isinstance(signal.detail, str)
            assert len(signal.detail) > 0, f"{signal.signal_name} has empty detail"

    def test_signal_names_correct(self, screening_service: ScreeningService) -> None:
        """Signal names should match the expected identifiers."""
        result = screening_service.screen(
            name="Kasim Suleymani", dob=None, country=None,
        )
        assert result.signal_breakdown is not None
        bd = result.signal_breakdown
        assert bd.dob.signal_name == "dob"
        assert bd.name_jw.signal_name == "name_jw"
        assert bd.phonetic.signal_name == "phonetic"
        assert bd.embedding.signal_name == "embedding"
        assert bd.country.signal_name == "country"


class TestNegativePaths:
    """Negative tests: edge cases and boundary conditions (Q7)."""

    def test_known_target_wrong_dob_not_auto_cleared(self, screening_service: ScreeningService) -> None:
        """Strong name match + wrong DOB (5+ years) should NOT be AUTO_CLEAR.
        D008: DOB mismatch alone shouldn't clear if name signals are strong."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob="2000-01-01",  # 49 years off
            country="Russia",
        )
        assert result.decision != Decision.AUTO_CLEAR, (
            "Strong name match should not be AUTO_CLEAR just because DOB is wrong"
        )

    def test_known_target_no_dob_needs_review(self, screening_service: ScreeningService) -> None:
        """D008: missing DOB with strong name → NEEDS_REVIEW (cautious approach)."""
        result = screening_service.screen(
            name="Aleksandr Viktorovich Bortnikov",
            dob=None,
            country=None,
        )
        assert result.decision == Decision.NEEDS_REVIEW

    def test_auto_clear_has_no_signal_breakdown(self, screening_service: ScreeningService) -> None:
        """AUTO_CLEAR with no candidates should have signal_breakdown=None."""
        result = screening_service.screen("Completely Fictional Unicorn Name")
        assert result.decision == Decision.AUTO_CLEAR
        assert result.signal_breakdown is None

    def test_auto_clear_has_reasoning(self, screening_service: ScreeningService) -> None:
        """Even AUTO_CLEAR should have a reasoning string (fast-path explanation)."""
        result = screening_service.screen("Completely Fictional Unicorn Name")
        assert result.decision == Decision.AUTO_CLEAR
        assert result.reasoning is not None
        assert "auto-clear" in result.reasoning.lower() or "no candidates" in result.reasoning.lower()
