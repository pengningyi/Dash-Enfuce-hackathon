"""Prune false positive pairs from pairs_full.csv (or pairs_full_pruned.csv).

Strategies applied (highest confidence first):
  1. DATE CONFLICT         — both sides have a birth year/month/day and they disagree.
                             Missing data is fine; only explicit contradictions are removed.
  2. NATIONALITY CONFLICT  — both sides have nationality codes with zero overlap
                             AND the names share no tokens.  The dual-condition makes
                             this far more conservative than nationality alone.
  3. COUNTRY + SURNAME     — both sides have explicit prop_country codes that conflict
                             (excluding supranational codes "eu"/"un") AND their
                             single-token Latin prop_lastName values are very dissimilar
                             (JW < 0.55).  Uses prop_lastName only — no fallback to
                             name tokens — to avoid false positives from name-order
                             reversal or Chinese Mandarin/Cantonese surname variants.
  4. FIRSTNAME MATCH + LASTNAME MISMATCH
                           — both sides have near-identical prop_firstName (JW ≥ 0.95)
                             and clearly different single-token Latin prop_lastName
                             (JW < 0.55), AND the mismatched surnames do NOT appear as
                             tokens in the other side's full name.  The last condition
                             protects legitimate multi-surname people (e.g. "Saddam
                             Hussein" = "Saddam Al-Tikriti") and compound-surname pairs
                             (e.g. "Alfred Yekatom" = "Alfred Saragba").

Run:
    python scripts/prune_pairs.py                              # dry-run on pairs_full.csv
    python scripts/prune_pairs.py --write                      # writes pairs_full_pruned.csv
    python scripts/prune_pairs.py --source pairs_full_pruned.csv --write   # clean pruned file
    python scripts/prune_pairs.py --write --inplace            # overwrites source in-place
"""

from __future__ import annotations

import argparse
import re
import unicodedata
from pathlib import Path

import jellyfish
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_INPUT_CSV = DATA_DIR / "pairs_full.csv"
OUTPUT_CSV = DATA_DIR / "pairs_full_pruned.csv"


# ── Date helpers ──────────────────────────────────────────────────────────────

def _extract_year(d: object) -> int | None:
    s = str(d).strip()
    if s in ("", "nan"):
        return None
    m = re.search(r"\b(1[89]\d\d|20[012]\d)\b", s)
    return int(m.group(1)) if m else None


def _extract_month(d: object) -> int | None:
    m = re.match(r"\d{4}-(\d{2})", str(d).strip())
    return int(m.group(1)) if m else None


def _extract_day(d: object) -> int | None:
    m = re.match(r"\d{4}-\d{2}-(\d{2})", str(d).strip())
    return int(m.group(1)) if m else None


# ── Name helpers ──────────────────────────────────────────────────────────────

_PARTICLES = frozenset(
    ["bin", "ibn", "abu", "bul", "al", "el", "de", "du", "van", "von", "son", "the"]
)


