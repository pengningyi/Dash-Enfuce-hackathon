"""Screening service: blocking-first multi-signal pipeline with rule-based decisions.

Pipeline:
  1. BlockingService.get_candidates() — narrow 100K+ to small candidate set
  2. Per-signal independent scoring (5 signals: DOB, name JW, phonetic, embedding, country)
  3. Rule-based decision engine — ESCALATE / NEEDS_REVIEW / AUTO_CLEAR
  4. Human-readable reasoning string for every non-trivial decision
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Sequence

import jellyfish
import pandas as pd
from unidecode import unidecode

from app.models.schemas import (
    Decision,
    SanctionsMatch,
    ScreenResult,
    SignalBreakdown,
    SignalScore,
)
from app.services.blocking_service import BlockingService
from app.services.embedding_service import EmbeddingService

logger = logging.getLogger(__name__)

# ── Batch settings ──
DEFAULT_BATCH_SIZE = 256


@dataclass(frozen=True)
class SanctionsRecord:
    """Pre-sanitized sanctions row for fast repeated lookups."""
    sanctions_id: str
    full_name: str
    date_of_birth: str | None
    nationality: str | None
    sanctions_program: str | None
    reason_for_listing: str | None


class ScreeningService:
    """Blocking → multi-signal scoring → rule-based decision pipeline."""

    def __init__(
        self,
        embedding_service: EmbeddingService,
        blocking_service: BlockingService,
        sanctions_df: pd.DataFrame,
    ) -> None:
        self._embedding = embedding_service
        self._blocking = blocking_service
        self._sanctions = sanctions_df
        self._sanctions_by_id: dict[str, SanctionsRecord] = {
            row.Sanction_ID: SanctionsRecord(
                sanctions_id=row.Sanction_ID,
                full_name=row.Full_Name,
                date_of_birth=_safe_str(getattr(row, "Date_of_Birth", None)),
                nationality=_safe_str(getattr(row, "Nationality", None)),
                sanctions_program=_safe_str(getattr(row, "Sanctions_Program", None)),
                reason_for_listing=_safe_str(getattr(row, "Reason_for_Listing", None)),
            )
            for row in sanctions_df.itertuples(index=False)
        }

    def add_sanction_record(self, record: dict[str, object]) -> None:
        """Keep the in-memory sanctions lookup in sync with new live entries."""
        sanctions_id = str(record["Sanction_ID"])
        self._sanctions_by_id[sanctions_id] = SanctionsRecord(
            sanctions_id=sanctions_id,
            full_name=str(record["Full_Name"]),
            date_of_birth=_safe_str(record.get("Date_of_Birth")),
            nationality=_safe_str(record.get("Nationality")),
            sanctions_program=_safe_str(record.get("Sanctions_Program")),
            reason_for_listing=_safe_str(record.get("Reason_for_Listing")),
        )

    # ═══════════════════════════════════════════════════════════
    # Public API
    # ═══════════════════════════════════════════════════════════

    def screen(
        self,
        name: str,
        dob: str | None = None,
        country: str | None = None,
        threshold: float = 0.55,
    ) -> ScreenResult:
        """Screen a single customer against the sanctions list.

        Pipeline: blocking → per-signal scoring → rule-based decision.
        Uses embedding fallback for cross-script names when blocking
        produces no candidates (non-Latin scripts don't generate
        useful phonetic codes even after transliteration).
        """
        candidates = self._blocking.get_candidates(name, dob)
        blocking_candidate_sids = {cp.sanction_id for cp in candidates}

        # Global embedding search (once per customer, reuse across candidates)
        embedding_results = self._embedding.search(name, k=10)
        embedding_by_sid: dict[str, float] = {}
        for er in embedding_results:
            sid = er["sanctions_id"]
            # Keep best score per sanctions_id (may appear via multiple name variants)
            if sid not in embedding_by_sid or er["score"] > embedding_by_sid[sid]:
                embedding_by_sid[sid] = er["score"]

        # Embedding fallback: add high-scoring embedding matches that blocking missed.
        # This catches cross-script pairs where phonetic blocking can't generate codes
        # (e.g., Hebrew רוברט or Arabic جان have no Latin-letter overlap even after
        # transliteration via Unidecode).
        # Threshold matches the main pipeline embedding threshold (0.55) — lower values
        # cause excessive FP from surname overlap.
        EMBEDDING_FALLBACK_THRESHOLD = 0.55
        for er in embedding_results:
            sid = er["sanctions_id"]
            if sid not in blocking_candidate_sids and er["score"] >= EMBEDDING_FALLBACK_THRESHOLD:
                entry = self._sanctions_by_id.get(sid)
                if entry is not None:
                    from app.services.blocking_service import CandidatePair
                    candidates.append(CandidatePair(
                        sanction_id=sid,
                        blocking_reasons=frozenset(["embedding_fallback"]),
                    ))
                    blocking_candidate_sids.add(sid)

        # Fast path: no candidates at all → AUTO_CLEAR
        if not candidates:
            logger.info("AUTO_CLEAR: '%s' — no blocking or embedding candidates", name)
            return ScreenResult(
                query_name=name,
                matches=[],
                decision=Decision.AUTO_CLEAR,
                layer_reached=1,
                threshold_used=threshold,
                signal_breakdown=None,
                reasoning="No candidates from blocking or embedding — auto-cleared",
            )

        # Score each blocking candidate independently
        best_breakdown: SignalBreakdown | None = None
        best_decision = Decision.AUTO_CLEAR
        best_reasoning = ""
        best_aggregate = -1.0
        best_match: SanctionsMatch | None = None
        matches: list[SanctionsMatch] = []

        for cp in candidates:
            entry = self._sanctions_by_id.get(cp.sanction_id)
            if entry is None:
                continue

            breakdown = self._score_candidate(
                name, dob, country, entry, embedding_by_sid.get(cp.sanction_id, 0.0),
            )
            decision, reasoning = self._decide(breakdown)
            aggregate = self._aggregate_strength(breakdown)

            match = SanctionsMatch(
                sanctions_id=entry.sanctions_id,
                full_name=entry.full_name,
                matched_name=entry.full_name,
                match_type="blocking",
                similarity_score=round(aggregate, 4),
                date_of_birth=entry.date_of_birth,
                nationality=entry.nationality,
                sanctions_program=entry.sanctions_program,
                reason_for_listing=entry.reason_for_listing,
            )
            matches.append(match)

            # Pick the strongest candidate
            decision_priority = {Decision.ESCALATE: 3, Decision.NEEDS_REVIEW: 2, Decision.AUTO_CLEAR: 1}
            candidate_priority = decision_priority[decision]
            best_priority = decision_priority[best_decision]

            if candidate_priority > best_priority or (candidate_priority == best_priority and aggregate > best_aggregate):
                best_breakdown = breakdown
                best_decision = decision
                best_reasoning = reasoning
                best_aggregate = aggregate
                best_match = match

        # Sort matches: best (decision-triggering) match first, then by aggregate score
        if best_match and matches:
            matches = sorted(matches, key=lambda m: m.similarity_score, reverse=True)
            # Ensure best_match is always first regardless of aggregate
            if matches[0].sanctions_id != best_match.sanctions_id:
                matches = [m for m in matches if m.sanctions_id != best_match.sanctions_id]
                matches.insert(0, best_match)

        layer = 2 if best_decision != Decision.AUTO_CLEAR else 1
        logger.info(
            "%s: '%s' → %s (aggregate=%.3f, candidates=%d)",
            best_decision.value, name,
            best_match.sanctions_id if best_match else "none",
            best_aggregate, len(candidates),
        )

        return ScreenResult(
            query_name=name,
            matches=matches,
            decision=best_decision,
            layer_reached=layer,
            threshold_used=threshold,
            signal_breakdown=best_breakdown,
            reasoning=best_reasoning if best_reasoning else None,
        )

    def screen_many(
        self,
        customers: Sequence[tuple[str, str | None, str | None]],
        threshold: float = 0.55,
        chunk_size: int = DEFAULT_BATCH_SIZE,
    ) -> list[ScreenResult]:
        """Screen many customers. Uses batched embedding search for efficiency."""
        if not customers:
            return []

        results: list[ScreenResult] = []

        for start in range(0, len(customers), chunk_size):
            chunk = list(customers[start:start + chunk_size])
            names = [name for name, _, _ in chunk]

            # Batch embedding search for the chunk
            embedding_results_batch = self._embedding.search_many(names, k=10)

            for (name, dob, country), embedding_results in zip(chunk, embedding_results_batch):
                candidates = self._blocking.get_candidates(name, dob)
                blocking_candidate_sids = {cp.sanction_id for cp in candidates}

                # Build embedding lookup from this customer's results
                embedding_by_sid: dict[str, float] = {}
                for er in embedding_results:
                    sid = er["sanctions_id"]
                    if sid not in embedding_by_sid or er["score"] > embedding_by_sid[sid]:
                        embedding_by_sid[sid] = er["score"]

                # Embedding fallback: add high-scoring embedding matches that blocking missed
                EMBEDDING_FALLBACK_THRESHOLD = 0.55
                for er in embedding_results:
                    sid = er["sanctions_id"]
                    if sid not in blocking_candidate_sids and er["score"] >= EMBEDDING_FALLBACK_THRESHOLD:
                        entry = self._sanctions_by_id.get(sid)
                        if entry is not None:
                            from app.services.blocking_service import CandidatePair
                            candidates.append(CandidatePair(
                                sanction_id=sid,
                                blocking_reasons=frozenset(["embedding_fallback"]),
                            ))
                            blocking_candidate_sids.add(sid)

                if not candidates:
                    results.append(ScreenResult(
                        query_name=name,
                        matches=[],
                        decision=Decision.AUTO_CLEAR,
                        layer_reached=1,
                        threshold_used=threshold,
                        signal_breakdown=None,
                        reasoning="No candidates from blocking or embedding — auto-cleared",
                    ))
                    continue

                # Score each candidate
                best_breakdown: SignalBreakdown | None = None
                best_decision = Decision.AUTO_CLEAR
                best_reasoning = ""
                best_aggregate = -1.0
                best_match: SanctionsMatch | None = None
                matches: list[SanctionsMatch] = []

                for cp in candidates:
                    entry = self._sanctions_by_id.get(cp.sanction_id)
                    if entry is None:
                        continue

                    breakdown = self._score_candidate(
                        name, dob, country, entry, embedding_by_sid.get(cp.sanction_id, 0.0),
                    )
                    decision, reasoning = self._decide(breakdown)
                    aggregate = self._aggregate_strength(breakdown)

                    match = SanctionsMatch(
                        sanctions_id=entry.sanctions_id,
                        full_name=entry.full_name,
                        matched_name=entry.full_name,
                        match_type="blocking",
                        similarity_score=round(aggregate, 4),
                        date_of_birth=entry.date_of_birth,
                        nationality=entry.nationality,
                        sanctions_program=entry.sanctions_program,
                        reason_for_listing=entry.reason_for_listing,
                    )
                    matches.append(match)

                    decision_priority = {Decision.ESCALATE: 3, Decision.NEEDS_REVIEW: 2, Decision.AUTO_CLEAR: 1}
                    candidate_priority = decision_priority[decision]
                    best_priority = decision_priority[best_decision]

                    if candidate_priority > best_priority or (candidate_priority == best_priority and aggregate > best_aggregate):
                        best_breakdown = breakdown
                        best_decision = decision
                        best_reasoning = reasoning
                        best_aggregate = aggregate
                        best_match = match

                # Sort matches: best (decision-triggering) match first, then by aggregate score
                if best_match and matches:
                    matches = sorted(matches, key=lambda m: m.similarity_score, reverse=True)
                    if matches[0].sanctions_id != best_match.sanctions_id:
                        matches = [m for m in matches if m.sanctions_id != best_match.sanctions_id]
                        matches.insert(0, best_match)

                layer = 2 if best_decision != Decision.AUTO_CLEAR else 1
                results.append(ScreenResult(
                    query_name=name,
                    matches=matches,
                    decision=best_decision,
                    layer_reached=layer,
                    threshold_used=threshold,
                    signal_breakdown=best_breakdown,
                    reasoning=best_reasoning if best_reasoning else None,
                ))

        return results

    # ═══════════════════════════════════════════════════════════
    # Per-signal scoring
    # ═══════════════════════════════════════════════════════════

    def _score_candidate(
        self,
        customer_name: str,
        customer_dob: str | None,
        customer_country: str | None,
        sanction: SanctionsRecord,
        embedding_score: float,
    ) -> SignalBreakdown:
        """Score a single candidate across all 5 independent signals."""
        # 1. Name Jaro-Winkler (best across full_name and all known aliases)
        jw_score = _best_token_jw(customer_name, sanction.full_name)
        jw_detail = f"JW={jw_score:.3f} vs '{sanction.full_name}'"

        # 2. Phonetic similarity
        ph_score = _phonetic_score(customer_name, sanction.full_name)
        ph_detail = f"phonetic={ph_score:.2f} vs '{sanction.full_name}'"

        # 3. DOB — normalized 0.0–1.0
        dob_score, dob_missing, dob_detail = _dob_score_normalized(customer_dob, sanction.date_of_birth)

        # 4. Embedding — already 0.0–1.0 from cosine similarity (clamp for float precision)
        emb_clamped = max(0.0, min(1.0, embedding_score))
        emb_detail = f"embedding={emb_clamped:.3f}"
        if emb_clamped == 0.0:
            emb_detail += " (no FAISS match for this candidate)"

        # 5. Country — normalized 0.0–1.0
        country_score, country_missing, country_detail = _country_score_normalized(
            customer_country, sanction.nationality,
        )

        return SignalBreakdown(
            dob=SignalScore(
                signal_name="dob", score=dob_score,
                detail=dob_detail, missing=dob_missing,
            ),
            name_jw=SignalScore(
                signal_name="name_jw", score=jw_score,
                detail=jw_detail, missing=False,
            ),
            phonetic=SignalScore(
                signal_name="phonetic", score=ph_score,
                detail=ph_detail, missing=False,
            ),
            embedding=SignalScore(
                signal_name="embedding", score=emb_clamped,
                detail=emb_detail, missing=False,
            ),
            country=SignalScore(
                signal_name="country", score=country_score,
                detail=country_detail, missing=country_missing,
            ),
        )

    # ═══════════════════════════════════════════════════════════
    # Rule-based decision engine (D007 independent signals, D008 missing=cautious)
    # ═══════════════════════════════════════════════════════════

    def _decide(self, bd: SignalBreakdown) -> tuple[Decision, str]:
        """Apply rule-based decision logic. Returns (decision, reasoning_string)."""
        decision, reason = self._apply_rules(bd)
        reasoning = _build_reasoning(bd, decision, reason)
        return decision, reasoning

    def _apply_rules(self, bd: SignalBreakdown) -> tuple[Decision, str]:
        """Evaluate ESCALATE → NEEDS_REVIEW → AUTO_CLEAR rules in priority order.

        Design principles (learned from 100K-row analysis):
        - DOB match is mandatory for ESCALATE — without it, never escalate
        - Embedding + surname overlap alone is NOT enough for REVIEW
        - Phonetic=0.50 means one shared token (surname) — weak signal alone
        - Country mismatch vetoes escalation
        - NEEDS_REVIEW requires DOB≥0.8 as baseline, except near-exact name matches
        """

        country_conflict = (not bd.country.missing and bd.country.score == 0)

        # ── ESCALATE: very high confidence, DOB required ──

        # E1: Exact DOB + very strong name (near-identical)
        if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.90 and not country_conflict:
            return Decision.ESCALATE, "exact DOB + very strong name match (JW≥0.90)"

        # E2: Exact DOB + strong embedding + name support
        if bd.dob.score >= 1.0 and bd.embedding.score >= 0.85 and bd.name_jw.score >= 0.65 and not country_conflict:
            return Decision.ESCALATE, "exact DOB + strong embedding (≥0.85) + name support (JW≥0.65)"

        # E3: Near-exact name + exact DOB + country match (transliteration pattern)
        if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.75 and bd.country.score >= 1.0 and bd.phonetic.score >= 0.5:
            return Decision.ESCALATE, "exact DOB + name + country + phonetic — transliteration pattern"

        # E4: All signals strong — multi-signal consensus → REVIEW (not ESCALATE)
        # Even with all signals agreeing, different first names can produce high scores.
        # Only exact DOB (E1-E3) should escalate.
        if (bd.dob.score >= 0.8 and bd.name_jw.score >= 0.85 and bd.embedding.score >= 0.85
                and bd.country.score >= 1.0 and bd.phonetic.score >= 0.5):
            return Decision.NEEDS_REVIEW, "multi-signal consensus: name + embedding + DOB + country + phonetic — needs verification"

        # ── NEEDS_REVIEW: DOB required as baseline ──

        # R1: Exact DOB + moderate name evidence
        if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.70:
            if country_conflict:
                return Decision.NEEDS_REVIEW, "exact DOB + name match but country mismatch — needs verification"
            return Decision.NEEDS_REVIEW, "exact DOB + name match (JW≥0.70) — needs verification"

        # R2: Exact DOB + strong embedding (cross-script safety net)
        if bd.dob.score >= 1.0 and bd.embedding.score >= 0.75:
            return Decision.NEEDS_REVIEW, "exact DOB + strong embedding — possible cross-script match"

        # R2b: Exact DOB + perfect phonetic + country — cross-script transliteration
        if bd.dob.score >= 1.0 and bd.phonetic.score >= 0.80 and bd.country.score >= 1.0:
            return Decision.NEEDS_REVIEW, "exact DOB + strong phonetic + country — cross-script transliteration"

        # R2c: Exact DOB + moderate name match — cross-script safety net
        # Catches "Sergey ГРИНЮК" vs "Sergey GRINYUK" where embedding=0, JW penalized by script mix
        if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.50:
            return Decision.NEEDS_REVIEW, "exact DOB + name match (JW≥0.50) — needs verification"

        # R3: Same-year DOB + very strong name + country
        if bd.dob.score >= 0.8 and bd.name_jw.score >= 0.85 and bd.country.score >= 1.0:
            return Decision.NEEDS_REVIEW, "same-year DOB + strong name + country match"

        # R4: Same-year DOB + strong embedding + country + name support
        if bd.dob.score >= 0.8 and bd.embedding.score >= 0.85 and bd.country.score >= 1.0 and bd.name_jw.score >= 0.60:
            return Decision.NEEDS_REVIEW, "same-year DOB + strong embedding + country + name support"

        # R4e: Same-year DOB + very strong embedding + country match, no JW requirement
        # Catches cross-script pairs where JW is suppressed by middle names or transliteration
        # (e.g. "Elena Valerievna Kravchenko" vs "Олена Kravchenko": emb=0.926, JW=0.489)
        if bd.dob.score >= 0.8 and bd.embedding.score >= 0.90 and bd.country.score >= 1.0:
            return Decision.NEEDS_REVIEW, "same-year DOB + very strong embedding + country match — possible cross-script or middle-name variation"

        # R4b: Same-year DOB + strong name + country missing (missing-data caution)
        # When country is absent we can't use R3/R4 — rely on strong name + DOB instead.
        if bd.dob.score >= 0.8 and bd.name_jw.score >= 0.85 and bd.country.missing:
            return Decision.NEEDS_REVIEW, "same-year DOB + strong name + country missing — needs verification"

        # R4c: Same-year DOB + strong embedding + country missing (cross-script missing-data caution)
        if bd.dob.score >= 0.8 and bd.embedding.score >= 0.85 and bd.country.missing:
            return Decision.NEEDS_REVIEW, "same-year DOB + strong embedding + country missing — needs verification"

        # R4d: Same-year DOB + JW≥0.80 + embedding≥0.80 + country missing
        # Triple convergence at moderate thresholds — safe because all three signals must agree.
        # Catches near-transliteration cases (e.g. Cyrillic↔Latin) where both signals land
        # just under the single-signal thresholds of R4b/R4c.
        if bd.dob.score >= 0.8 and bd.name_jw.score >= 0.80 and bd.embedding.score >= 0.80 and bd.country.missing:
            return Decision.NEEDS_REVIEW, "same-year DOB + convergent name+embedding (≥0.80 each) + country missing — needs verification"

        # R5: Same-year DOB + strong embedding + strong phonetic (cross-script without country)
        if bd.dob.score >= 0.8 and bd.embedding.score >= 0.85 and bd.phonetic.score >= 0.80:
            return Decision.NEEDS_REVIEW, "same-year DOB + strong embedding + strong phonetic — cross-script"

        # ── NEEDS_REVIEW: no DOB but very strong name evidence ──

        # R6: Near-exact name match (JW≥0.95) + strong embedding — likely same person
        if bd.name_jw.score >= 0.95 and bd.embedding.score >= 0.90:
            return Decision.NEEDS_REVIEW, "near-exact name + embedding match — needs DOB/country verification"

        # ── NEEDS_REVIEW: name-only search (no DOB/country provided) ──
        # These lenient rules apply when a user searches by name alone.
        # Without DOB/country the system should still surface plausible matches.
        name_only = bd.dob.missing and bd.country.missing

        # R7: Strong name + embedding agreement (name-only)
        if name_only and bd.name_jw.score >= 0.82 and bd.embedding.score >= 0.70:
            return Decision.NEEDS_REVIEW, "strong name + embedding match (name-only search)"

        # R8: Good name + phonetic + embedding convergence (name-only)
        if name_only and bd.name_jw.score >= 0.75 and bd.phonetic.score >= 0.50 and bd.embedding.score >= 0.65:
            return Decision.NEEDS_REVIEW, "name + phonetic + embedding convergence (name-only search)"

        # R9: High embedding alone with some name support (name-only, cross-script)
        if name_only and bd.embedding.score >= 0.80 and bd.name_jw.score >= 0.60:
            return Decision.NEEDS_REVIEW, "strong embedding + name support (name-only search)"

        # R10: Very strong name match alone (name-only)
        if name_only and bd.name_jw.score >= 0.88:
            return Decision.NEEDS_REVIEW, "very strong name match (name-only search)"

        # ── AUTO_CLEAR: everything else ──
        return Decision.AUTO_CLEAR, "all signals below escalation/review thresholds"

    @staticmethod
    def _aggregate_strength(bd: SignalBreakdown) -> float:
        """Compute aggregate signal strength for candidate ranking (not for decisions)."""
        return (
            0.25 * bd.name_jw.score
            + 0.25 * bd.embedding.score
            + 0.20 * bd.dob.score
            + 0.15 * bd.phonetic.score
            + 0.15 * bd.country.score
        )


# ══════════════════════════════════════════════════════════════
# Reasoning builder
# ══════════════════════════════════════════════════════════════

def _build_reasoning(bd: SignalBreakdown, decision: Decision, rule_reason: str) -> str:
    """Build a human-readable 1-2 sentence explanation referencing signal values."""
    signals = []
    if bd.name_jw.score >= 0.5:
        signals.append(f"name JW={bd.name_jw.score:.2f}")
    if bd.embedding.score >= 0.5:
        signals.append(f"embedding={bd.embedding.score:.2f}")
    if bd.dob.score > 0:
        signals.append(f"DOB={bd.dob.score:.1f}")
    if bd.dob.missing:
        signals.append("DOB=missing")
    if bd.phonetic.score >= 0.3:
        signals.append(f"phonetic={bd.phonetic.score:.2f}")
    if bd.country.score > 0:
        signals.append(f"country={bd.country.score:.1f}")
    if bd.country.missing:
        signals.append("country=missing")

    signal_str = ", ".join(signals) if signals else "no significant signals"
    return f"{decision.value}: {rule_reason}. Signals: [{signal_str}]."


# ══════════════════════════════════════════════════════════════
# Signal scoring functions (normalized 0.0–1.0)
# ══════════════════════════════════════════════════════════════

def _dob_score_normalized(
    query_dob: str | None, match_dob: str | None,
) -> tuple[float, bool, str]:
    """Score DOB similarity, normalized to 0.0–1.0. Returns (score, missing, detail)."""
    if not query_dob or not match_dob:
        missing = not query_dob or not match_dob
        who = []
        if not query_dob:
            who.append("customer")
        if not match_dob:
            who.append("sanction")
        return 0.0, missing, f"DOB missing ({'/'.join(who)})"

    q_year = _extract_year(query_dob)
    m_year = _extract_year(match_dob)

    # Exact date match
    q_norm = query_dob.strip()[:10]
    m_norm = match_dob.strip()[:10]
    if q_norm == m_norm:
        return 1.0, False, f"exact DOB match ({q_norm})"

    if q_year and m_year:
        diff = abs(q_year - m_year)
        if diff == 0:
            return 0.8, False, f"same year ({q_year}) but different date"
        if diff <= 2:
            return 0.4, False, f"DOB ±{diff}yr ({q_year} vs {m_year})"
        if diff <= 5:
            return 0.1, False, f"DOB {diff}yr apart ({q_year} vs {m_year})"
        return 0.0, False, f"DOB 5+yr apart ({q_year} vs {m_year}) — likely different person"

    return 0.0, False, f"DOB year extraction failed ('{query_dob}' vs '{match_dob}')"


def _country_score_normalized(
    query_country: str | None, match_country: str | None,
) -> tuple[float, bool, str]:
    """Score country similarity, normalized to 0.0–1.0. Returns (score, missing, detail)."""
    if not query_country or not match_country:
        missing = not query_country or not match_country
        who = []
        if not query_country:
            who.append("customer")
        if not match_country:
            who.append("sanction")
        return 0.0, missing, f"country missing ({'/'.join(who)})"

    q = _normalize_country(query_country)
    m = _normalize_country(match_country)

    if q == m:
        return 1.0, False, f"country match ({query_country})"
    return 0.0, False, f"country mismatch ({query_country} vs {match_country})"


# ══════════════════════════════════════════════════════════════
# Retained helper functions (unchanged from original)
# ══════════════════════════════════════════════════════════════

def _best_token_jw(query: str, target: str) -> float:
    """Average JW of best-matched token pairs (greedy 1-to-1).

    Handles cross-script names by trying transliterated forms when
    the original scripts differ (e.g., Latin vs Cyrillic/Arabic/Hebrew).
    """
    # Try original pair first
    score = _best_token_jw_inner(query, target)

    # If either side has non-Latin, also try transliterated comparison
    q_non_latin = _has_non_latin(query)
    t_non_latin = _has_non_latin(target)
    if q_non_latin or t_non_latin:
        q_trans = _transliterate(query) if q_non_latin else query
        t_trans = _transliterate(target) if t_non_latin else target
        trans_score = _best_token_jw_inner(q_trans, t_trans)
        score = max(score, trans_score)

    return score


def _best_token_jw_inner(query: str, target: str) -> float:
    """Core token-level JW scoring without transliteration."""
    qt = query.lower().strip().split()
    tt = target.lower().strip().split()
    if not qt or not tt:
        return 0.0

    scores: list[float] = []
    used: set[int] = set()

    for qw in qt:
        best_jw = 0.0
        best_idx = -1
        for i, tw in enumerate(tt):
            if i in used:
                continue
            # Abbreviation — weaker signal, penalize more
            if _is_abbreviation(qw, tw) or _is_abbreviation(tw, qw):
                jw = 0.75  # Abbreviation is weak — could be coincidental initial
            else:
                shorter = min(len(qw), len(tw))
                longer = max(len(qw), len(tw))
                if shorter < 2 or longer / shorter > 2.5:
                    continue
                jw = jellyfish.jaro_winkler_similarity(qw, tw)
            if jw > best_jw:
                best_jw = jw
                best_idx = i
        if best_idx >= 0 and best_jw >= 0.60:
            scores.append(best_jw)
            used.add(best_idx)

    if not scores:
        return 0.0
    # Weight by coverage: penalize when many tokens are unmatched on either side
    query_coverage = len(scores) / len(qt)
    target_coverage = len(scores) / len(tt)
    coverage = min(query_coverage, target_coverage)  # worst side dominates
    avg_score = sum(scores) / len(scores)
    return avg_score * coverage


def _phonetic_score(query: str, target: str) -> float:
    """Compare Double Metaphone codes of name tokens.

    Handles cross-script names by transliterating non-Latin text to Latin first.
    """
    # Try original pair
    score = _phonetic_score_inner(query, target)

    # If either side has non-Latin, also try transliterated
    q_non_latin = _has_non_latin(query)
    t_non_latin = _has_non_latin(target)
    if q_non_latin or t_non_latin:
        q_trans = _transliterate(query) if q_non_latin else query
        t_trans = _transliterate(target) if t_non_latin else target
        trans_score = _phonetic_score_inner(q_trans, t_trans)
        score = max(score, trans_score)

    return score


def _phonetic_score_inner(query: str, target: str) -> float:
    """Core phonetic scoring without transliteration."""
    q_codes = _metaphone_codes(query)
    t_codes = _metaphone_codes(target)
    if not q_codes or not t_codes:
        return 0.0

    matches = 0
    for qc in q_codes:
        for tc in t_codes:
            if qc and tc and qc == tc:
                matches += 1
                break

    return min(matches / max(len(q_codes), 1), 1.0)


def _metaphone_codes(name: str) -> list[str]:
    """Get metaphone code for each token in the name.

    Handles non-Latin scripts by transliterating to Latin first.
    """
    codes = []
    # Process both original and transliterated forms
    names_to_process = [name]
    if _has_non_latin(name):
        names_to_process.append(_transliterate(name))

    seen: set[str] = set()
    for n in names_to_process:
        for token in n.lower().strip().split():
            token_clean = re.sub(r"[^a-z]", "", token)
            if len(token_clean) < 2:
                continue
            code = jellyfish.metaphone(token_clean)
            if code and code not in seen:
                codes.append(code)
                seen.add(code)
    return codes


def _extract_year(date_str: str) -> int | None:
    """Extract 4-digit year from various date formats."""
    if not date_str:
        return None
    # Try YYYY-MM-DD, DD/MM/YYYY, YYYY, etc.
    m = re.search(r"(19|20)\d{2}", date_str)
    return int(m.group()) if m else None


def _is_abbreviation(short: str, long_name: str) -> bool:
    """Check if short is an abbreviation of long_name (e.g. A. → Aleksandr)."""
    s = short.rstrip(".").lower()
    return len(s) <= 2 and long_name.lower().startswith(s)


def _safe_str(val: object) -> str | None:
    """Convert a pandas value to str, returning None for NaN/None."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    return str(val)


