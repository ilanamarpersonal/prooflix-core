"""Loading and validating pipeline YAML files from the workspace.

Validation happens in two passes:

1. **Local** (one file): YAML syntax, schema, unique task keys, ``depends_on``
   targets, cycles in the task DAG, and ``${...}`` references.
2. **Workspace** (all files): sub-pipelines exist and are valid, parameters
   passed to a sub-pipeline are declared by it, and there is no recursive
   pipeline call chain (``a -> b -> a``).
"""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from pydantic import ValidationError

from .errors import PipelineNotFound, PipelineValidationError
from .graph import ancestors, find_cycle, shortest_path
from .models import PIPELINE_ID_PATTERN, PipelineSpec, PipelineTask, PythonTask, ShellTask
from .templating import iter_references

YAML_SUFFIXES = (".yaml", ".yml")
_ID_RE = re.compile(PIPELINE_ID_PATTERN)


@dataclass
class PipelineDefinition:
    """One pipeline file, parsed, with any validation errors attached."""

    id: str
    source: str
    path: Path | None = None
    spec: PipelineSpec | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return self.spec is not None and not self.errors

    @property
    def name(self) -> str:
        return (self.spec.name if self.spec and self.spec.name else None) or self.id


class Workspace:
    """A directory holding ``pipelines/*.yaml`` and Python task code in ``src/``."""

    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.pipelines_dir = self.root / "pipelines"
        self.src_dir = self.root / "src"

    # ------------------------------------------------------------------ files
    def list_ids(self) -> list[str]:
        if not self.pipelines_dir.is_dir():
            return []
        ids = {
            p.stem
            for p in self.pipelines_dir.iterdir()
            if p.is_file() and p.suffix in YAML_SUFFIXES and not p.name.startswith(".")
        }
        return sorted(ids)

    def path_for(self, pipeline_id: str) -> Path | None:
        for suffix in YAML_SUFFIXES:
            path = self.pipelines_dir / f"{pipeline_id}{suffix}"
            if path.is_file():
                return path
        return None

    def exists(self, pipeline_id: str) -> bool:
        return self.path_for(pipeline_id) is not None

    def read_source(self, pipeline_id: str) -> str:
        path = self.path_for(pipeline_id)
        if path is None:
            raise PipelineNotFound(pipeline_id)
        return path.read_text(encoding="utf-8")

    # ---------------------------------------------------------------- loading
    def load_all(self, overrides: dict[str, str] | None = None) -> dict[str, PipelineDefinition]:
        """Parse every pipeline and run workspace-level validation.

        ``overrides`` maps a pipeline id to unsaved YAML that replaces (or adds)
        that file, which lets callers validate an edit in full context.
        """
        overrides = overrides or {}
        defs: dict[str, PipelineDefinition] = {}
        for pid in self.list_ids():
            if pid in overrides:
                continue
            path = self.path_for(pid)
            assert path is not None
            defs[pid] = parse_pipeline(pid, path.read_text(encoding="utf-8"), path)
        for pid, source in overrides.items():
            defs[pid] = parse_pipeline(pid, source, self.path_for(pid))
        validate_workspace(defs)
        return dict(sorted(defs.items()))

    def load(self, pipeline_id: str) -> PipelineDefinition:
        if not self.exists(pipeline_id):
            raise PipelineNotFound(pipeline_id)
        return self.load_all()[pipeline_id]

    def validate_source(self, pipeline_id: str, source: str) -> list[str]:
        return self.load_all(overrides={pipeline_id: source})[pipeline_id].errors

    # ---------------------------------------------------------------- writing
    def save(self, pipeline_id: str, source: str) -> PipelineDefinition:
        """Validate and write a pipeline file. Raises ``PipelineValidationError``."""
        errors = self.validate_source(pipeline_id, source)
        if errors:
            raise PipelineValidationError(pipeline_id, errors)
        self.pipelines_dir.mkdir(parents=True, exist_ok=True)
        path = self.path_for(pipeline_id) or self.pipelines_dir / f"{pipeline_id}.yaml"
        _atomic_write(path, source)
        return self.load(pipeline_id)

    def delete(self, pipeline_id: str) -> None:
        path = self.path_for(pipeline_id)
        if path is None:
            raise PipelineNotFound(pipeline_id)
        path.unlink()

    def callers_of(self, pipeline_id: str) -> list[str]:
        """Pipelines that call ``pipeline_id`` as a sub-pipeline."""
        return [
            pid
            for pid, d in self.load_all().items()
            if d.spec is not None and pipeline_id in d.spec.sub_pipelines
        ]


