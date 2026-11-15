"""Benchmark endpoint — evaluate L2 rules against pairs_full.csv labeled data."""

from __future__ import annotations

import csv as csv_mod
import json
import logging
import random
import time

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from app.helpers import DATA_DIR
from app.models.schemas import SignalBreakdown, SignalScore, Decision

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["benchmark"])


@router.post("/benchmark")
async def run_benchmark(request: Request, body: dict = {}) -> dict:
    sample_size = body.get("sample_size", 5000)
    pairs_path = DATA_DIR / "pairs_full.csv"
    if not pairs_path.exists():
        raise HTTPException(status_code=404, detail="pairs_full.csv not found")

    screening_svc = getattr(request.app.state, "screening_service", None)
    embedding_svc = getattr(request.app.state, "embedding_service", None)
    if not screening_svc:
        raise HTTPException(status_code=503, detail="Screening service not loaded")

    from jellyfish import metaphone

    # Load & group pairs
    pairs: dict = {}
    with open(pairs_path) as f:
        for row in csv_mod.DictReader(f):
            pid = row["pair_id"]
            if pid not in pairs:
                pairs[pid] = {"left": None, "right": None, "judgement": row["judgement"]}
            pairs[pid][row["side"]] = row

    # Sample
    random.seed(42)
    pair_ids = list(pairs.keys())
    random.shuffle(pair_ids)
    sample_ids = pair_ids[:sample_size]

    # Helpers
    def _parse_dob(s: str):
        return s[:4] if s and len(s) >= 4 else None

    def _dob_score(a: str, b: str):
        if not a or not b: return 0.0, True
        ya, yb = _parse_dob(a), _parse_dob(b)
        if not ya or not yb: return 0.0, True
        if a == b and len(a) >= 10: return 1.0, False
        if ya == yb: return 0.8, False
        if abs(int(ya) - int(yb)) <= 1: return 0.4, False
        return 0.0, False

    def _country_score(a: str, b: str):
        if not a or not b: return 0.0, True
        sa = set(a.lower().replace(" ", "").split("|"))
        sb = set(b.lower().replace(" ", "").split("|"))
        return (1.0, False) if sa & sb else (0.0, False)

    def _phonetic(na: str, nb: str):
        ta, tb = na.lower().split(), nb.lower().split()
        if not ta or not tb: return 0.0
        ca, cb = set(), set()
        for t in ta:
            try: ca.add(metaphone(t))
            except Exception: pass
        for t in tb:
            try: cb.add(metaphone(t))
            except Exception: pass
        if not ca or not cb: return 0.0
        return min(len(ca & cb) / max(len(ca), 1), 1.0)

    # Precompute embeddings in batch
    use_embedding = body.get("use_embedding", True)
    emb_scores: dict[str, float] = {}

    if use_embedding and embedding_svc:
        name_pairs = []
        for pid in sample_ids:
            p = pairs[pid]
            if not p["left"] or not p["right"]: continue
            na, nb = p["left"]["prop_name"], p["right"]["prop_name"]
            if not na or not nb: continue
            name_pairs.append((pid, na, nb))

        if name_pairs:
            all_names = []
            for _, na, nb in name_pairs:
                all_names.extend([na, nb])
            model = embedding_svc._model
            all_embs = model.encode(all_names, normalize_embeddings=True, batch_size=256)
            for i, (pid, na, nb) in enumerate(name_pairs):
                raw = float(np.dot(all_embs[i * 2], all_embs[i * 2 + 1]))
                emb_scores[pid] = max(0.0, min(1.0, raw))

    # Evaluate
    from jellyfish import jaro_winkler_similarity
    tp = fp = fn = tn = 0
    tp_rules: dict = {}
    fn_examples: list = []
    fp_examples: list = []

    t0 = time.perf_counter()
    for pid in sample_ids:
        p = pairs[pid]
        if not p["left"] or not p["right"]: continue
        na, nb = p["left"]["prop_name"], p["right"]["prop_name"]
        if not na or not nb: continue

        jw = jaro_winkler_similarity(na.lower(), nb.lower())
        ph = _phonetic(na, nb)
        dob_s, dob_m = _dob_score(p["left"]["prop_birthDate"], p["right"]["prop_birthDate"])
        co_s, co_m = _country_score(
            p["left"].get("prop_country") or p["left"].get("prop_nationality", ""),
            p["right"].get("prop_country") or p["right"].get("prop_nationality", ""),
        )
        emb_s = emb_scores.get(pid, 0.0)

        bd = SignalBreakdown(
            dob=SignalScore(signal_name="dob", score=dob_s, detail="", missing=dob_m),
            name_jw=SignalScore(signal_name="name_jw", score=jw, detail="", missing=False),
            phonetic=SignalScore(signal_name="phonetic", score=ph, detail="", missing=False),
            embedding=SignalScore(signal_name="embedding", score=emb_s, detail="", missing=False),
            country=SignalScore(signal_name="country", score=co_s, detail="", missing=co_m),
        )
        decision, reason = screening_svc._apply_rules(bd)
        is_positive = p["judgement"] == "positive"
        is_flagged = decision != Decision.AUTO_CLEAR

        if is_positive and is_flagged:
            tp += 1
            rule_key = reason.split(". Signals")[0] if ". Signals" in reason else reason.split(".")[0]
            tp_rules[rule_key] = tp_rules.get(rule_key, 0) + 1
        elif is_positive and not is_flagged:
            fn += 1
            if len(fn_examples) < 20:
                fn_examples.append({"name_a": na, "name_b": nb, "jw": round(jw, 3), "phonetic": round(ph, 3), "embedding": round(emb_s, 3), "dob": round(dob_s, 1), "country": round(co_s, 1)})
        elif not is_positive and is_flagged:
            fp += 1
            if len(fp_examples) < 20:
                fp_examples.append({"name_a": na, "name_b": nb, "jw": round(jw, 3), "phonetic": round(ph, 3), "embedding": round(emb_s, 3), "dob": round(dob_s, 1), "country": round(co_s, 1), "rule": reason.split(". Signals")[0] if ". Signals" in reason else reason})
        else:
            tn += 1

    elapsed = time.perf_counter() - t0
    total = tp + fp + fn + tn
    precision = tp / (tp + fp) if (tp + fp) else 0
    recall = tp / (tp + fn) if (tp + fn) else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0

    return {
        "sample_size": total,
        "elapsed_s": round(elapsed, 2),
        "use_embedding": use_embedding,
        "confusion_matrix": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "alert_rate": round((tp + fp) / total, 4) if total else 0,
        "tp_rules": dict(sorted(tp_rules.items(), key=lambda x: -x[1])),
        "fn_examples": fn_examples,
        "fp_examples": fp_examples,
    }
