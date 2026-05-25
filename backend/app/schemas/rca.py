from datetime import datetime

from pydantic import BaseModel, Field

from app.models.rca import RCASeverity, RCAStatus
from app.schemas.user import UserOut


class RCACreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    body: str = ""
    # Structured form payload mirroring `body`. Free-form dict (the frontend
    # owns the shape); stored verbatim and used to re-hydrate the editor.
    content: dict | None = None
    assignee_emails: list[str] = Field(default_factory=list)
    severity: RCASeverity | None = None
    environment: str | None = None
    services_affected: list[str] = Field(default_factory=list)
    incident_started_at: datetime | None = None
    incident_detected_at: datetime | None = None
    incident_mitigated_at: datetime | None = None
    incident_resolved_at: datetime | None = None


class RCAPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    body: str | None = None
    content: dict | None = None
    assignee_emails: list[str] | None = None
    status: RCAStatus | None = None
    severity: RCASeverity | None = None
    environment: str | None = None
    services_affected: list[str] | None = None
    incident_started_at: datetime | None = None
    incident_detected_at: datetime | None = None
    incident_mitigated_at: datetime | None = None
    incident_resolved_at: datetime | None = None


class StatusChange(BaseModel):
    status: RCAStatus


class RCAOut(BaseModel):
    id: int
    title: str
    body: str
    content: dict | None
    status: RCAStatus
    severity: RCASeverity | None
    environment: str | None
    services_affected: list[str]
    incident_started_at: datetime | None
    incident_detected_at: datetime | None
    incident_mitigated_at: datetime | None
    incident_resolved_at: datetime | None
    creator_email: str
    creator_name: str
    assignees: list[UserOut]
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None
    ai_summary: str | None
    ai_summary_at: datetime | None
    ai_summary_model: str | None
    can_edit: bool
    can_delete: bool


class RCAListOut(BaseModel):
    items: list[RCAOut]
    total: int


class HistoryEntryOut(BaseModel):
    id: int
    actor_email: str
    action: str
    from_value: str | None
    to_value: str | None
    at: datetime

    model_config = {"from_attributes": True}
