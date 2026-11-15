"""
Evaluate with embedding signal included.
Uses SentenceTransformer to compute cosine similarity between pair names.

Usage:
    python evaluate_pairs_with_embedding.py               # 10K sample
    python evaluate_pairs_with_embedding.py --sample 50000
    python evaluate_pairs_with_embedding.py --all
"""

import csv
import sys
import time
import numpy as np
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from sentence_transformers import SentenceTransformer
from app.models.schemas import SignalScore, SignalBreakdown, Decision
from app.services.screening_service import (
    _best_token_jw,
    _phonetic_score,
    _dob_score_normalized,
    _country_score_normalized,
)


def parse_pairs(csv_path: str, sample: int | None = None) -> list[dict]:
    rows_by_pair: dict[str, list[dict]] = defaultdict(list)
    with open(csv_path) as f:
        for row in csv.DictReader(f):
            rows_by_pair[row["pair_id"]].append(row)

    pairs = []
    for pair_id, rows in rows_by_pair.items():
        left = next((r for r in rows if r["side"] == "left"), None)
        right = next((r for r in rows if r["side"] == "right"), None)
        if left and right:
            pairs.append({"pair_id": pair_id, "judgement": left["judgement"], "left": left, "right": right})

    if sample and sample < len(pairs):
        import random
        random.seed(42)
        pos = [p for p in pairs if p["judgement"] == "positive"]
        neg = [p for p in pairs if p["judgement"] == "negative"]
        ratio = len(pos) / len(pairs)
        n_pos = int(sample * ratio)
        n_neg = sample - n_pos
        pairs = random.sample(pos, min(n_pos, len(pos))) + random.sample(neg, min(n_neg, len(neg)))
        random.shuffle(pairs)
    return pairs


def normalize_country(raw: str) -> str | None:
    if not raw or raw.strip() == "":
        return None
    return raw.split("|")[0].strip().upper()


def apply_rules(bd: SignalBreakdown) -> tuple[Decision, str]:
    """Full rule engine including embedding-dependent rules."""
    # E1
    if bd.dob.score >= 1.0 and bd.name_jw.score >= 0.85:
        return Decision.ESCALATE, "exact DOB + strong name (JW≥0.85)"
    # E2
    if bd.dob.score >= 1.0 and bd.embedding.score >= 0.80 and bd.phonetic.score >= 0.5:
        return Decision.ESCALATE, "exact DOB + strong embedding + phonetic"
    # E3
    if bd.name_jw.score >= 0.92 and bd.dob.score >= 0.8 and bd.country.score >= 1.0:
        return Decision.ESCALATE, "very strong name + same-year DOB + country"
    # E4
    if bd.embedding.score >= 0.90 and bd.dob.score >= 0.8:
        if any([bd.name_jw.score >= 0.5, bd.phonetic.score >= 0.5, bd.country.score >= 0.5]):
            return Decision.ESCALATE, "strong embedding + DOB + corroboration"

    # Missing data caution
    has_missing = bd.dob.missing or bd.country.missing
    has_strong_name = bd.name_jw.score >= 0.75 or bd.embedding.score >= 0.70
    if has_missing and has_strong_name:
        return Decision.NEEDS_REVIEW, "missing data + strong name signals"

    if bd.name_jw.score >= 0.85 and bd.dob.score >= 0.4:
        return Decision.NEEDS_REVIEW, "strong name + partial DOB"
    if bd.embedding.score >= 0.80 and bd.name_jw.score >= 0.70:
        return Decision.NEEDS_REVIEW, "strong embedding + moderate name"
    if bd.name_jw.score >= 0.92:
        return Decision.NEEDS_REVIEW, "very strong name alone"
    if bd.embedding.score >= 0.85 and bd.phonetic.score >= 0.5:
        return Decision.NEEDS_REVIEW, "strong embedding + phonetic"
    if bd.dob.score >= 1.0 and (bd.name_jw.score >= 0.70 or bd.embedding.score >= 0.65):
        return Decision.NEEDS_REVIEW, "exact DOB + moderate name/embedding"
    if bd.dob.score >= 0.8 and bd.name_jw.score >= 0.75 and bd.country.score >= 1.0:
        return Decision.NEEDS_REVIEW, "same-year DOB + name + country"

    # R7: Exact DOB + any embedding signal — cross-script safety net
    if bd.dob.score >= 1.0 and bd.embedding.score >= 0.50:
        return Decision.NEEDS_REVIEW, "exact DOB + embedding (≥0.50) — cross-script"

    # R8: Same-year DOB + embedding + country — cross-script with metadata
    if bd.dob.score >= 0.8 and bd.embedding.score >= 0.60 and bd.country.score >= 1.0:
        return Decision.NEEDS_REVIEW, "same-year DOB + embedding (≥0.60) + country"

    return Decision.AUTO_CLEAR, "below thresholds"


