"""Integration tests for the FastAPI sanctions screening API."""

from __future__ import annotations

import csv
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services.llm_service import LLMService

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@pytest_asyncio.fixture(scope="module")
async def client():
    """Create a test client with the real app (model loaded once per module)."""
    app = create_app()
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac


@pytest_asyncio.fixture
async def client_with_llm():
    """Create a test client with a mocked LLMService injected into app state."""
    app = create_app()
    async with LifespanManager(app) as manager:
        # Inject a mock LLM service into the app we created
        mock_llm = AsyncMock(spec=LLMService)
        mock_llm.analyze = AsyncMock(return_value={
            "decision": "ESCALATE",
            "confidence": 92,
            "reasoning": "High name similarity with Qasem Soleimani. Missing DOB increases uncertainty.",
            "processing_time_ms": 1234.5,
        })
        app.state.llm_service = mock_llm

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac, mock_llm


@pytest_asyncio.fixture
async def client_with_failing_llm():
    """Create a test client with an LLMService that raises on analyze()."""
    app = create_app()
    async with LifespanManager(app) as manager:
        mock_llm = AsyncMock(spec=LLMService)
        mock_llm.analyze = AsyncMock(side_effect=Exception("Anthropic API timeout"))
        app.state.llm_service = mock_llm

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac


# ── Health ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_health_returns_healthy(client: AsyncClient):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["model_loaded"] is True
    assert body["index_size"] > 0


# ── Stats ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_returns_correct_counts(client: AsyncClient):
    resp = await client.get("/api/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sanctions_count"] == 30
    assert body["index_size"] > 0
    assert body["model_loaded"] is True
    assert body["threshold"] == 0.60


# ── Sanctions list ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sanctions_returns_all_entries(client: AsyncClient):
    resp = await client.get("/api/sanctions")
    assert resp.status_code == 200
    entries = resp.json()
    assert len(entries) == 30
    # Spot-check first entry has expected fields
    entry = entries[0]
    assert "Sanction_ID" in entry or "sanction_id" in entry


