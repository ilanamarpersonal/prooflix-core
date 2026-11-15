from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app


def _client(workspace, tmp_path, **kw):
    settings = Settings(workspace=workspace, client_dist=tmp_path / "no-client", scheduler=False, **kw)
    return TestClient(create_app(settings))


def test_parameters_list_every_setting_with_value_and_source(sample_workspace, tmp_path, monkeypatch):
    for name in ("PROOFLIX_MAX_DEPTH", "PROOFLIX_DATA_LAKE", "PROOFLIX_SCHEDULER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PROOFLIX_MAX_DEPTH", "4")
    with _client(sample_workspace, tmp_path, max_depth=4) as c:
        params = {p["name"]: p for p in c.get("/api/system/parameters").json()}
    assert set(params) >= {"PROOFLIX_WORKSPACES", "PROOFLIX_MAX_DEPTH", "PROOFLIX_DATA_LAKE", "PROOFLIX_CORS"}
    depth = params["PROOFLIX_MAX_DEPTH"]
    assert (depth["value"], depth["default"], depth["source"]) == ("4", "10", "environment")
    lake = params["PROOFLIX_DATA_LAKE"]
    assert lake["value"] is None and lake["source"] == "default"
    assert params["PROOFLIX_SCHEDULER"]["value"] == "off"
    assert all(p["description"] for p in params.values())