def main():
    csv_path = Path(__file__).parent / "data" / "pairs_full.csv"

    sample = 10000
    if "--all" in sys.argv:
        sample = None
    elif "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])

    print("Loading pairs...")
    pairs = parse_pairs(str(csv_path), sample=sample)
    n_pos = sum(1 for p in pairs if p["judgement"] == "positive")
    print(f"Loaded {len(pairs):,} pairs ({n_pos:,} pos, {len(pairs)-n_pos:,} neg)")

    # ── Batch-encode all names ──
    print("Loading embedding model...")
    model = SentenceTransformer("paraphrase-multilingual-MiniLM-L12-v2")

    left_names = [p["left"]["prop_name"] for p in pairs]
    right_names = [p["right"]["prop_name"] for p in pairs]

    print(f"Encoding {len(pairs)*2:,} names...")
    t0 = time.time()
    left_embs = model.encode(left_names, batch_size=256, normalize_embeddings=True, show_progress_bar=True)
    right_embs = model.encode(right_names, batch_size=256, normalize_embeddings=True, show_progress_bar=True)
    print(f"Encoded in {time.time()-t0:.1f}s")

    # Cosine similarity (already normalized → dot product)
    emb_scores = np.sum(left_embs * right_embs, axis=1)
    emb_scores = np.clip(emb_scores, 0.0, 1.0)

    # ── Score all pairs ──
    print("Scoring pairs with 5 signals...")
    tp = fp = tn = fn = 0
    decision_counts = Counter()
    errors_fn = []
    errors_fp = []

    t0 = time.time()
    for i, pair in enumerate(pairs):
        l, r = pair["left"], pair["right"]
        emb = float(emb_scores[i])

        jw = _best_token_jw(l["prop_name"], r["prop_name"])
        ph = _phonetic_score(l["prop_name"], r["prop_name"])
        dob_score, dob_missing, dob_detail = _dob_score_normalized(
            l["prop_birthDate"] or None, r["prop_birthDate"] or None)
        l_country = normalize_country(l["prop_country"])
        r_country = normalize_country(r["prop_country"])
        c_score, c_missing, c_detail = _country_score_normalized(l_country, r_country)

        bd = SignalBreakdown(
            dob=SignalScore(signal_name="dob", score=dob_score, detail=dob_detail, missing=dob_missing),
            name_jw=SignalScore(signal_name="name_jw", score=jw, detail="", missing=False),
            phonetic=SignalScore(signal_name="phonetic", score=ph, detail="", missing=False),
            embedding=SignalScore(signal_name="embedding", score=emb, detail="", missing=False),
            country=SignalScore(signal_name="country", score=c_score, detail=c_detail, missing=c_missing),
        )

        decision, reason = apply_rules(bd)
        is_positive = pair["judgement"] == "positive"
        is_flagged = decision != Decision.AUTO_CLEAR

        decision_counts[decision.value] += 1

        if is_positive and is_flagged:
            tp += 1
        elif is_positive and not is_flagged:
            fn += 1
            if len(errors_fn) < 20:
                errors_fn.append({
                    "pair_id": pair["pair_id"],
                    "left": l["prop_name"], "right": r["prop_name"],
                    "l_dob": l["prop_birthDate"], "r_dob": r["prop_birthDate"],
                    "jw": jw, "ph": ph, "emb": emb, "dob": dob_score, "country": c_score,
                    "reason": reason,
                })
        elif not is_positive and is_flagged:
            fp += 1
            if len(errors_fp) < 20:
                errors_fp.append({
                    "pair_id": pair["pair_id"],
                    "left": l["prop_name"], "right": r["prop_name"],
                    "jw": jw, "emb": emb, "dob": dob_score, "country": c_score,
                    "decision": decision.value, "reason": reason,
                })
        else:
            tn += 1

        if (i + 1) % 5000 == 0:
            print(f"  ... {i+1}/{len(pairs)} ({time.time()-t0:.1f}s)")

    elapsed = time.time() - t0
    total = tp + fp + tn + fn
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    print("\n" + "=" * 60)
    print("  EVALUATION RESULTS (5 signals: JW + phonetic + embedding + DOB + country)")
    print("=" * 60)
    print(f"\n  Dataset:  {total:,} pairs ({tp+fn:,} pos, {fp+tn:,} neg)")
    print(f"  Scoring:  {elapsed:.1f}s ({total/elapsed:,.0f} pairs/sec)")
    print(f"\n  Decisions:")
    for d, c in sorted(decision_counts.items()):
        print(f"    {d:15s}: {c:>7,} ({100*c/total:.1f}%)")

    print(f"\n  ┌──────────────────────────────────────┐")
    print(f"  │         Predicted                     │")
    print(f"  │           FLAG     CLEAR              │")
    print(f"  │  MATCH  {tp:>7,}   {fn:>7,}  (positive) │")
    print(f"  │  NO     {fp:>7,}   {tn:>7,}  (negative) │")
    print(f"  └──────────────────────────────────────┘")
    print(f"\n  Precision: {precision:.4f}")
    print(f"  Recall:    {recall:.4f}")
    print(f"  F1:        {f1:.4f}")

    if errors_fn:
        print(f"\n  ── FALSE NEGATIVES (first {min(len(errors_fn),10)}) ──")
        for e in errors_fn[:10]:
            print(f"    pair={e['pair_id']}: '{e['left']}' vs '{e['right']}'")
            print(f"      JW={e['jw']:.3f}  emb={e['emb']:.3f}  ph={e['ph']:.2f}  dob={e['dob']:.2f}  country={e['country']:.2f}")

    if errors_fp:
        print(f"\n  ── FALSE POSITIVES (first {min(len(errors_fp),10)}) ──")
        for e in errors_fp[:10]:
            print(f"    pair={e['pair_id']}: '{e['left']}' vs '{e['right']}'")
            print(f"      JW={e['jw']:.3f}  emb={e['emb']:.3f}  dob={e['dob']:.2f}  country={e['country']:.2f}  → {e['decision']}: {e['reason']}")

    # ── Embedding-only baseline ──
    print(f"\n  ── EMBEDDING-ONLY BASELINE (threshold sweep) ──")
    for thresh in [0.50, 0.60, 0.70, 0.80, 0.90]:
        _tp = _fp = _tn = _fn = 0
        for i, pair in enumerate(pairs):
            is_pos = pair["judgement"] == "positive"
            flagged = float(emb_scores[i]) >= thresh
            if is_pos and flagged: _tp += 1
            elif is_pos and not flagged: _fn += 1
            elif not is_pos and flagged: _fp += 1
            else: _tn += 1
        _p = _tp / (_tp + _fp) if (_tp + _fp) else 0
        _r = _tp / (_tp + _fn) if (_tp + _fn) else 0
        _f1 = 2*_p*_r / (_p+_r) if (_p+_r) else 0
        print(f"    emb≥{thresh:.2f}: P={_p:.3f} R={_r:.3f} F1={_f1:.3f}  (flagged={_tp+_fp:,})")


if __name__ == "__main__":
    main()