# ---------------------------------------------------------------------------
# Local (single file) validation
# ---------------------------------------------------------------------------
def parse_pipeline(pipeline_id: str, source: str, path: Path | None = None) -> PipelineDefinition:
    definition = PipelineDefinition(id=pipeline_id, source=source, path=path)
    if not _ID_RE.match(pipeline_id):
        definition.errors.append(
            f"Invalid pipeline id '{pipeline_id}': use lowercase letters, digits, '_' or '-'"
        )
        return definition
    try:
        data = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        definition.errors.append(f"YAML syntax error: {exc}")
        return definition
    if not isinstance(data, dict):
        definition.errors.append("Pipeline file must contain a YAML mapping at the top level")
        return definition
    try:
        spec = PipelineSpec.model_validate(data)
    except ValidationError as exc:
        for err in exc.errors():
            loc = ".".join(str(p) for p in err["loc"])
            definition.errors.append(f"{loc}: {err['msg']}" if loc else err["msg"])
        return definition
    definition.spec = spec
    definition.errors.extend(validate_spec(spec))
    return definition


def validate_spec(spec: PipelineSpec) -> list[str]:
    errors: list[str] = []
    keys = [t.key for t in spec.tasks]
    seen: set[str] = set()
    for key in keys:
        if key in seen:
            errors.append(f"Duplicate task key '{key}'")
        seen.add(key)

    deps: dict[str, list[str]] = {}
    for task in spec.tasks:
        deps[task.key] = list(task.depends_on)
        for dep in task.depends_on:
            if dep == task.key:
                errors.append(f"Task '{task.key}' depends on itself")
            elif dep not in seen:
                errors.append(f"Task '{task.key}' depends on unknown task '{dep}'")

    cycle = find_cycle({k: [d for d in v if d in seen and d != k] for k, v in deps.items()})
    if cycle:
        errors.append("Task dependency cycle: " + " -> ".join(reversed(cycle)))

    upstream = ancestors(deps)
    for task in spec.tasks:
        for ref in iter_references(_task_templated_fields(task)):
            errors.extend(_check_reference(ref, spec, f"Task '{task.key}'", upstream[task.key]))
    for ref in iter_references(spec.outputs):
        errors.extend(_check_reference(ref, spec, "outputs", set(seen)))
    return errors


def _task_templated_fields(task: PythonTask | ShellTask | PipelineTask) -> object:
    if isinstance(task, ShellTask):
        return [task.command, task.env]
    return task.parameters


def _check_reference(
    ref: tuple[str, ...], spec: PipelineSpec, where: str, allowed_tasks: set[str]
) -> list[str]:
    text = "${" + ".".join(ref) + "}"
    root = ref[0]
    if root == "params":
        if ref[1] not in spec.parameters:
            return [f"{where} references undeclared parameter '{ref[1]}' in {text}"]
    elif root == "tasks":
        if len(ref) < 3 or ref[2] != "output":
            return [f"{where}: task references must look like ${{tasks.<key>.output...}}, got {text}"]
        task_key = ref[1]
        if task_key not in {t.key for t in spec.tasks}:
            return [f"{where} references unknown task '{task_key}' in {text}"]
        if task_key not in allowed_tasks:
            return [
                f"{where} uses the output of '{task_key}' but does not depend on it "
                f"(add it to depends_on)"
            ]
    elif root == "run":
        if ref[1:] not in (("id",), ("pipeline",)):
            return [f"{where}: unknown run field in {text} (use run.id or run.pipeline)"]
    return []


# ---------------------------------------------------------------------------
# Workspace (cross file) validation
# ---------------------------------------------------------------------------
def validate_workspace(defs: dict[str, PipelineDefinition]) -> None:
    """Append cross-pipeline errors to each definition in place."""
    calls: dict[str, list[str]] = {
        pid: d.spec.sub_pipelines for pid, d in defs.items() if d.spec is not None
    }
    locally_valid = {pid for pid, d in defs.items() if d.valid}

    for pid, d in defs.items():
        if d.spec is None:
            continue
        for task in d.spec.tasks:
            if not isinstance(task, PipelineTask):
                continue
            child = defs.get(task.pipeline)
            where = f"Task '{task.key}'"
            if child is None:
                d.errors.append(f"{where} calls unknown pipeline '{task.pipeline}'")
                continue
            if task.pipeline not in locally_valid:
                d.errors.append(f"{where} calls pipeline '{task.pipeline}', which is invalid")
                continue
            assert child.spec is not None
            unknown = sorted(set(task.parameters) - set(child.spec.parameters))
            if unknown:
                d.errors.append(
                    f"{where} passes parameters not declared by '{task.pipeline}': "
                    + ", ".join(unknown)
                )

        for child_id in calls.get(pid, []):
            path = shortest_path(calls, child_id, pid)
            if path:
                d.errors.append("Recursive sub-pipeline call: " + " -> ".join([pid, *path]))
                break


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
