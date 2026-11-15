"""LLM service: Grok-powered compliance reasoning for Layer 3 sanctions screening.

Uses xAI REST API via httpx async for maximum concurrency.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx
from unidecode import unidecode

from app.models.schemas import SanctionsMatch

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are a Senior Financial Compliance Officer. Assess if Customer could be the SAME PERSON as a sanctioned individual.

RESPOND WITH VALID JSON ONLY:
{"decision":"AUTO_CLEAR"|"ESCALATE","confidence":50-99,"matched_entity":"name or null","evidence":{"name_match":"exact"|"transliteration"|"phonetic"|"partial_surname"|"partial_first_only"|"none","dob_match":"exact"|"close"|"different"|"missing","country_match":"same"|"different"|"explainable"|"missing"},"reasoning":"1-2 sentences."}

NAME RULES:
- Match requires BOTH first AND surname similar. Shared first name only = NOT a match.
- Common first names (Aleksandr, Dmitry, Ivan, Maria, etc.) shared by millions — never sufficient alone.
- partial_first_only (only first name matches, different surnames) → AUTO_CLEAR unless exact DOB date + country match.
- Name tokens in different positions (surname vs first) = NOT a match.

DECISION:
- Full name match + exact DOB → ESCALATE (90+)
- Full name match + missing DOB → ESCALATE (70+)
- partial_first_only → AUTO_CLEAR
- partial_surname + different DOB → AUTO_CLEAR
- Different countries alone do NOT justify AUTO_CLEAR if full name + DOB match\
"""

# Regex to strip markdown code fences (```json ... ``` or ``` ... ```)
_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?\s*```$", re.DOTALL)

GROK_MODEL = "grok-4-1-fast-reasoning"


XAI_API_URL = "https://api.x.ai/v1/chat/completions"


def _name_with_latin(name: str) -> str:
    """Return name with Latin transliteration appended if non-Latin characters are present.

    E.g. "Олена Kravchenko" → "Олена Kravchenko [Latin: Olena Kravchenko]"
    Pure Latin names are returned unchanged.
    """
    if not name:
        return name
    if all(ord(c) < 0x0080 or c.isspace() for c in name):
        return name  # Already pure ASCII/Latin
    latin = unidecode(name)
    if latin != name:
        return f"{name} [Latin: {latin}]"
    return name


class LLMService:
    """Provides structured compliance reasoning via Grok (xAI).

    Uses httpx async client for native async concurrency (no thread executor).
    """

    def __init__(self, api_key: str, model: str = GROK_MODEL) -> None:
        self._api_key = api_key
        self.model = model
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_connections=30, max_keepalive_connections=20),
        )
        logger.info("LLM service: Grok xAI httpx async (model=%s)", self.model)

    @property
    def mode(self) -> str:
        return "grok"

    async def analyze(
        self,
        customer_name: str,
        customer_dob: str | None,
        customer_country: str | None,
        matches: list[SanctionsMatch],
    ) -> dict:
        """Send match context to Grok and return structured decision."""
        user_prompt = self._build_prompt(customer_name, customer_dob, customer_country, matches)
        return await self._call_grok(user_prompt)

    async def _call_grok(self, user_prompt: str) -> dict:
        """Call Grok API via httpx async REST."""
        t0 = time.perf_counter()
        resp = await self._client.post(
            XAI_API_URL,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        raw_text = data["choices"][0]["message"]["content"]
        elapsed_ms = (time.perf_counter() - t0) * 1000

        result = self._parse_response(raw_text)
        result["processing_time_ms"] = round(elapsed_ms, 1)
        return result

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_prompt(
        name: str,
        dob: str | None,
        country: str | None,
        matches: list[SanctionsMatch],
    ) -> str:
        lines = [
            f"Customer: {_name_with_latin(name)} | DOB: {dob or 'N/A'} | Country: {country or 'N/A'}",
            "",
            "Matches:",
        ]
        for i, m in enumerate(matches[:3], 1):
            reason = m.reason_for_listing or "N/A"
            # Truncate reason to save tokens
            if len(reason) > 60:
                reason = reason[:57] + "..."
            lines.append(f"{i}. {_name_with_latin(m.full_name)} | {m.similarity_score:.0%} | DOB:{m.date_of_birth or '?'} | Country:{m.nationality or '?'} | {reason}")
        return "\n".join(lines)

    @staticmethod
    def _parse_response(raw: str) -> dict:
        """Parse LLM's JSON output, stripping markdown fences if present."""
        text = raw.strip()

        fence_match = _FENCE_RE.match(text)
        if fence_match:
            text = fence_match.group(1).strip()

        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            logger.warning("LLM returned unparseable response: %s", text[:200])
            return {"decision": "ESCALATE", "confidence": 0, "reasoning": raw}

        return {
            "decision": parsed.get("decision", "ESCALATE"),
            "confidence": parsed.get("confidence", 0),
            "reasoning": parsed.get("reasoning", ""),
            "evidence": parsed.get("evidence", {}),
            "matched_entity": parsed.get("matched_entity"),
        }
