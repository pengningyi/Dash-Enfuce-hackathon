"""Integration tests for BlockingService wiring into FastAPI lifespan and sanctions-add endpoint.

Verifies:
  - BlockingService is initialized during app startup (lifespan)
  - Index stats are correct after startup
  - /api/sanctions/add updates blocking indexes via add_entry()
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest_asyncio.fixture(scope="module")
async def app_and_client():
    """Create a test client with the real app — model loaded once per module.

    Yields (app, client) so tests can inspect app.state directly.
    Uses LifespanManager per K003 to trigger startup/shutdown.
    """
    app = create_app()
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield app, ac


@pytest_asyncio.fixture
async def fresh_app_and_client():
    """Fresh app instance per test — clean state for mutations."""
    app = create_app()
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
            yield app, ac


# ── Lifespan Wiring ──────────────────────────────────────────────────────────


class TestBlockingLifespan:
    """Verify BlockingService is initialized during app startup."""

    @pytest.mark.asyncio
    async def test_blocking_service_initialized(self, app_and_client):
        """app.state.blocking_service should be set after lifespan startup."""
        app, _client = app_and_client
        blocking_svc = getattr(app.state, "blocking_service", None)
        assert blocking_svc is not None, "blocking_service not set in app.state"

    @pytest.mark.asyncio
    async def test_blocking_index_stats_correct(self, app_and_client):
        """Index stats should reflect the 30-entry sanctions CSV."""
        app, _client = app_and_client
        blocking_svc = app.state.blocking_service
        stats = blocking_svc.index_stats

        # 30 sanctions entries indexed
        assert stats["sanctions_entries"] == 30
        # At least some DOB years and phonetic codes
        assert stats["dob_years"] > 0, "Expected DOB year index entries"
        assert stats["phonetic_codes"] > 0, "Expected phonetic code index entries"

    @pytest.mark.asyncio
    async def test_blocking_service_has_candidates(self, app_and_client):
        """Known target should produce candidates via blocking."""
        app, _client = app_and_client
        blocking_svc = app.state.blocking_service

        # Kasim Suleymani → EU-0009 (Qasem Soleimani), DOB 1957
        candidates = blocking_svc.get_candidates("Kasim Suleymani", "1957-03-11")
        sids = {c.sanction_id for c in candidates}
        assert "EU-0009" in sids, f"EU-0009 not in blocking candidates: {sids}"


# ── Sanctions-Add Updates Blocking ───────────────────────────────────────────


class TestSanctionsAddBlocking:
    """Verify /api/sanctions/add updates blocking indexes."""

    @pytest.mark.asyncio
    async def test_add_entry_updates_blocking_index(self, fresh_app_and_client):
        """After adding a sanctions entry, the new entry should appear in blocking candidates."""
        app, client = fresh_app_and_client
        blocking_svc = app.state.blocking_service

        initial_entries = blocking_svc.index_stats["sanctions_entries"]

        # Add a new sanctions entry with a distinctive name and DOB
        add_payload = {
            "sanction_id": "BLOCK-TEST-001",
            "full_name": "Xenophon Testopoulos",
            "date_of_birth": "1985-06-15",
            "nationality": "Testland",
            "sanctions_program": "TEST-BLOCKING",
        }
        resp = await client.post("/api/sanctions/add", json=add_payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "added"

        # Blocking index should now include the new entry
        new_entries = blocking_svc.index_stats["sanctions_entries"]
        assert new_entries == initial_entries + 1

        # Query blocking with matching DOB year + phonetic similarity
        candidates = blocking_svc.get_candidates("Xenophon Testopoulos", "1985-01-01")
        sids = {c.sanction_id for c in candidates}
        assert "BLOCK-TEST-001" in sids, f"New entry not in blocking candidates: {sids}"

    @pytest.mark.asyncio
    async def test_add_entry_with_aliases_updates_blocking(self, fresh_app_and_client):
        """Adding an entry with aliases should index all names in blocking."""
        app, client = fresh_app_and_client
        blocking_svc = app.state.blocking_service

        add_payload = {
            "sanction_id": "BLOCK-TEST-002",
            "full_name": "Bartholomew Testington",
            "alias_1": "Bart Testington",
            "alias_2": "Barty Test",
            "date_of_birth": "1970-03-20",
            "sanctions_program": "TEST-BLOCKING",
        }
        resp = await client.post("/api/sanctions/add", json=add_payload)
        assert resp.status_code == 200

        # Query by alias name — should find the entry via phonetic codes
        candidates = blocking_svc.get_candidates("Bart Testington", "1970-01-01")
        sids = {c.sanction_id for c in candidates}
        assert "BLOCK-TEST-002" in sids, f"Alias not found in blocking: {sids}"

    @pytest.mark.asyncio
    async def test_add_entry_without_dob_still_indexes_phonetic(self, fresh_app_and_client):
        """Entry without DOB should still be findable via phonetic-only blocking."""
        app, client = fresh_app_and_client
        blocking_svc = app.state.blocking_service

        add_payload = {
            "sanction_id": "BLOCK-TEST-003",
            "full_name": "Zygmunt Wozniacki",
            "sanctions_program": "TEST-BLOCKING",
        }
        resp = await client.post("/api/sanctions/add", json=add_payload)
        assert resp.status_code == 200

        # Query without DOB — should use phonetic_no_dob fallback
        candidates = blocking_svc.get_candidates("Zygmunt Wozniacki")
        sids = {c.sanction_id for c in candidates}
        assert "BLOCK-TEST-003" in sids, f"No-DOB entry not in blocking: {sids}"
