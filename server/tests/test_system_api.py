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


def test_edit_parameter_saves_it_for_the_next_start(sample_workspace, tmp_path, monkeypatch):
    monkeypatch.delenv("PROOFLIX_MAX_DEPTH", raising=False)
    home = tmp_path / "home"
    with _client(sample_workspace, tmp_path, home=home) as c:
        res = c.put("/api/system/parameters/PROOFLIX_MAX_DEPTH", json={"value": " 4 "})
        assert res.status_code == 200
        depth = next(p for p in res.json() if p["name"] == "PROOFLIX_MAX_DEPTH")
        # still running with the old value until a restart
        assert (depth["value"], depth["saved"], depth["restart_needed"]) == ("10", "4", True)

        bad = c.put("/api/system/parameters/PROOFLIX_MAX_DEPTH", json={"value": "lots"})
        assert bad.status_code == 422 and "whole number" in bad.json()["detail"]
        assert c.put("/api/system/parameters/PROOFLIX_HOME", json={"value": "/x"}).status_code == 400
        assert c.put("/api/system/parameters/NOPE", json={"value": "1"}).status_code == 404

    # the next start uses the saved value, even over the environment variable
    monkeypatch.setenv("PROOFLIX_HOME", str(home))
    monkeypatch.setenv("PROOFLIX_MAX_DEPTH", "7")
    restarted = Settings.from_env()
    assert restarted.max_depth == 4
    with _client(sample_workspace, tmp_path, home=home, saved_parameters=restarted.saved_parameters) as c:
        depth = next(p for p in c.get("/api/system/parameters").json() if p["name"] == "PROOFLIX_MAX_DEPTH")
        assert (depth["source"], depth["restart_needed"]) == ("saved", False)
        # clearing it goes back to the environment variable after a restart
        c.put("/api/system/parameters/PROOFLIX_MAX_DEPTH", json={"value": ""})
    assert Settings.from_env().max_depth == 7


def test_parameters_are_read_only_without_a_home(sample_workspace, tmp_path):
    with _client(sample_workspace, tmp_path) as c:
        assert not any(p["editable"] for p in c.get("/api/system/parameters").json())
        res = c.put("/api/system/parameters/PROOFLIX_MAX_DEPTH", json={"value": "4"})
        assert res.status_code == 409
