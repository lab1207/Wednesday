from pydantic import BaseModel, Field
from typing import Literal


class EngineeringTask(BaseModel):
    task_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = Field(min_length=1)
    project_path: str = Field(min_length=1)
    constraints: list[str] = Field(default_factory=list)
    priority: Literal["low", "normal", "high", "critical"] = "normal"


class Artifact(BaseModel):
    type: str
    path: str


class EngineeringResult(BaseModel):
    task_id: str = Field(min_length=1)
    status: Literal["pending", "working", "completed", "failed"]
    plan: str
    implementation_notes: str
    review_notes: str
    test_plan: str
    artifacts: list[Artifact] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
