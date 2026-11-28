"""Errors raised by the pipelines package."""

from __future__ import annotations


class PipelineError(Exception):
    """Base class for pipeline errors."""


class PipelineNotFound(PipelineError):
    def __init__(self, pipeline_id: str):
        super().__init__(f"Pipeline '{pipeline_id}' not found")
        self.pipeline_id = pipeline_id


class PipelineValidationError(PipelineError):
    def __init__(self, pipeline_id: str, errors: list[str]):
        super().__init__(f"Pipeline '{pipeline_id}' is invalid: " + "; ".join(errors))
        self.pipeline_id = pipeline_id
        self.errors = errors


class TemplateError(PipelineError, ValueError):
    """A ``${...}`` reference could not be resolved."""
