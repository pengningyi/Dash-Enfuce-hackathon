"""
Evaluate the M002 5-signal scoring + rule-based decision engine
against the pairs_full.csv benchmark dataset.

Usage:
    python evaluate_pairs.py                  # sample 10K pairs (fast)
    python evaluate_pairs.py --all            # all 216K pairs
    python evaluate_pairs.py --sample 50000   # custom sample size
"""

import csv
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

# Add app to path
sys.path.insert(0, str(Path(__file__).parent))

from app.models.schemas import SignalScore, SignalBreakdown, Decision


# ── Import scoring helpers from screening_service ──
from app.services.screening_service import (
    _best_token_jw,
    _phonetic_score,
    _dob_score_normalized,
    _country_score_normalized,
)


def parse_pairs(csv_path: str, sample: int | None = None) -> list[dict]:
    """Parse pairs_full.csv into list of {left, right, judgement} dicts."""
    rows_by_pair: dict[str, list[dict]] = defaultdict(list)

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows_by_pair[row["pair_id"]].append(row)

    pairs = []
    for pair_id, rows in rows_by_pair.items():
        left = next((r for r in rows if r["side"] == "left"), None)
        right = next((r for r in rows if r["side"] == "right"), None)
        if left and right:
            pairs.append({
                "pair_id": pair_id,
                "judgement": left["judgement"],
                "left": left,
                "right": right,
            })

    if sample and sample < len(pairs):
        import random
        random.seed(42)
        # Stratified sample — keep positive/negative ratio
        pos = [p for p in pairs if p["judgement"] == "positive"]
        neg = [p for p in pairs if p["judgement"] == "negative"]
        ratio = len(pos) / len(pairs)
        n_pos = int(sample * ratio)
        n_neg = sample - n_pos
        pairs = random.sample(pos, min(n_pos, len(pos))) + random.sample(neg, min(n_neg, len(neg)))
        random.shuffle(pairs)

    return pairs


def normalize_country(raw: str) -> str | None:
    """Extract first country code from pipe-separated list."""
    if not raw or raw.strip() == "":
        return None
    return raw.split("|")[0].strip().upper()


def score_pair(left: dict, right: dict) -> tuple[SignalBreakdown, Decision, str]:
    """Score a single pair using the 5-signal pipeline (no embedding)."""
    l_name = left["prop_name"]
    r_name = right["prop_name"]
    l_dob = left["prop_birthDate"] or None
    r_dob = right["prop_birthDate"] or None
    l_country = normalize_country(left["prop_country"])
    r_country = normalize_country(right["prop_country"])

    # 1. Name JW
    jw = _best_token_jw(l_name, r_name)

    # 2. Phonetic
    ph = _phonetic_score(l_name, r_name)

    # 3. DOB
    dob_score, dob_missing, dob_detail = _dob_score_normalized(l_dob, r_dob)

    # 4. Embedding — skip (set 0.0) since we don't have FAISS for arbitrary pairs
    emb_score = 0.0

    # 5. Country
    country_score, country_missing, country_detail = _country_score_normalized(l_country, r_country)

    bd = SignalBreakdown(
        dob=SignalScore(signal_name="dob", score=dob_score, detail=dob_detail, missing=dob_missing),
        name_jw=SignalScore(signal_name="name_jw", score=jw, detail=f"JW={jw:.3f}", missing=False),
        phonetic=SignalScore(signal_name="phonetic", score=ph, detail=f"phonetic={ph:.2f}", missing=False),
        embedding=SignalScore(signal_name="embedding", score=emb_score, detail="n/a (pair eval)", missing=True),
        country=SignalScore(signal_name="country", score=country_score, detail=country_detail, missing=country_missing),
    )

    decision, reason = apply_rules_standalone(bd)
    return bd, decision, reason


def apply_rules_standalone(bd: SignalBreakdown) -> tuple[Decision, str]:
    """Standalone copy of the rule engine — works without ScreeningService instance.
    Same rules as ScreeningService._apply_rules but adapted for pair evaluation
    (embedding always 0/missing, so embedding-dependent rules won't fire)."""

    # ── ESCALATE rules ──
    # E1: DOB exact date + JW ≥ 0.85
    if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.85:
        return Decision.ESCALATE, "exact DOB + strong name match (JW≥0.85)"

    # E2: skip (embedding-dependent)

    # E3: JW ≥ 0.92 + DOB same year + country match
    if bd.name_jw.score >= 0.92 and bd.dob.score >= 0.8 and bd.country.score >= 1.0:
        return Decision.ESCALATE, "very strong name (JW≥0.92) + same-year DOB + country match"

    # E4: skip (embedding-dependent)

    # ── NEEDS_REVIEW: missing data caution ──
    has_missing = bd.dob.missing or bd.country.missing
    has_strong_name = bd.name_jw.score >= 0.75 or bd.embedding.score >= 0.70

    if has_missing and has_strong_name:
        return Decision.NEEDS_REVIEW, "missing DOB/country with strong name signals"

    # ── NEEDS_REVIEW: moderate signals ──
    if bd.name_jw.score >= 0.85 and bd.dob.score >= 0.4:
        return Decision.NEEDS_REVIEW, "strong name (JW≥0.85) with partial DOB"

    if bd.name_jw.score >= 0.92:
        return Decision.NEEDS_REVIEW, "very strong name alone (JW≥0.92)"

    # R5: Exact DOB + moderate name
    if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.70:
        return Decision.NEEDS_REVIEW, "exact DOB + moderate name"

    # R6: DOB same-year + strong name + country
    if bd.dob.score >= 0.8 and bd.name_jw.score >= 0.75 and bd.country.score >= 1.0:
        return Decision.NEEDS_REVIEW, "same-year DOB + strong name + country"

    # ── AUTO_CLEAR ──
    return Decision.AUTO_CLEAR, "all signals below thresholds"


