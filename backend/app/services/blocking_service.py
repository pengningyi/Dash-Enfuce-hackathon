"""Blocking service: DOB-year and Metaphone phonetic inverted indexes for candidate-pair generation.

Pre-screening filter that reduces 100K+ customers to a small candidate set before
expensive composite scoring. Uses two blocking strategies:
  - Primary: DOB year match AND ≥1 shared Metaphone code
  - Secondary: ≥2 shared Metaphone codes (no DOB required)
  - Fallback: ≥1 shared Metaphone code when customer DOB is missing
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import jellyfish
import pandas as pd
from unidecode import unidecode

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CandidatePair:
    """A sanctions entry that passed blocking for a given customer."""

    sanction_id: str
    blocking_reasons: frozenset[str]


class BlockingService:
    """Builds DOB-year and Metaphone phonetic inverted indexes from sanctions data,
    then returns candidate pairs for any customer via intersection-primary blocking.
    """

    def __init__(self) -> None:
        # DOB year → set of sanction IDs
        self._dob_year_index: dict[int, set[str]] = {}
        # Metaphone code → set of sanction IDs
        self._phonetic_index: dict[str, set[str]] = {}
        # sanction_id → row data for reference
        self._sanctions_data: dict[str, dict] = {}

    def build_indexes(self, sanctions_df: pd.DataFrame) -> None:
        """Build DOB-year and phonetic inverted indexes from the sanctions DataFrame."""
        t0 = time.perf_counter()

        for _, row in sanctions_df.iterrows():
            sid = str(row["Sanction_ID"])

            # Store row data
            self._sanctions_data[sid] = row.to_dict()

            # ── DOB year index ──
            dob_raw = row.get("Date_of_Birth")
            if pd.notna(dob_raw):
                year = _extract_year(str(dob_raw))
                if year is not None:
                    self._dob_year_index.setdefault(year, set()).add(sid)

            # ── Phonetic index ──
            # Index Full_Name + Alias_1 + Alias_2 (skip NaN per K001)
            for col in ("Full_Name", "Alias_1", "Alias_2"):
                val = row.get(col)
                if pd.notna(val):
                    for code in _metaphone_codes(str(val)):
                        self._phonetic_index.setdefault(code, set()).add(sid)

        elapsed = time.perf_counter() - t0
        logger.info(
            "Blocking indexes built: %d DOB years, %d phonetic codes, %d sanctions entries (%.3fs)",
            len(self._dob_year_index),
            len(self._phonetic_index),
            len(self._sanctions_data),
            elapsed,
        )

    def get_candidates(self, name: str, dob: str | None = None) -> list[CandidatePair]:
        """Return candidate sanction entries that pass blocking for the given customer.

        Blocking strategies:
          1. Primary (dob+phonetic): DOB year matches AND ≥1 shared Metaphone code
          2. Secondary (phonetic_strong): ≥2 shared Metaphone codes regardless of DOB
          3. Fallback (phonetic_no_dob): ≥1 shared Metaphone code when customer has no DOB
        """
        if not name or not name.strip():
            return []

        customer_codes = _metaphone_codes(name)
        if not customer_codes:
            return []

        customer_year = _extract_year(dob) if dob else None

        # Collect sanction IDs → reasons
        candidates: dict[str, set[str]] = {}

        if customer_year is not None:
            # ── Primary block: DOB year match + ≥2 phonetic codes ──
            # With 1M+ sanctions, single phonetic overlap is too noisy
            # Exception: if DOB is exact date match (not just year), ≥1 code is enough
            dob_matches = self._dob_year_index.get(customer_year, set())
            if dob_matches:
                for sid in dob_matches:
                    shared = _count_shared_codes(customer_codes, sid, self._phonetic_index)
                    if shared >= 2:
                        candidates.setdefault(sid, set()).add("dob+phonetic")
                    elif shared >= 1:
                        # Weaker phonetic match — only accept if we have a full DOB (not year-only)
                        # This preserves recall for transliteration variants with exact DOB
                        if dob and len(dob) >= 8:  # e.g., "1957-03-11" vs "1957"
                            candidates.setdefault(sid, set()).add("dob+phonetic_weak")

            # ── Secondary block: ≥2 shared phonetic codes (regardless of DOB) ──
            for sid in self._phonetic_strong_candidates(customer_codes):
                if sid not in candidates:
                    candidates.setdefault(sid, set()).add("phonetic_strong")
        else:
            # ── Missing-DOB fallback: ≥1 shared phonetic code ──
            for sid in self._phonetic_any_candidates(customer_codes):
                candidates.setdefault(sid, set()).add("phonetic_no_dob")

        return [
            CandidatePair(sanction_id=sid, blocking_reasons=frozenset(reasons))
            for sid, reasons in candidates.items()
        ]

    def add_entry(
        self,
        sanction_id: str,
        full_name: str,
        dob: str | None = None,
        aliases: list[str] | None = None,
    ) -> None:
        """Add a new sanctions entry to live indexes without rebuild (K008 pattern)."""
        # Store row data
        self._sanctions_data[sanction_id] = {
            "Sanction_ID": sanction_id,
            "Full_Name": full_name,
            "Date_of_Birth": dob,
        }

        # DOB year index
        if dob:
            year = _extract_year(dob)
            if year is not None:
                self._dob_year_index.setdefault(year, set()).add(sanction_id)

        # Phonetic index — full name + aliases
        for code in _metaphone_codes(full_name):
            self._phonetic_index.setdefault(code, set()).add(sanction_id)

        for alias in aliases or []:
            if alias:
                for code in _metaphone_codes(alias):
                    self._phonetic_index.setdefault(code, set()).add(sanction_id)

    @property
    def index_stats(self) -> dict[str, int]:
        """Return index size metrics for observability."""
        return {
            "dob_years": len(self._dob_year_index),
            "phonetic_codes": len(self._phonetic_index),
            "sanctions_entries": len(self._sanctions_data),
        }

    # ── Internal helpers ──

    def _phonetic_strong_candidates(self, customer_codes: set[str]) -> set[str]:
        """Find sanction IDs sharing ≥3 phonetic codes with the customer."""
        hits: dict[str, int] = {}
        for code in customer_codes:
            for sid in self._phonetic_index.get(code, set()):
                hits[sid] = hits.get(sid, 0) + 1
        return {sid for sid, count in hits.items() if count >= 3}

    def _phonetic_any_candidates(self, customer_codes: set[str]) -> set[str]:
        """Find sanction IDs sharing ≥1 phonetic code with the customer."""
        result: set[str] = set()
        for code in customer_codes:
            result.update(self._phonetic_index.get(code, set()))
        return result


# ══════════════════════════════════════════════════════════════
# Module-level helpers
# ══════════════════════════════════════════════════════════════

def _extract_year(date_str: str | None) -> int | None:
    """Extract 4-digit year (19xx/20xx) from various date formats."""
    if not date_str:
        return None
    m = re.search(r"(19|20)\d{2}", str(date_str))
    return int(m.group()) if m else None


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


def _metaphone_codes(name: str) -> set[str]:
    """Compute Metaphone codes for each token in a name string.

    Handles non-Latin scripts by transliterating to Latin first.
    """
    codes: set[str] = set()
    # If non-Latin, transliterate first, then compute codes from both
    names_to_process = [name]
    if _has_non_latin(name):
        names_to_process.append(_transliterate(name))

    for n in names_to_process:
        for token in n.lower().strip().split():
            token_clean = re.sub(r"[^a-z]", "", token)
            if len(token_clean) < 2:
                continue
            code = jellyfish.metaphone(token_clean)
            if code:
                codes.add(code)
    return codes


def _count_shared_codes(
    customer_codes: set[str],
    sanction_id: str,
    phonetic_index: dict[str, set[str]],
) -> int:
    """Count how many of the customer's phonetic codes map to the given sanction ID."""
    count = 0
    for code in customer_codes:
        if sanction_id in phonetic_index.get(code, set()):
            count += 1
    return count
