"""Tests for LLMService — OpenRouter-based reasoning for Layer 3 sanctions screening.

All tests mock the OpenAI AsyncOpenAI client so no real API calls are made.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.schemas import SanctionsMatch
from app.services.llm_service import LLMService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_match(**overrides) -> SanctionsMatch:
    """Build a SanctionsMatch with sensible defaults."""
    defaults = {
        "sanctions_id": "SAN-001",
        "full_name": "Kasim Suleymani",
        "matched_name": "Kasim Suleymani",
        "match_type": "full_name",
        "similarity_score": 0.92,
        "date_of_birth": "1957-03-11",
        "nationality": "Iran",
        "sanctions_program": "OFAC SDN",
        "reason_for_listing": "Terrorism financing",
    }
    defaults.update(overrides)
    return SanctionsMatch(**defaults)


def _mock_openai_response(text: str) -> MagicMock:
    """Create a mock OpenAI ChatCompletion response."""
    choice = SimpleNamespace(message=SimpleNamespace(content=text))
    return SimpleNamespace(choices=[choice])


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def llm_service():
    """LLMService with a mocked OpenAI client."""
    with patch("app.services.llm_service.AsyncOpenAI") as mock_cls:
        service = LLMService(api_keys=["test-key-1"])
        # Replace the client with a mock
        mock_client = MagicMock()
        mock_client.chat = MagicMock()
        mock_client.chat.completions = MagicMock()
        mock_client.chat.completions.create = AsyncMock()
        service._client = mock_client
        yield service


@pytest.fixture
def sample_matches() -> list[SanctionsMatch]:
    return [_make_match(), _make_match(sanctions_id="SAN-002", full_name="Qasem Soleimani", similarity_score=0.87)]


# ---------------------------------------------------------------------------
# Tests — happy paths
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_escalate_response(llm_service, sample_matches):
    """Valid ESCALATE JSON is parsed correctly."""
    response_json = json.dumps({
        "decision": "ESCALATE",
        "confidence": 85,
        "reasoning": "Name is a close transliteration match. DOB matches. Cannot rule out.",
    })
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(response_json)

    result = await llm_service.analyze("Kasim Suleymani", "1957-03-11", "Iran", sample_matches)

    assert result["decision"] == "ESCALATE"
    assert result["confidence"] == 85
    assert "transliteration" in result["reasoning"]
    assert "processing_time_ms" in result
    assert result["processing_time_ms"] >= 0


@pytest.mark.asyncio
async def test_auto_clear_response(llm_service, sample_matches):
    """Valid AUTO_CLEAR JSON is parsed correctly."""
    response_json = json.dumps({
        "decision": "AUTO_CLEAR",
        "confidence": 90,
        "reasoning": "Despite similar name, DOB is completely different.",
    })
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(response_json)

    result = await llm_service.analyze("John Smith", None, None, sample_matches)

    assert result["decision"] == "AUTO_CLEAR"
    assert result["confidence"] == 90


@pytest.mark.asyncio
async def test_malformed_json_fallback(llm_service, sample_matches):
    """Unparseable response falls back to ESCALATE with raw text as reasoning."""
    llm_service._client.chat.completions.create.return_value = _mock_openai_response("This is not JSON at all")

    result = await llm_service.analyze("Test", None, None, sample_matches)

    assert result["decision"] == "ESCALATE"
    assert result["confidence"] == 0
    assert "This is not JSON at all" in result["reasoning"]


@pytest.mark.asyncio
async def test_markdown_fenced_json(llm_service, sample_matches):
    """JSON wrapped in markdown code fences is parsed correctly."""
    response_json = json.dumps({
        "decision": "ESCALATE",
        "confidence": 75,
        "reasoning": "Possible transliteration.",
    })
    fenced = f"```json\n{response_json}\n```"
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(fenced)

    result = await llm_service.analyze("Test", None, None, sample_matches)

    assert result["decision"] == "ESCALATE"
    assert result["confidence"] == 75


@pytest.mark.asyncio
async def test_missing_reasoning_field(llm_service, sample_matches):
    """Missing reasoning field defaults to empty string."""
    response_json = json.dumps({"decision": "AUTO_CLEAR", "confidence": 60})
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(response_json)

    result = await llm_service.analyze("Test", None, None, sample_matches)

    assert result["decision"] == "AUTO_CLEAR"
    assert result["reasoning"] == ""


@pytest.mark.asyncio
async def test_empty_response_content(llm_service, sample_matches):
    """Empty response content falls back to ESCALATE."""
    llm_service._client.chat.completions.create.return_value = _mock_openai_response("")

    result = await llm_service.analyze("Test", None, None, sample_matches)

    assert result["decision"] == "ESCALATE"
    assert result["confidence"] == 0


@pytest.mark.asyncio
async def test_api_connection_error(llm_service, sample_matches):
    """Network errors propagate."""
    llm_service._client.chat.completions.create.side_effect = ConnectionError("Network error")

    with pytest.raises(ConnectionError):
        await llm_service.analyze("Test", None, None, sample_matches)


@pytest.mark.asyncio
async def test_processing_time_measured(llm_service, sample_matches):
    """processing_time_ms is always present and non-negative."""
    response_json = json.dumps({"decision": "AUTO_CLEAR", "confidence": 50, "reasoning": "ok"})
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(response_json)

    result = await llm_service.analyze("Test", None, None, sample_matches)

    assert "processing_time_ms" in result
    assert result["processing_time_ms"] >= 0


@pytest.mark.asyncio
async def test_prompt_construction(llm_service, sample_matches):
    """Prompt includes customer data and match details."""
    response_json = json.dumps({"decision": "ESCALATE", "confidence": 80, "reasoning": "match"})
    llm_service._client.chat.completions.create.return_value = _mock_openai_response(response_json)

    await llm_service.analyze("Kasim Suleymani", "1957-03-11", "Iran", sample_matches)

    call_args = llm_service._client.chat.completions.create.call_args
    messages = call_args.kwargs.get("messages", [])
    user_msg = next((m["content"] for m in messages if m["role"] == "user"), "")
    assert "Kasim Suleymani" in user_msg
    assert "1957-03-11" in user_msg
    assert "Iran" in user_msg


@pytest.mark.asyncio
async def test_key_rotation_on_rate_limit(sample_matches):
    """Rate limit on first key triggers rotation to second key."""
    with patch("app.services.llm_service.AsyncOpenAI") as mock_cls:
        service = LLMService(api_keys=["key-1", "key-2"])

        # First client raises rate limit
        mock_client_1 = MagicMock()
        mock_client_1.chat.completions.create = AsyncMock(
            side_effect=Exception("Error code: 429 rate limit exceeded")
        )
        service._client = mock_client_1

        # After rotation, second client succeeds
        response_json = json.dumps({"decision": "AUTO_CLEAR", "confidence": 70, "reasoning": "ok"})
        mock_client_2 = MagicMock()
        mock_client_2.chat.completions.create = AsyncMock(
            return_value=_mock_openai_response(response_json)
        )

        original_make = service._make_client
        service._make_client = staticmethod(lambda key: mock_client_2)

        result = await service.analyze("Test", None, None, sample_matches)
        assert result["decision"] == "AUTO_CLEAR"
