"""FastAPI application — app factory + lifespan."""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.helpers import DATA_DIR, SANCTIONS_SETS, rebuild_services, init_stats
from app.services.llm_service import LLMService

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: load model, build FAISS index, initialize services."""
    t0 = time.perf_counter()
    try:
        # Load default sanctions list
        default_csv = DATA_DIR / SANCTIONS_SETS["demo-5k"]["file"]
        logger.info("Starting sanctions screening service...")
        sanctions_df = pd.read_csv(default_csv)
        logger.info("Loaded %d sanctions entries from CSV", len(sanctions_df))

        embedding_service, blocking_service, screening_service = rebuild_services(sanctions_df)

        # Initialize LLM service — Grok (xAI)
        xai_api_key = os.environ.get("XAI_API_KEY", "")
        grok_model = os.environ.get("GROK_MODEL", "grok-4-1-fast-reasoning")

        if xai_api_key.strip():
            llm_service = LLMService(api_key=xai_api_key.strip(), model=grok_model)
            logger.info("LLM reasoning enabled via Grok xAI (model=%s)", grok_model)
        else:
            llm_service = None
            logger.warning("No XAI_API_KEY set — LLM reasoning disabled (Layer 3 skipped)")

        # Store in app state
        app.state.sanctions_df = sanctions_df
        app.state.embedding_service = embedding_service
        app.state.screening_service = screening_service
        app.state.blocking_service = blocking_service
        app.state.llm_service = llm_service
        app.state.model_loaded = True
        app.state.active_sanctions_set = "demo-5k"
        app.state.screening_stats = init_stats()

        # Pre-process pairs in background so server starts immediately
        app.state.valid_pairs_pool = []  # empty until background load finishes

        import threading
        def _bg_load_pairs():
            pool = _load_pairs_pool()
            app.state.valid_pairs_pool = pool
            logger.info("Background pairs pool ready: %d pairs", len(pool))

        threading.Thread(target=_bg_load_pairs, daemon=True).start()

        elapsed = time.perf_counter() - t0
        bs = blocking_service.index_stats
        logger.info(
            "Service ready: %d sanctions, %d index vectors, blocking(%d DOB years, %d phonetic codes), loaded in %.2fs",
            len(sanctions_df), embedding_service.index_size, bs.get("dob_years", 0), bs.get("phonetic_codes", 0), elapsed,
        )
    except Exception:
        logger.exception("Failed to initialize services")
        app.state.model_loaded = False

    yield  # App runs

    logger.info("Shutting down…")


def _load_pairs_pool() -> list[dict]:
    """Pre-process pairs_full_pruned.csv into valid positive pairs.

    The processed pool is cached to pairs_pool_cache.pkl next to the CSV.
    The cache is reused as long as it is newer than the source CSV; if the
    CSV is updated (or the cache is missing) the pool is rebuilt and saved.
    """
    import pickle

    pairs_csv = DATA_DIR / "pairs_full_pruned.csv"
    cache_pkl = DATA_DIR / "pairs_pool_cache.pkl"

    if not pairs_csv.exists():
        return []

    # Return cached pool if it is up-to-date
    if cache_pkl.exists() and cache_pkl.stat().st_mtime >= pairs_csv.stat().st_mtime:
        try:
            t0 = time.perf_counter()
            with open(cache_pkl, "rb") as fh:
                pool = pickle.load(fh)
            logger.info("Pairs pool loaded from cache: %d pairs (%.2fs)", len(pool), time.perf_counter() - t0)
            return pool
        except Exception:
            logger.warning("Cache read failed — rebuilding from CSV", exc_info=True)

    try:
        logger.info("Pre-processing pairs_full_pruned.csv…")
        t0 = time.perf_counter()
        pairs_df = pd.read_csv(pairs_csv, low_memory=False)
        pairs_df = pairs_df[pairs_df["judgement"] == "positive"].copy()

        import re as _re

        def _ps(val) -> str:
            if val is None or (isinstance(val, float) and pd.isna(val)):
                return ""
            return str(val).strip()

        pool = []
        for pair_id, grp in pairs_df.groupby("pair_id"):
            lefts = grp[grp["side"] == "left"]
            rights = grp[grp["side"] == "right"]
            if lefts.empty or rights.empty:
                continue
            L, R = lefts.iloc[0], rights.iloc[0]
            l_first, l_last, l_dob = _ps(L.get("prop_firstName")), _ps(L.get("prop_lastName")), _ps(L.get("prop_birthDate"))
            if not l_first or not l_last or not l_dob:
                continue
            r_name = _ps(R.get("prop_name"))
            r_first, r_last = _ps(R.get("prop_firstName")), _ps(R.get("prop_lastName"))
            if not r_name and not (r_first and r_last):
                continue
            l_country = (_ps(L.get("prop_country")).split("|")[0].strip()) or None
            r_country = (_ps(R.get("prop_country")).split("|")[0].strip()) or None
            r_dob = _ps(R.get("prop_birthDate"))
            aliases = [a.strip() for a in _ps(R.get("aliases")).split("|") if a.strip()][:10]

            # Build the best Latin sanction name from available fields.
            # Priority: Latin firstName+lastName > Latin prop_name > client name as mirror
            # Positive pairs have the same person — if sanction side is non-Latin,
            # use the client's Latin name as the sanction name (they're the same person).
            _is_latin = lambda s: s and all(ord(c) < 0x0600 for c in s if not c.isspace())

            if r_first and r_last and _is_latin(r_first) and _is_latin(r_last):
                combined = f"{r_first} {r_last}"
                if len(r_first) <= 3 and r_name and _is_latin(r_name) and len(r_name) > len(combined) + 3:
                    sanction_name = r_name
                else:
                    sanction_name = combined
            elif r_name and _is_latin(r_name):
                sanction_name = r_name
            elif r_first and _is_latin(r_first) and l_last and _is_latin(l_last):
                sanction_name = f"{r_first} {l_last}"
            elif r_last and _is_latin(r_last) and l_first and _is_latin(l_first):
                sanction_name = f"{l_first} {r_last}"
            elif l_first and l_last and _is_latin(l_first) and _is_latin(l_last):
                # Sanction side is entirely non-Latin — mirror client name
                # (positive pair = same person, client name is Latin equivalent)
                sanction_name = f"{l_first} {l_last}"
            elif r_first and r_last:
                sanction_name = f"{r_first} {r_last}"
            elif r_name:
                sanction_name = r_name
            else:
                continue

            # Keep non-Latin prop_name as an alias if it differs from the Latin name
            if r_name and r_name != sanction_name and r_name not in aliases:
                aliases.insert(0, r_name)

            # Quality gate: client and sanction names must share at least one token
            # (filters out alias/code-name pairs like "Abdelmajid BENYEKHLEF" vs "Malik Al Kinany")
            _client_name = f"{l_first} {l_last}"
            _c_tokens = {t for t in _re.sub(r'[^\w\s]', '', _client_name.lower()).split() if len(t) > 2}
            _s_tokens = {t for t in _re.sub(r'[^\w\s]', '', sanction_name.lower()).split() if len(t) > 2}
            if _c_tokens and _s_tokens and not (_c_tokens & _s_tokens):
                # No shared tokens — check if it's cross-script (OK) or truly different (skip)
                _c_lat = all(ord(c) < 0x0400 for c in _client_name if c.isalpha())
                _s_lat = all(ord(c) < 0x0400 for c in sanction_name if c.isalpha())
                if _c_lat == _s_lat:
                    # Same script, no shared tokens → bad pair, skip
                    continue

            pool.append({
                "pair_id": int(pair_id),
                "client": {"first_name": l_first, "last_name": l_last, "birth_date": l_dob or None, "country": l_country},
                "sanction": {"id": _ps(R.get("id")), "name": sanction_name, "aliases": aliases, "birth_date": r_dob or None, "country": r_country},
            })
        logger.info("Pairs pool ready: %d valid positive pairs (%.1fs)", len(pool), time.perf_counter() - t0)

        # Save cache for future startups
        try:
            with open(cache_pkl, "wb") as fh:
                pickle.dump(pool, fh)
            logger.info("Pairs pool cached → %s", cache_pkl.name)
        except Exception:
            logger.warning("Failed to write pairs pool cache", exc_info=True)

        return pool
    except Exception:
        logger.warning("Failed to pre-process pairs_full_pruned.csv", exc_info=True)
        return []


def create_app() -> FastAPI:
    app = FastAPI(title="Enfuce AML Screener", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Auth guard — runs before every /api request (except login/health)
    from app.auth import auth_guard

    @app.middleware("http")
    async def _auth_middleware(request, call_next):
        await auth_guard(request)
        return await call_next(request)

    # Register routers
    from app.routers import stats, sanctions, screening, benchmark, pipeline, auth
    app.include_router(auth.router)
    app.include_router(stats.router)
    app.include_router(sanctions.router)
    app.include_router(screening.router)
    app.include_router(benchmark.router)
    app.include_router(pipeline.router)

    return app


app = create_app()
