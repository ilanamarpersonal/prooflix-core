"""Typed pipeline parameters: declarations, validation of run values, and the run API."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.engine import PipelineExecutor
from prooflix.main import create_app
from prooflix.pipelines import PipelineValidationError
from prooflix.pipelines.parameters import ParameterSpec, bind
from prooflix.pipelines.workspace import parse_pipeline
from prooflix.runs import RunStatus, RunStore

TENANT_PIPELINE = """
    parameters:
      tenant_id:
        type: identifier
        default: tenant1
        required: true
        description: Tenant ID
      limit: {type: integer, default: 10}
      full: {type: boolean, default: false}
      day: {type: date}
      mode: {type: string, choices: [fast, slow], default: fast}
      code: {type: string, pattern: "[A-Z]{3}"}
      legacy: [a, b]
    tasks:
      - {key: e, type: python, entrypoint: "testtasks:echo",
         parameters: {tenant: "${params.tenant_id}", limit: "${params.limit}", full: "${params.full}"}}
    outputs:
      tenant: ${tasks.e.output.tenant}
"""


def make_executor(ws):
    return PipelineExecutor(ws, RunStore(ws.root / ".prooflix" / "runs"))


# ------------------------------------------------------------- declarations
def test_short_and_long_forms_are_declarations():
    d = parse_pipeline("p", "parameters: {a: 1, b: {type: integer, default: '5'}}\ntasks: [{key: t, type: shell, command: 'true'}]\n")
    assert d.errors == []
    assert d.spec.parameters["a"] == ParameterSpec(type="any", default=1)
    assert d.spec.parameters["b"].default == 5  # converted to the declared type
    assert d.spec.defaults == {"a": 1, "b": 5}


@pytest.mark.parametrize(
    "decl, message",
    [
        ("{type: identifier, default: Tenant1}", "short lowercase identifier"),
        ("{type: integer, default: 1.5}", "whole number"),
        ("{type: date, default: '2026-13-01'}", "YYYY-MM-DD"),
        ("{type: integer, pattern: '\\d+'}", "pattern only applies"),
        ("{type: string, pattern: '('}", "not a valid regular expression"),
        ("{type: string, choices: [a, b], default: c}", "is not one of"),
        ("{type: colour}", "parameters.x"),
    ],
)
def test_invalid_declarations(decl, message):
    d = parse_pipeline("p", f"parameters:\n  x: {decl}\ntasks: [{{key: t, type: shell, command: 'true'}}]\n")
    assert d.spec is None
    assert any(message in e for e in d.errors), d.errors


def test_scheduled_pipeline_needs_defaults_for_required_parameters():
    src = "parameters: {t: {type: identifier, required: true}}\ntasks: [{key: a, type: shell, command: 'true'}]\n"
    assert parse_pipeline("p", src).valid
    d = parse_pipeline("p", src + "schedule: {cron: '0 1 * * *'}\n")
    assert any("required parameters without a default: t" in e for e in d.errors)
    assert parse_pipeline("p", src + "schedule: {cron: '0 1 * * *', enabled: false}\n").valid


def test_sub_pipeline_calls_are_checked_against_declarations(ws_factory):
    ws_factory.add("child", "parameters: {t: {type: identifier, required: true}}\ntasks: [{key: a, type: shell, command: 'true'}]\n")
    ws_factory.add("missing", "tasks: [{key: c, type: pipeline, pipeline: child}]\n")
    ws_factory.add("literal", "tasks: [{key: c, type: pipeline, pipeline: child, parameters: {t: 'Bad-Id'}}]\n")
    ws_factory.add("ok", "tasks: [{key: c, type: pipeline, pipeline: child, parameters: {t: tenant2}}]\n")
    defs = ws_factory.workspace.load_all()
    assert any("must pass 't'" in e for e in defs["missing"].errors)
    assert any("short lowercase identifier" in e for e in defs["literal"].errors)
    assert defs["ok"].valid, defs["ok"].errors


# ---------------------------------------------------------------- run values
def test_bind_converts_form_text_and_falls_back_to_defaults():
    declared = parse_pipeline("p", TENANT_PIPELINE).spec.parameters
    values, errors = bind(declared, {"tenant_id": "tenant2", "limit": "25", "full": "true", "day": "2026-11-21", "code": ""})
    assert errors == []
    assert values == {
        "tenant_id": "tenant2", "limit": 25, "full": True, "day": "2026-11-21",
        "mode": "fast", "code": None, "legacy": ["a", "b"],
    }
    assert bind(declared, {"tenant_id": ""})[0]["tenant_id"] == "tenant1"  # empty: the default


@pytest.mark.parametrize(
    "tenant",
    ["Tenant1", "1tenant", "tenant-1", "tenant1; DROP TABLE x", "../etc", "tenant1.gold", "t" * 33, " tenant1", 7, None],
)
def test_tenant_ids_are_checked_strictly(tenant):
    declared = {"tenant_id": ParameterSpec(type="identifier", required=True)}
    _, errors = bind(declared, {"tenant_id": tenant})
    assert errors and errors[0].startswith("Parameter 'tenant_id':")


def test_bind_reports_every_problem():
    declared = parse_pipeline("p", TENANT_PIPELINE).spec.parameters
    _, errors = bind(declared, {"tenant_id": "X", "limit": "ten", "full": "maybe", "mode": "medium", "code": "ab", "zz": 1})
    assert errors[0] == "Unknown parameters: zz"
    assert [e.split(":")[0] for e in errors[1:]] == [
        "Parameter 'tenant_id'", "Parameter 'limit'", "Parameter 'full'", "Parameter 'mode'", "Parameter 'code'",
    ]


def test_executor_checks_values_and_records_them(ws_factory):
    ws_factory.add("p", TENANT_PIPELINE)
    executor = make_executor(ws_factory.workspace)
    with pytest.raises(PipelineValidationError, match="short lowercase identifier"):
        executor.prepare("p", {"tenant_id": "../../etc"})
    run = asyncio.run(executor.run("p", {"tenant_id": "acme", "limit": "3"}))
    assert run.status == RunStatus.SUCCEEDED, run.error
    assert run.parameters["tenant_id"] == "acme" and run.parameters["limit"] == 3
    assert run.outputs == {"tenant": "acme"}


def test_sub_pipeline_values_are_checked_at_run_time(ws_factory):
    ws_factory.add("child", "parameters: {t: {type: identifier, required: true}}\ntasks: [{key: a, type: shell, command: 'true'}]\n")
    ws_factory.add("parent", "parameters: {raw: x}\ntasks: [{key: c, type: pipeline, pipeline: child, parameters: {t: '${params.raw}'}}]\n")
    run = asyncio.run(make_executor(ws_factory.workspace).run("parent", {"raw": "Not Valid"}))
    assert run.status == RunStatus.FAILED
    assert "short lowercase identifier" in run.tasks["c"].error


# ------------------------------------------------------------------------ API
@pytest.fixture
def api(ws_factory, tmp_path):
    ws_factory.add("e2e", TENANT_PIPELINE)
    settings = Settings(workspace=ws_factory.root, client_dist=tmp_path / "no-client")
    with TestClient(create_app(settings)) as c:
        yield c


def test_api_lists_parameter_declarations(api):
    p = api.get("/api/pipelines/e2e").json()
    assert p["parameters"]["tenant_id"] == "tenant1"  # defaults, as before
    spec = p["parameter_specs"]["tenant_id"]
    assert spec["type"] == "identifier" and spec["required"] is True and spec["description"] == "Tenant ID"
    assert p["parameter_specs"]["legacy"]["type"] == "any"
    assert list(p["parameter_specs"]) == ["tenant_id", "limit", "full", "day", "mode", "code", "legacy"]


def test_api_run_with_parameters(api):
    resp = api.post("/api/pipelines/e2e/runs", json={"parameters": {"tenant_id": "tenant42", "limit": "7"}})
    assert resp.status_code == 202
    run = resp.json()
    assert run["parameters"]["tenant_id"] == "tenant42" and run["parameters"]["limit"] == 7
    assert api.get(f"/api/runs/{run['id']}").json()["parameters"]["tenant_id"] == "tenant42"


def test_api_rejects_invalid_values_with_readable_errors(api):
    resp = api.post("/api/pipelines/e2e/runs", json={"parameters": {"tenant_id": "x'; drop", "limit": "many"}})
    assert resp.status_code == 422
    errors = resp.json()["detail"]["errors"]
    assert len(errors) == 2 and "tenant_id" in errors[0] and "limit" in errors[1]
    assert api.get("/api/runs").json() == []  # nothing was started
