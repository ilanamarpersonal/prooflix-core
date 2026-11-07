"""Request and response bodies of the REST API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..pipelines.models import PipelineTask
from ..pipelines.workspace import PipelineDefinition


class GraphNode(BaseModel):
    key: str
    type: str
    description: str | None = None
    pipeline: str | None = None


class GraphEdge(BaseModel):
    source: str
    target: str


class PipelineGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class PipelineSummary(BaseModel):
    id: str
    name: str
    description: str | None = None
    valid: bool
    errors: list[str]
    task_count: int
    sub_pipelines: list[str]
    parameters: dict[str, Any]


class PipelineDetail(PipelineSummary):
    source: str
    spec: dict[str, Any] | None
    graph: PipelineGraph
    used_by: list[str]


class PipelineSourceIn(BaseModel):
    source: str = Field(description="Pipeline YAML")


class ValidationResult(BaseModel):
    valid: bool
    errors: list[str]


class RunRequest(BaseModel):
    parameters: dict[str, Any] = Field(default_factory=dict)


def summary_of(d: PipelineDefinition) -> PipelineSummary:
    spec = d.spec
    return PipelineSummary(
        id=d.id,
        name=d.name,
        description=spec.description if spec else None,
        valid=d.valid,
        errors=d.errors,
        task_count=len(spec.tasks) if spec else 0,
        sub_pipelines=spec.sub_pipelines if spec else [],
        parameters=spec.parameters if spec else {},
    )


def detail_of(d: PipelineDefinition, used_by: list[str]) -> PipelineDetail:
    spec = d.spec
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    if spec:
        keys = {t.key for t in spec.tasks}
        for t in spec.tasks:
            nodes.append(
                GraphNode(
                    key=t.key,
                    type=t.type,
                    description=t.description,
                    pipeline=t.pipeline if isinstance(t, PipelineTask) else None,
                )
            )
            edges.extend(GraphEdge(source=dep, target=t.key) for dep in t.depends_on if dep in keys)
    return PipelineDetail(
        **summary_of(d).model_dump(),
        source=d.source,
        spec=spec.model_dump(mode="json", exclude_none=True) if spec else None,
        graph=PipelineGraph(nodes=nodes, edges=edges),
        used_by=used_by,
    )
