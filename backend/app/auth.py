"""Simple session-based auth: password user vs guest with rate limiting."""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
from collections import defaultdict

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

APP_PASSWORD = "Laskienka"
GUEST_RATE_LIMIT = int(os.environ.get("GUEST_RATE_LIMIT", "10"))  # per minute
GUEST_RATE_WINDOW = 60  # seconds

# In-memory session store: token -> {"role": "user"|"guest", "created": float}
_sessions: dict[str, dict] = {}

# Guest rate tracking: token -> list of timestamps
_guest_requests: dict[str, list[float]] = defaultdict(list)

# ── Heavy (batch/pipeline/benchmark) routes that guests cannot use ──
_GUEST_BLOCKED_PREFIXES = (
    "/api/batch-screen",
    "/api/pipeline/",
    "/api/benchmark",
    "/api/sanctions/switch",
    "/api/sanctions/add",
)

# ── Max request body sizes ──
MAX_BODY_GUEST = 2_000        # 2 KB — enough for a single name screen
MAX_BODY_USER = 10_000_000    # 10 MB


def create_session(password: str | None) -> dict:
    """Validate password and return a session token + role."""
    token = secrets.token_urlsafe(32)

    if password and APP_PASSWORD and password == APP_PASSWORD:
        role = "user"
    else:
        role = "guest"

    _sessions[token] = {"role": role, "created": time.time()}
    logger.info("Session created: role=%s", role)
    return {"token": token, "role": role}


def get_session(request: Request) -> dict:
    """Extract session from Authorization header. Returns {"role": ...}."""
    auth = request.headers.get("Authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token or token not in _sessions:
        raise HTTPException(status_code=401, detail="Not authenticated. POST /api/auth/login first.")
    return _sessions[token]


async def auth_guard(request: Request) -> None:
    """Middleware-style guard called before every /api route (except login/health).

    Enforces:
      - Valid session
      - Guest cannot access heavy routes
      - Guest rate limiting
      - Request body size limits
    """
    path = request.url.path

    # CORS preflight — let it through so CORSMiddleware can respond
    if request.method == "OPTIONS":
        return

    # Public endpoints — no auth required
    if path in ("/api/health", "/api/auth/login"):
        return

    # All other /api routes require auth
    if not path.startswith("/api"):
        return

    session = get_session(request)
    role = session["role"]

    # Guest restrictions
    if role == "guest":
        # Block heavy endpoints
        for prefix in _GUEST_BLOCKED_PREFIXES:
            if path.startswith(prefix):
                raise HTTPException(
                    status_code=403,
                    detail="Guest access denied for this endpoint. Please log in with the password.",
                )

        # Rate limit
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        now = time.time()
        window_start = now - GUEST_RATE_WINDOW
        hits = _guest_requests[token]
        # Prune old entries
        _guest_requests[token] = [t for t in hits if t > window_start]
        if len(_guest_requests[token]) >= GUEST_RATE_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=f"Guest rate limit exceeded ({GUEST_RATE_LIMIT} requests/minute). Try again shortly.",
            )
        _guest_requests[token].append(now)

    # Body size limit
    content_length = request.headers.get("content-length")
    if content_length:
        limit = MAX_BODY_GUEST if role == "guest" else MAX_BODY_USER
        if int(content_length) > limit:
            raise HTTPException(
                status_code=413,
                detail=f"Request body too large (max {limit} bytes for {role}).",
            )

    # Guest: block batch customers in screen requests
    if role == "guest" and path == "/api/screen":
        # Will be validated at the endpoint level — body is small enough
        pass