# ── Screen: positive match ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_screen_kasim_suleymani_finds_match(client: AsyncClient):
    """Known answer-key target: Kasim Suleymani → EU-0009."""
    resp = await client.post("/api/screen", json={"name": "Kasim Suleymani"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["query_name"] == "Kasim Suleymani"
    assert body["decision"] in ("NEEDS_REVIEW", "ESCALATE")
    # EU-0009 (Qasem Soleimani) must appear in matches
    match_ids = [m["sanctions_id"] for m in body["matches"]]
    assert "EU-0009" in match_ids, f"EU-0009 not in matches: {match_ids}"


# ── Screen: no match (AUTO_CLEAR) ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_screen_random_name_auto_clears(client: AsyncClient):
    """A completely unrelated name should return AUTO_CLEAR."""
    resp = await client.post("/api/screen", json={"name": "John Doe Smith"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "AUTO_CLEAR"


# ── Screen: validation errors (negative tests) ───────────────────────────────


@pytest.mark.asyncio
async def test_screen_missing_name_returns_422(client: AsyncClient):
    """POST without required 'name' field → 422."""
    resp = await client.post("/api/screen", json={})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_screen_empty_name_returns_422(client: AsyncClient):
    """POST with empty name → 422 (min_length=1)."""
    resp = await client.post("/api/screen", json={"name": ""})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_screen_name_too_long_returns_422(client: AsyncClient):
    """POST with name exceeding max_length → 422."""
    long_name = "A" * 201
    resp = await client.post("/api/screen", json={"name": long_name})
    assert resp.status_code == 422


# ── Wrong method ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_screen_returns_405(client: AsyncClient):
    """GET /api/screen (wrong method) → 405."""
    resp = await client.get("/api/screen")
    assert resp.status_code == 405


# ── CORS ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cors_headers_present(client: AsyncClient):
    """Preflight request from localhost:3000 should return CORS headers."""
    resp = await client.options(
        "/api/health",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert resp.status_code == 200
    assert "access-control-allow-origin" in resp.headers
    assert resp.headers["access-control-allow-origin"] == "http://localhost:3000"


# ── LLM Integration (mocked) ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_screen_with_mocked_llm_returns_escalate(client_with_llm):
    """With mocked LLM service, NEEDS_REVIEW → ESCALATE via Layer 3."""
    ac, mock_llm = client_with_llm
    resp = await ac.post("/api/screen", json={"name": "Kasim Suleymani"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "ESCALATE"
    assert body["layer_reached"] == 3
    assert body["llm_reasoning"] is not None
    assert len(body["llm_reasoning"]) > 0
    assert body["llm_confidence"] == 92
    assert body["processing_time_ms"] > 0
    # LLM analyze was called exactly once
    mock_llm.analyze.assert_awaited_once()


@pytest.mark.asyncio
async def test_screen_auto_clear_skips_llm(client_with_llm):
    """AUTO_CLEAR result (Layer 1) should NOT invoke LLM — LLM never called."""
    ac, mock_llm = client_with_llm
    resp = await ac.post("/api/screen", json={"name": "John Doe Smith"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "AUTO_CLEAR"
    assert body["layer_reached"] == 1
    assert body["llm_reasoning"] is None
    # LLM should NOT have been called for auto-clear
    mock_llm.analyze.assert_not_awaited()


@pytest.mark.asyncio
async def test_screen_llm_error_falls_back_to_needs_review(client_with_failing_llm):
    """When LLM raises, endpoint returns original NEEDS_REVIEW (graceful degradation)."""
    ac = client_with_failing_llm
    resp = await ac.post("/api/screen", json={"name": "Kasim Suleymani"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["decision"] == "NEEDS_REVIEW"
    # LLM fields should be None since it failed
    assert body["llm_reasoning"] is None
    assert body["llm_confidence"] is None


# ── LLM Integration (real Claude — skipped without API key) ──────────────────


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set — skipping real Claude integration test",
)
async def test_screen_real_claude():
    """Integration test with real Claude API — only runs when ANTHROPIC_API_KEY is set."""
    app = create_app()
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            resp = await ac.post("/api/screen", json={"name": "Kasim Suleymani"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["decision"] in ("ESCALATE", "AUTO_CLEAR")
            assert body["llm_reasoning"] is not None
            assert isinstance(body["llm_reasoning"], str)
            assert len(body["llm_reasoning"]) > 0
            assert isinstance(body["llm_confidence"], int)
            assert 0 <= body["llm_confidence"] <= 100
            assert body["processing_time_ms"] > 0
            assert body["layer_reached"] == 3


# ── Helper: fresh app client (clean stats) ────────────────────────────────────


@pytest_asyncio.fixture
async def fresh_client():
    """Create a test client from a fresh app instance — clean stats accumulator."""
    app = create_app()
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac


@pytest_asyncio.fixture
async def fresh_client_with_llm():
    """Fresh app with mocked LLM — clean stats + LLM layer 3."""
    app = create_app()
    async with LifespanManager(app) as manager:
        mock_llm = AsyncMock(spec=LLMService)
        mock_llm.analyze = AsyncMock(return_value={
            "decision": "ESCALATE",
            "confidence": 88,
            "reasoning": "Name matches sanctioned individual with high phonetic similarity.",
            "processing_time_ms": 500.0,
        })
        app.state.llm_service = mock_llm

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield ac, mock_llm


# ── Batch Screening ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_screen_small_list(client: AsyncClient):
    """Batch screen 3 customers — 1 known target, 2 random. Verify decisions and summary."""
    payload = {
        "customers": [
            {"name": "Kasim Suleymani"},
            {"name": "Alice Wonderland"},
            {"name": "Bob Builder"},
        ]
    }
    resp = await client.post("/api/batch-screen", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 3

    # Known target should not auto-clear
    target_result = body["results"][0]
    assert target_result["query_name"] == "Kasim Suleymani"
    assert target_result["decision"] in ("NEEDS_REVIEW", "ESCALATE")
    assert target_result["top_match_score"] is not None
    assert target_result["top_match_score"] > 0.3  # aggregate signal strength (lower without DOB/country)

    # S02: non-AUTO_CLEAR results must include signal_breakdown and reasoning
    assert target_result.get("signal_breakdown") is not None, "signal_breakdown missing from batch result"
    bd = target_result["signal_breakdown"]
    for signal_key in ("dob", "name_jw", "phonetic", "embedding", "country"):
        assert signal_key in bd, f"signal '{signal_key}' missing from breakdown"
    assert target_result.get("reasoning") is not None, "reasoning missing from batch result"
    assert len(target_result["reasoning"]) > 0

    # Random names should auto-clear
    assert body["results"][1]["decision"] == "AUTO_CLEAR"
    assert body["results"][2]["decision"] == "AUTO_CLEAR"
    # AUTO_CLEAR results should have no signal_breakdown (no candidates)
    assert body["results"][1].get("signal_breakdown") is None
    assert body["results"][2].get("signal_breakdown") is None

    # Summary counts should match
    summary = body["summary"]
    assert summary["total"] == 3
    auto_cleared = summary["auto_cleared"]
    needs_review = summary["needs_review"]
    escalated = summary["escalated"]
    assert auto_cleared + needs_review + escalated == 3
    assert auto_cleared == 2  # two randoms
    assert needs_review + escalated == 1  # the target


@pytest.mark.asyncio
async def test_batch_screen_with_mocked_llm(fresh_client_with_llm):
    """With mocked LLM, NEEDS_REVIEW targets should escalate via Layer 3."""
    ac, mock_llm = fresh_client_with_llm
    payload = {
        "customers": [
            {"name": "Kasim Suleymani"},
        ]
    }
    resp = await ac.post("/api/batch-screen", json=payload)
    assert resp.status_code == 200
    body = resp.json()

    result = body["results"][0]
    assert result["decision"] == "ESCALATE"
    assert result["layer_reached"] == 3
    assert result["llm_reasoning"] is not None
    assert len(result["llm_reasoning"]) > 0
    assert result["llm_confidence"] == 88
    mock_llm.analyze.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get("RUN_SLOW_TESTS"),
    reason="100K CSV batch test is very slow (~10min). Set RUN_SLOW_TESTS=1 to enable.",
)
async def test_batch_screen_empty_customers_loads_csv(client: AsyncClient):
    """Empty customers list loads server-side CSV — expect 100K results.

    This test screens all 100K customers and takes ~10 minutes.
    Run with: RUN_SLOW_TESTS=1 pytest tests/test_api.py -k empty_customers
    """
    resp = await client.post("/api/batch-screen", json={"customers": []}, timeout=900.0)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 100_000
    assert body["summary"]["total"] == 100_000
    # At least some should be auto-cleared
    assert body["summary"]["auto_cleared"] > 0


# ── Sanctions Add ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sanctions_add_new_entry(fresh_client):
    """Add a new sanctions entry. Verify response shape."""
    payload = {
        "sanction_id": "TEST-001",
        "full_name": "Test Sanctioned Person",
        "nationality": "Testlandia",
        "sanctions_program": "EU-TEST",
    }
    resp = await fresh_client.post("/api/sanctions/add", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "added"
    assert body["sanction_id"] == "TEST-001"
    assert body["vectors_added"] == 1  # only full_name, no aliases


@pytest.mark.asyncio
async def test_sanctions_add_then_screen_finds_match(fresh_client):
    """Add a sanctions entry, then screen a matching name — proves live FAISS re-indexing."""
    # Add a distinctive name that won't match existing sanctions
    add_payload = {
        "sanction_id": "TEST-REINDEX-001",
        "full_name": "Zygmunt Brzezinski-Testnikov",
    }
    add_resp = await fresh_client.post("/api/sanctions/add", json=add_payload)
    assert add_resp.status_code == 200
    assert add_resp.json()["vectors_added"] == 1

    # Screen the exact same name — should find our new entry
    screen_resp = await fresh_client.post("/api/screen", json={"name": "Zygmunt Brzezinski-Testnikov"})
    assert screen_resp.status_code == 200
    screen_body = screen_resp.json()
    assert screen_body["decision"] in ("NEEDS_REVIEW", "ESCALATE")
    match_ids = [m["sanctions_id"] for m in screen_body["matches"]]
    assert "TEST-REINDEX-001" in match_ids, f"New entry not found in matches: {match_ids}"
    # Should have a meaningful aggregate score (name signals strong, DOB/country missing)
    top_match = next(m for m in screen_body["matches"] if m["sanctions_id"] == "TEST-REINDEX-001")
    assert top_match["similarity_score"] > 0.4


@pytest.mark.asyncio
async def test_sanctions_add_with_aliases(fresh_client):
    """Add entry with alias_1 and alias_2 — verify 3 vectors added and aliases are findable."""
    add_payload = {
        "sanction_id": "TEST-ALIAS-001",
        "full_name": "Xylophonicus Maximilian Testworth",
        "alias_1": "Xylo Testworth",
        "alias_2": "Max Testworth",
    }
    add_resp = await fresh_client.post("/api/sanctions/add", json=add_payload)
    assert add_resp.status_code == 200
    body = add_resp.json()
    assert body["vectors_added"] == 3  # full_name + 2 aliases

    # Screen by alias_1 — should find our new entry
    screen_resp = await fresh_client.post("/api/screen", json={"name": "Xylo Testworth"})
    assert screen_resp.status_code == 200
    screen_body = screen_resp.json()
    match_ids = [m["sanctions_id"] for m in screen_body["matches"]]
    assert "TEST-ALIAS-001" in match_ids, f"Alias lookup failed: {match_ids}"


# ── Stats ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stats_initial_values(fresh_client):
    """Fresh app: stats should have zero screening counts but valid base data."""
    resp = await fresh_client.get("/api/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_screenings"] == 0
    assert body["decision_distribution"]["AUTO_CLEAR"] == 0
    assert body["decision_distribution"]["ESCALATE"] == 0
    assert body["decision_distribution"]["NEEDS_REVIEW"] == 0
    assert body["avg_processing_time_ms"] == 0.0
    # Base stats still present
    assert body["sanctions_count"] == 30
    assert body["index_size"] > 0
    assert body["model_loaded"] is True


@pytest.mark.asyncio
async def test_stats_increment_after_screen(fresh_client):
    """Screen a random name (AUTO_CLEAR), then verify stats incremented."""
    # Screen a random name
    await fresh_client.post("/api/screen", json={"name": "Totally Random Name"})

    resp = await fresh_client.get("/api/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_screenings"] == 1
    assert body["decision_distribution"]["AUTO_CLEAR"] == 1


@pytest.mark.asyncio
async def test_stats_increment_after_batch(fresh_client):
    """Batch screen 2 customers, then verify stats incremented by 2."""
    payload = {
        "customers": [
            {"name": "Random Person One"},
            {"name": "Random Person Two"},
        ]
    }
    await fresh_client.post("/api/batch-screen", json=payload)

    resp = await fresh_client.get("/api/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_screenings"] == 2


# ── Answer Key Validation ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_screen_finds_all_10_targets(fresh_client):
    """Load 10 hidden target names from answer key, batch screen them, verify all detected."""
    answer_key_path = DATA_DIR / "answer_key.csv"
    assert answer_key_path.exists(), f"Answer key not found: {answer_key_path}"

    target_names = []
    expected_ids = []
    with open(answer_key_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            target_names.append(row["Obfuscated_Name_in_Customer_List"])
            expected_ids.append(row["Original_Sanction_ID"])

    assert len(target_names) == 10, f"Expected 10 targets, got {len(target_names)}"

    payload = {"customers": [{"name": name} for name in target_names]}
    resp = await fresh_client.post("/api/batch-screen", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 10

    # Every target must NOT be AUTO_CLEAR — either NEEDS_REVIEW or ESCALATE
    missed = []
    for i, result in enumerate(body["results"]):
        if result["decision"] == "AUTO_CLEAR":
            missed.append(f"{target_names[i]} (expected {expected_ids[i]})")

    assert len(missed) == 0, (
        f"Missed {len(missed)}/10 targets (got AUTO_CLEAR):\n"
        + "\n".join(f"  - {m}" for m in missed)
    )

    # S02: Every non-AUTO_CLEAR result must include signal_breakdown and reasoning
    for i, result in enumerate(body["results"]):
        if result["decision"] != "AUTO_CLEAR":
            assert result.get("signal_breakdown") is not None, (
                f"Target {target_names[i]} missing signal_breakdown"
            )
            assert result.get("reasoning") is not None, (
                f"Target {target_names[i]} missing reasoning"
            )
            assert len(result["reasoning"]) > 0, (
                f"Target {target_names[i]} has empty reasoning"
            )