def evaluate(pairs: list[dict]) -> None:
    """Run evaluation and print metrics."""
    tp = fp = tn = fn = 0
    decision_counts = Counter()
    errors_fp: list[dict] = []  # false positives (negative pair flagged)
    errors_fn: list[dict] = []  # false negatives (positive pair cleared)

    start = time.time()

    for i, pair in enumerate(pairs):
        bd, decision, reason = score_pair(pair["left"], pair["right"])
        is_positive = pair["judgement"] == "positive"
        is_flagged = decision != Decision.AUTO_CLEAR  # ESCALATE or NEEDS_REVIEW

        decision_counts[decision.value] += 1

        if is_positive and is_flagged:
            tp += 1
        elif is_positive and not is_flagged:
            fn += 1
            if len(errors_fn) < 20:
                errors_fn.append({
                    "pair_id": pair["pair_id"],
                    "left_name": pair["left"]["prop_name"],
                    "right_name": pair["right"]["prop_name"],
                    "left_dob": pair["left"]["prop_birthDate"],
                    "right_dob": pair["right"]["prop_birthDate"],
                    "jw": bd.name_jw.score,
                    "phonetic": bd.phonetic.score,
                    "dob": bd.dob.score,
                    "country": bd.country.score,
                    "reason": reason,
                })
        elif not is_positive and is_flagged:
            fp += 1
            if len(errors_fp) < 20:
                errors_fp.append({
                    "pair_id": pair["pair_id"],
                    "left_name": pair["left"]["prop_name"],
                    "right_name": pair["right"]["prop_name"],
                    "jw": bd.name_jw.score,
                    "dob": bd.dob.score,
                    "decision": decision.value,
                    "reason": reason,
                })
        else:  # not positive and not flagged
            tn += 1

        if (i + 1) % 10000 == 0:
            elapsed = time.time() - start
            print(f"  ... {i+1}/{len(pairs)} scored ({elapsed:.1f}s)")

    elapsed = time.time() - start

    # ── Metrics ──
    total = tp + fp + tn + fn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    accuracy = (tp + tn) / total if total > 0 else 0

    n_positive = tp + fn
    n_negative = fp + tn

    print("\n" + "=" * 60)
    print("  EVALUATION RESULTS")
    print("=" * 60)
    print(f"\n  Dataset: {total:,} pairs ({n_positive:,} positive, {n_negative:,} negative)")
    print(f"  Time:    {elapsed:.1f}s ({total/elapsed:,.0f} pairs/sec)")
    print(f"\n  Decision distribution:")
    for d, c in sorted(decision_counts.items()):
        print(f"    {d:15s}: {c:>7,} ({100*c/total:.1f}%)")

    print(f"\n  ┌──────────────────────────────────────┐")
    print(f"  │  Confusion Matrix                     │")
    print(f"  ├──────────────────────────────────────┤")
    print(f"  │              Predicted                │")
    print(f"  │           FLAG     CLEAR              │")
    print(f"  │  Actual                               │")
    print(f"  │  MATCH  {tp:>7,}   {fn:>7,}  (positive) │")
    print(f"  │  NO     {fp:>7,}   {tn:>7,}  (negative) │")
    print(f"  └──────────────────────────────────────┘")
    print(f"\n  Precision: {precision:.4f}  (of flagged, how many are real matches)")
    print(f"  Recall:    {recall:.4f}  (of real matches, how many were flagged)")
    print(f"  F1 Score:  {f1:.4f}")
    print(f"  Accuracy:  {accuracy:.4f}")

    # ── Error analysis ──
    if errors_fn:
        print(f"\n  ── FALSE NEGATIVES (positive pairs auto-cleared, showing {len(errors_fn)}) ──")
        for e in errors_fn[:10]:
            print(f"    pair={e['pair_id']}: '{e['left_name']}' vs '{e['right_name']}'")
            print(f"      DOB: {e['left_dob']} vs {e['right_dob']}  |  JW={e['jw']:.3f}  phonetic={e['phonetic']:.2f}  dob={e['dob']:.2f}  country={e['country']:.2f}")

    if errors_fp:
        print(f"\n  ── FALSE POSITIVES (negative pairs flagged, showing {len(errors_fp)}) ──")
        for e in errors_fp[:10]:
            print(f"    pair={e['pair_id']}: '{e['left_name']}' vs '{e['right_name']}'")
            print(f"      JW={e['jw']:.3f}  dob={e['dob']:.2f}  decision={e['decision']}  reason={e['reason']}")

    print()


def main():
    csv_path = Path(__file__).parent / "data" / "pairs_full.csv"

    sample = 10000  # default: 10K sample
    if "--all" in sys.argv:
        sample = None
    elif "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])

    print(f"Loading pairs from {csv_path}...")
    pairs = parse_pairs(str(csv_path), sample=sample)
    n_pos = sum(1 for p in pairs if p["judgement"] == "positive")
    n_neg = len(pairs) - n_pos
    print(f"Loaded {len(pairs):,} pairs ({n_pos:,} positive, {n_neg:,} negative)")
    print(f"Scoring with 4 signals (JW, phonetic, DOB, country — no embedding)...\n")

    evaluate(pairs)


if __name__ == "__main__":
    main()
