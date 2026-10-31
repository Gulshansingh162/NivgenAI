
from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class CitizenRegister(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class WorkerCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    phone: str | None = Field(default=None, max_length=30)
    specialization: str = Field(default="General", min_length=1, max_length=80)


class EmergencyAlertCreate(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    category: Literal[
        "Flooding",
        "Road Closure",
        "Severe Weather",
        "Fire",
        "Other",
    ]
    affected_location: str = Field(min_length=2, max_length=255)
    instructions: str = Field(min_length=5, max_length=2000)
    verified: bool


class EmergencyUnitCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    unit_type: Literal["Ambulance", "Rescue Team", "Municipal Crew"]
    code: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z0-9-]+$")


class APIKeyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    owner_user_id: int = Field(gt=0)
    access_level: Literal["read_only", "read_write"]
    expires_in_days: int | None = Field(default=90, ge=1, le=365)


class UserResponse(BaseModel):
    id: int
    full_name: str
    email: EmailStr
    role: str
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class AdminUserResponse(UserResponse):
    phone: str | None = None
    specialization: str = "General"
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
