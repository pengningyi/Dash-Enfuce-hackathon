"""Auth endpoint: login to get a session token."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.auth import create_session

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str = ""


@router.post("/login")
async def login(req: LoginRequest) -> dict:
    """Returns {"token": "...", "role": "user"|"guest"}."""
    return create_session(req.password)