def _name_tokens(s: object) -> frozenset[str]:
    """Lower-cased, diacritic-stripped alpha tokens of length >= 3, particles removed."""
    if pd.isna(s):
        return frozenset()
    s = unicodedata.normalize("NFKD", str(s).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")  # strip diacritics
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return frozenset(t for t in s.split() if len(t) >= 3 and t not in _PARTICLES)


def _is_latin(s: object) -> bool:
    """True when >90% of alphabetic chars are ASCII (Latin-script name)."""
    if pd.isna(s):
        return False
    alpha = [c for c in str(s) if c.isalpha()]
    if not alpha:
        return False
    return sum(1 for c in alpha if ord(c) < 256) / len(alpha) > 0.9


def _norm_token(s: str) -> str:
    """Lower-case + strip diacritics for JW comparison."""
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# ── Core filter ───────────────────────────────────────────────────────────────

def find_false_positive_pairs(df: pd.DataFrame) -> tuple[set[int], dict[str, set[int]]]:
    """Return the set of pair_ids to remove and a breakdown by reason."""
    pos = df[df["judgement"] == "positive"].copy()

    # Parse birth date components
    pos["_yr"] = pos["prop_birthDate"].apply(_extract_year)
    pos["_mo"] = pos["prop_birthDate"].apply(_extract_month)
    pos["_dy"] = pos["prop_birthDate"].apply(_extract_day)

    left = pos[pos["side"] == "left"].set_index("pair_id")
    right = pos[pos["side"] == "right"].set_index("pair_id")

    # Align on shared pair_ids
    cols = ["prop_name", "prop_nationality", "prop_country", "prop_lastName", "prop_firstName", "_yr", "_mo", "_dy"]
    # Only select columns that exist in the dataframe
    left_cols  = [c for c in cols if c in left.columns]
    right_cols = [c for c in cols if c in right.columns]
    m = left[left_cols].join(right[right_cols], lsuffix="_l", rsuffix="_r")

    # ── Strategy 1: date conflict ──────────────────────────────────────────────
    year_c  = m["_yr_l"].notna() & m["_yr_r"].notna() & (m["_yr_l"] != m["_yr_r"])
    month_c = m["_mo_l"].notna() & m["_mo_r"].notna() & (m["_mo_l"] != m["_mo_r"])
    day_c   = m["_dy_l"].notna() & m["_dy_r"].notna() & (m["_dy_l"] != m["_dy_r"])
    date_conflict = year_c | month_c | day_c

    # ── Strategy 2: nationality + name both conflict ───────────────────────────
    # Nationality: pipe-separated ISO-2 codes (e.g. "iq|eg|jo").
    # "conflict" = both sides non-null and no code in common.
    def _nat_conflict(row: pd.Series) -> bool:
        a, b = row.get("prop_nationality_l"), row.get("prop_nationality_r")
        if pd.isna(a) or pd.isna(b):
            return False
        return not bool(set(str(a).split("|")) & set(str(b).split("|")))

    nat_c = m.apply(_nat_conflict, axis=1)

    # Name conflict (Latin-only, zero token overlap)
    def _name_conflict(row: pd.Series) -> bool:
        nl, nr = row.get("prop_name_l"), row.get("prop_name_r")
        if not (_is_latin(nl) and _is_latin(nr)):
            return False  # skip cross-script pairs — transliterations look very different
        tl, tr = _name_tokens(nl), _name_tokens(nr)
        return bool(tl) and bool(tr) and len(tl & tr) == 0

    name_c = m.apply(_name_conflict, axis=1)

    nat_and_name_conflict = nat_c & name_c

    # ── Strategy 3: prop_country conflict + surname mismatch ──────────────────
    # Both sides have an explicit prop_country that conflicts (no code in common,
    # ignoring supranational codes "eu" and "un") AND their single-token Latin
    # prop_lastName values are clearly different (JW < 0.55).
    # Uses ONLY prop_lastName — no fallback — to avoid false positives from
    # reversed name order or Mandarin/Cantonese surname variants.

    _SUPRANATIONAL = {"eu", "un"}

    def _country_conflict(row: pd.Series) -> bool:
        a = row.get("prop_country_l")
        b = row.get("prop_country_r")
        if pd.isna(a) or pd.isna(b):
            return False
        ac = {c.strip().lower() for c in str(a).split("|") if c.strip()} - _SUPRANATIONAL
        bc = {c.strip().lower() for c in str(b).split("|") if c.strip()} - _SUPRANATIONAL
        return bool(ac) and bool(bc) and not bool(ac & bc)

    def _surname_mismatch_strict(row: pd.Series) -> bool:
        """Single-token Latin prop_lastName on both sides, JW < 0.55."""
        sl = str(row.get("prop_lastName_l", "") or "").strip()
        sr = str(row.get("prop_lastName_r", "") or "").strip()
        if not sl or sl == "nan" or not sr or sr == "nan":
            return False
        if len(sl.split()) > 1 or len(sr.split()) > 1:
            return False  # multi-token = fragment stored wrong, skip
        if not _is_latin(sl) or not _is_latin(sr):
            return False
        return jellyfish.jaro_winkler_similarity(_norm_token(sl), _norm_token(sr)) < 0.55

    country_c  = m.apply(_country_conflict, axis=1)
    surname_c  = m.apply(_surname_mismatch_strict, axis=1)
    country_and_surname_conflict = country_c & surname_c

    # ── Strategy 4: firstName match + lastName mismatch ───────────────────────
    # Both sides have near-identical single-token Latin prop_firstName (JW ≥ 0.95)
    # AND clearly different single-token Latin prop_lastName (JW < 0.55, ≥ 5 chars),
    # AND the mismatched surnames do NOT appear as tokens in the other side's full
    # name.  The last condition protects compound-surname people and alias pairs
    # where the "other" surname is part of the same entity's full name.

    def _fn_match_ln_mismatch(row: pd.Series) -> bool:
        fl = str(row.get("prop_firstName_l", "") or "").strip()
        fr = str(row.get("prop_firstName_r", "") or "").strip()
        ll = str(row.get("prop_lastName_l",  "") or "").strip()
        lr = str(row.get("prop_lastName_r",  "") or "").strip()
        if not fl or not fr or not ll or not lr:
            return False
        # Single-token lastNames only (real surnames)
        if len(ll.split()) > 1 or len(lr.split()) > 1:
            return False
        # Minimum length — avoid matching short tokens
        if len(ll) < 5 or len(lr) < 5:
            return False
        if not (_is_latin(fl) and _is_latin(fr) and _is_latin(ll) and _is_latin(lr)):
            return False
        # First name: use first token, must be distinctive
        fl_tok = fl.split()[0]; fr_tok = fr.split()[0]
        if len(fl_tok) < 5 or len(fr_tok) < 5:
            return False
        fn_jw = jellyfish.jaro_winkler_similarity(_norm_token(fl_tok), _norm_token(fr_tok))
        if fn_jw < 0.95:
            return False
        ln_jw = jellyfish.jaro_winkler_similarity(_norm_token(ll), _norm_token(lr))
        if ln_jw >= 0.55:
            return False
        # If the mismatched surname appears in the other side's full name,
        # this is likely the same person with a compound/alias surname — keep it.
        def _full_tokens(fn_col: str, ln_col: str, nm_col: str) -> frozenset[str]:
            parts = [
                str(row.get(fn_col, "") or ""),
                str(row.get(ln_col, "") or ""),
                str(row.get(nm_col, "") or ""),
            ]
            combined = " ".join(p for p in parts if p and p != "nan")
            return _name_tokens(combined)

        r_full = _full_tokens("prop_firstName_r", "prop_lastName_r", "prop_name_r")
        l_full = _full_tokens("prop_firstName_l", "prop_lastName_l", "prop_name_l")
        ll_toks = _name_tokens(ll)
        lr_toks = _name_tokens(lr)
        if ll_toks & r_full:  # left's surname found in right's full name → same person
            return False
        if lr_toks & l_full:  # right's surname found in left's full name → same person
            return False
        return True

    fn_ln_conflict = m.apply(_fn_match_ln_mismatch, axis=1)

    # ── Collect pair_ids ───────────────────────────────────────────────────────
    by_reason: dict[str, set[int]] = {
        "date_conflict":                set(m.index[date_conflict]),
        "nat_and_name_conflict":        set(m.index[nat_and_name_conflict]),
        "country_and_surname_conflict": set(m.index[country_and_surname_conflict]),
        "fn_match_ln_mismatch":         set(m.index[fn_ln_conflict]),
    }

    to_remove = (
        by_reason["date_conflict"]
        | by_reason["nat_and_name_conflict"]
        | by_reason["country_and_surname_conflict"]
        | by_reason["fn_match_ln_mismatch"]
    )
    return to_remove, by_reason


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Prune false positive pairs")
    parser.add_argument("--source", default=str(DEFAULT_INPUT_CSV),
                        help="Input CSV (default: pairs_full.csv)")
    parser.add_argument("--write", action="store_true", help="Write pruned CSV")
    parser.add_argument("--inplace", action="store_true",
                        help="Overwrite source CSV instead of writing pairs_full_pruned.csv")
    args = parser.parse_args()

    input_csv = Path(args.source)
    if not input_csv.is_absolute():
        input_csv = DATA_DIR / input_csv

    print(f"Loading {input_csv} …")
    df = pd.read_csv(input_csv, low_memory=False)
    total_pairs = df["pair_id"].nunique()
    pos_pairs   = df[df["judgement"] == "positive"]["pair_id"].nunique()
    neg_pairs   = total_pairs - pos_pairs
    print(f"  {total_pairs:,} pairs total  ({pos_pairs:,} positive, {neg_pairs:,} negative)")

    print("\nFinding false positive pairs …")
    to_remove, by_reason = find_false_positive_pairs(df)

    print(f"\nBreakdown of pairs to remove ({len(to_remove):,} total):")
    for reason, ids in by_reason.items():
        print(f"  {reason:35s}: {len(ids):>6,}")

    remaining_pos = pos_pairs - len(to_remove)
    remaining_total = total_pairs - len(to_remove)
    print(f"\nAfter pruning:")
    print(f"  positive pairs : {remaining_pos:,}  (removed {len(to_remove):,} = {100*len(to_remove)/pos_pairs:.1f}%)")
    print(f"  total pairs    : {remaining_total:,}")

    if args.write:
        mask = df["pair_id"].isin(to_remove)
        pruned = df[~mask].copy()
        out = input_csv if args.inplace else OUTPUT_CSV
        pruned.to_csv(out, index=False)
        print(f"\nWrote {len(pruned):,} rows → {out}")
    else:
        print("\n(Dry run — pass --write to save)")


if __name__ == "__main__":
    main()
