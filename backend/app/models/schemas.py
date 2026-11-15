"""Pydantic models for sanctions screening request/response."""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Decision(str, Enum):
    """Screening decision outcomes."""

    AUTO_CLEAR = "AUTO_CLEAR"
    ESCALATE = "ESCALATE"
    NEEDS_REVIEW = "NEEDS_REVIEW"


class SignalScore(BaseModel):
    """Individual signal score from the multi-signal screening pipeline."""

    signal_name: str
    score: float = Field(ge=0.0, le=1.0)
    detail: str
    missing: bool = False


class SignalBreakdown(BaseModel):
    """Per-signal scoring breakdown for a screening candidate."""

    dob: SignalScore
    name_jw: SignalScore
    phonetic: SignalScore
    embedding: SignalScore
    country: SignalScore


class ScreenRequest(BaseModel):
    """Incoming screening request."""

    name: str = Field(..., max_length=200, min_length=1)
    threshold: float = Field(default=0.60, ge=0.0, le=1.0)
    date_of_birth: Optional[str] = None
    country: Optional[str] = None


class SanctionsMatch(BaseModel):
    """A single match from the sanctions list."""

    sanctions_id: str
    full_name: str
    matched_name: str
    match_type: str  # "full_name", "alias_1", "alias_2"
    similarity_score: float
    date_of_birth: Optional[str] = None
    nationality: Optional[str] = None
    sanctions_program: Optional[str] = None
    reason_for_listing: Optional[str] = None


class ScreenResult(BaseModel):
    """Complete screening result for a query."""

    query_name: str
    matches: list[SanctionsMatch]
    decision: Decision
    layer_reached: int
    threshold_used: float
    llm_reasoning: Optional[str] = None
    llm_confidence: Optional[int] = None
    llm_evidence: Optional[dict] = None
    llm_matched_entity: Optional[str] = None
    processing_time_ms: Optional[float] = None
    signal_breakdown: Optional[SignalBreakdown] = None
    reasoning: Optional[str] = None


class SanctionsEntry(BaseModel):
    """A sanctions list entry matching CSV columns."""

    sanction_id: str = Field(alias="Sanction_ID")
    full_name: str = Field(alias="Full_Name")
    alias_1: Optional[str] = Field(default=None, alias="Alias_1")
    alias_2: Optional[str] = Field(default=None, alias="Alias_2")
    date_of_birth: Optional[str] = Field(default=None, alias="Date_of_Birth")
    nationality: Optional[str] = Field(default=None, alias="Nationality")
    passport_number: Optional[str] = Field(default=None, alias="Passport_Number")
    sanctions_program: Optional[str] = Field(default=None, alias="Sanctions_Program")
    reason_for_listing: Optional[str] = Field(default=None, alias="Reason_for_Listing")

    model_config = {"populate_by_name": True, "serialize_by_alias": False}


class BatchCustomerInput(BaseModel):
    """A single customer in a batch screening request."""

    name: str = Field(..., min_length=1, max_length=200)
    date_of_birth: Optional[str] = None
    country: Optional[str] = None


class BatchScreenRequest(BaseModel):
    """Batch screening request — list of customers to screen."""

    customers: list[BatchCustomerInput] = Field(default_factory=list)


class BatchCustomerResult(BaseModel):
    """Lightweight result for one customer in a batch screen."""

    query_name: str
    query_dob: Optional[str] = None
    query_country: Optional[str] = None
    decision: Decision
    top_match_score: Optional[float] = None
    top_match_name: Optional[str] = None
    top_match_dob: Optional[str] = None
    top_match_country: Optional[str] = None
    top_match_program: Optional[str] = None
    top_match_reason: Optional[str] = None
    sanctions_id: Optional[str] = None
    llm_reasoning: Optional[str] = None
    llm_confidence: Optional[int] = None
    llm_evidence: Optional[dict] = None
    llm_matched_entity: Optional[str] = None
    processing_time_ms: Optional[float] = None
    layer_reached: int
    signal_breakdown: Optional[dict] = None
    reasoning: Optional[str] = None


class BatchScreenResponse(BaseModel):
    """Response for a batch screening request."""

    results: list[BatchCustomerResult]
    summary: dict


class SanctionsAddRequest(BaseModel):
    """Request to add a new sanctions entry."""

    sanction_id: str
    full_name: str
    alias_1: Optional[str] = None
    alias_2: Optional[str] = None
    date_of_birth: Optional[str] = None
    nationality: Optional[str] = None
    passport_number: Optional[str] = None
    sanctions_program: Optional[str] = None
    reason_for_listing: Optional[str] = None


class StatsResponse(BaseModel):
    """Service health/stats response."""

    sanctions_count: int
    index_size: int
    model_loaded: bool
    threshold: float
    total_screenings: int = 0
    decision_distribution: dict = Field(default_factory=dict)
    avg_processing_time_ms: float = 0.0