# ══════════════════════════════════════════════════════════════
# Cross-script transliteration helpers
# ══════════════════════════════════════════════════════════════

# Regex: True if string contains at least one non-Latin letter (Cyrillic, Arabic, Hebrew, CJK, etc.)
_NON_LATIN_RE = re.compile(r"[^\u0000-\u024F\u1E00-\u1EFF]")


def _has_non_latin(text: str) -> bool:
    """Return True if text contains non-Latin script characters."""
    return bool(_NON_LATIN_RE.search(text))


def _transliterate(name: str) -> str:
    """Transliterate non-Latin scripts to Latin using Unidecode.

    Returns the original string unchanged if it's already Latin-only.
    """
    if not _has_non_latin(name):
        return name
    return unidecode(name)


# Common country code normalization
_COUNTRY_MAP = {
    "united states": "us", "usa": "us", "u.s.a.": "us", "u.s.": "us",
    "united kingdom": "gb", "uk": "gb", "england": "gb", "britain": "gb",
    "russia": "ru", "russian federation": "ru",
    "iran": "ir", "islamic republic of iran": "ir",
    "china": "cn", "peoples republic of china": "cn",
    "germany": "de", "deutschland": "de",
    "france": "fr", "turkey": "tr", "turkiye": "tr",
    "palestine": "ps", "sweden": "se", "finland": "fi",
    "switzerland": "ch", "austria": "at", "belgium": "be",
    "denmark": "dk", "netherlands": "nl", "norway": "no",
    "lebanon": "lb", "syria": "sy", "iraq": "iq",
    "ukraine": "ua", "uzbekistan": "uz", "tajikistan": "tj",
    "ua-dpr": "ua", "ua-lpr": "ua",  # Donetsk/Luhansk separatist regions → Ukraine
    "brazil": "br", "japan": "jp", "india": "in",
    "australia": "au", "canada": "ca", "mexico": "mx",
}


def _normalize_country(raw: str) -> str:
    """Normalize country name to 2-letter code."""
    s = raw.strip().lower()
    if s in _COUNTRY_MAP:
        return _COUNTRY_MAP[s]
    if len(s) == 2:
        return s
    return s
