"""
End-to-end evaluation: run the full pipeline against pairs benchmark
and compare results with the ground truth answer key.

Usage:
    python evaluate_e2e.py              # sample 5K customers
    python evaluate_e2e.py --sample 20000
    python evaluate_e2e.py --all        # all 152K (slow — needs index build)
"""

import csv
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import pandas as pd
from app.services.embedding_service import EmbeddingService
from app.services.blocking_service import BlockingService
from app.services.screening_service import ScreeningService


def main():
    data_dir = Path(__file__).parent / "data"

    sample = 5000
    if "--all" in sys.argv:
        sample = None
    elif "--sample" in sys.argv:
        idx = sys.argv.index("--sample")
        sample = int(sys.argv[idx + 1])

    # ── Load sanctions ──
    print("Loading sanctions list...")
    sanctions_df = pd.read_csv(data_dir / "sanctions_pairs.csv")
    print(f"  {len(sanctions_df)} sanctions entries")

    # ── Build services ──
    print("Building embedding index (this may take a while on first run)...")
    t0 = time.time()
    es = EmbeddingService()
    es.load_and_index(sanctions_df)
    print(f"  Embedding index: {es.index_size} vectors ({time.time()-t0:.1f}s)")

    bs = BlockingService()
    bs.build_indexes(sanctions_df)
    stats = bs.index_stats
    print(f"  Blocking index: {stats['dob_years']} DOB years, {stats['phonetic_codes']} phonetic codes")

    ss = ScreeningService(es, bs, sanctions_df)

    # ── Load customers ──
    print("Loading customers...")
    customers = []
    with open(data_dir / "customers_pairs.csv") as f:
        for row in csv.DictReader(f):
            customers.append((row["Full_Name"], row.get("Date_of_Birth") or None, row.get("Country") or None))

    # ── Load answer key ──
    print("Loading answer key...")
    expected_match = {}  # customer_name -> set of sanction_ids
    with open(data_dir / "answer_key_pairs.csv") as f:
        for row in csv.DictReader(f):
            name = row["customer_name"]
            sids = set(row["expected_sanction_ids"].split(";"))
            expected_match[name] = sids

    # ── Sample ──
    if sample and sample < len(customers):
        import random
        random.seed(42)
        customers = random.sample(customers, sample)

    print(f"\nScreening {len(customers):,} customers against {len(sanctions_df):,} sanctions...")

    # ── Screen ──
    tp = fp = tn = fn = 0
    decision_counts = Counter()
    fn_examples = []
    fp_examples = []

    t0 = time.time()
    results = ss.screen_many(customers)
    elapsed = time.time() - t0

    for (name, dob, country), result in zip(customers, results):
        is_positive = name in expected_match
        is_flagged = result.decision.value != "AUTO_CLEAR"

        decision_counts[result.decision.value] += 1

        if is_positive and is_flagged:
            tp += 1
        elif is_positive and not is_flagged:
            fn += 1
            if len(fn_examples) < 10:
                fn_examples.append({"name": name, "dob": dob, "expected": expected_match[name]})
        elif not is_positive and is_flagged:
            fp += 1
            if len(fp_examples) < 10:
                top = result.matches[0] if result.matches else None
                fp_examples.append({
                    "name": name,
                    "decision": result.decision.value,
                    "match": top.matched_name if top else "?",
                    "score": f"{top.similarity_score:.1%}" if top else "?",
                })
        else:
            tn += 1

    # ── Metrics ──
    total = tp + fp + tn + fn
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0

    print(f"\n{'='*60}")
    print(f"  END-TO-END PIPELINE EVALUATION")
    print(f"{'='*60}")
    print(f"\n  Customers:  {total:,} ({tp+fn:,} with match, {fp+tn:,} without)")
    print(f"  Sanctions:  {len(sanctions_df):,}")
    print(f"  Time:       {elapsed:.1f}s ({total/elapsed:,.0f} customers/sec)")
    print(f"\n  Decisions:")
    for d, c in sorted(decision_counts.items()):
        print(f"    {d:15s}: {c:>7,} ({100*c/total:.1f}%)")

    print(f"\n  ┌──────────────────────────────────────┐")
    print(f"  │           FLAG     CLEAR              │")
    print(f"  │  MATCH  {tp:>7,}   {fn:>7,}  (positive) │")
    print(f"  │  NO     {fp:>7,}   {tn:>7,}  (negative) │")
    print(f"  └──────────────────────────────────────┘")
    print(f"\n  Precision: {precision:.4f}")
    print(f"  Recall:    {recall:.4f}")
    print(f"  F1:        {f1:.4f}")

    if fn_examples:
        print(f"\n  ── FALSE NEGATIVES (missed matches) ──")
        for e in fn_examples:
            print(f"    '{e['name']}' (expected: {e['expected']})")

    if fp_examples:
        print(f"\n  ── FALSE POSITIVES (wrong flags) ──")
        for e in fp_examples:
            print(f"    '{e['name']}' → {e['decision']} (matched: {e['match']} {e['score']})")


if __name__ == "__main__":
    main()
