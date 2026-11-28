import time

import pytest
from fastapi.testclient import TestClient

from prooflix.config import Settings
from prooflix.main import create_app


@pytest.fixture
def client(sample_workspace, tmp_path):
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client")
    with TestClient(create_app(settings)) as c:
        yield c


def wait_for(client, run_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = client.get(f"/api/runs/{run_id}").json()
        if run["status"] in ("SUCCEEDED", "FAILED", "CANCELLED"):
            return run
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not finish")


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_list_and_detail(client):
    pipelines = {p["id"]: p for p in client.get("/api/pipelines").json()}
    assert pipelines["daily_orders"]["sub_pipelines"] == ["ingest_orders", "transform_orders"]
    assert all(p["valid"] for p in pipelines.values())

    detail = client.get("/api/pipelines/ingest_orders").json()
    assert detail["used_by"] == ["daily_orders"]
    assert {"source": "extract", "target": "validate"} in detail["graph"]["edges"]
    assert "entrypoint: jobs.orders:extract" in detail["source"]
    assert client.get("/api/pipelines/nope").status_code == 404


def test_validate_save_delete(client):
    bad = client.post("/api/pipelines/new_one/validate", json={"source": "tasks: []"}).json()
    assert bad["valid"] is False

    src = "tasks:\n  - {key: hi, type: pipeline, pipeline: hello_world}\n"
    assert client.post("/api/pipelines/new_one/validate", json={"source": src}).json()["valid"]

    resp = client.put("/api/pipelines/new_one", json={"source": src})
    assert resp.status_code == 201
    assert resp.json()["sub_pipelines"] == ["hello_world"]
    assert client.put("/api/pipelines/new_one", json={"source": src}).status_code == 200
    resp = client.put("/api/pipelines/new_one", params={"create_only": True}, json={"source": src})
    assert resp.status_code == 409

    resp = client.put("/api/pipelines/new_one", json={"source": "tasks: ["})
    assert resp.status_code == 422 and resp.json()["detail"]["errors"]

    # hello_world is now used by new_one, so it cannot be deleted
    assert client.delete("/api/pipelines/hello_world").status_code == 409
    assert client.delete("/api/pipelines/new_one").status_code == 204
    assert client.get("/api/pipelines/new_one").status_code == 404


def test_run_with_sub_pipelines_and_tree(client):
    resp = client.post("/api/pipelines/daily_orders/runs", json={"parameters": {"run_date": "2026-11-07"}})
    assert resp.status_code == 202
    run = wait_for(client, resp.json()["id"])
    assert run["status"] == "SUCCEEDED"
    assert run["outputs"]["total_revenue"] == 898.49

    tree = client.get(f"/api/runs/{run['id']}/tree").json()
    assert [c["parent_task_key"] for c in tree["children"]] == ["ingest", "transform"]
    assert tree["children"][0]["children"] == []

    roots = client.get("/api/runs").json()
    assert [r["id"] for r in roots] == [run["id"]]
    all_runs = client.get("/api/runs", params={"root_only": False}).json()
    assert len(all_runs) == 3


def test_run_errors(client):
    assert client.post("/api/pipelines/nope/runs").status_code == 404
    resp = client.post("/api/pipelines/hello_world/runs", json={"parameters": {"bad": 1}})
    assert resp.status_code == 422


def test_cancel(client, sample_workspace):
    (sample_workspace / "pipelines" / "slow.yaml").write_text(
        "tasks: [{key: wait, type: shell, command: 'sleep 30'}]\n"
    )
    run_id = client.post("/api/pipelines/slow/runs").json()["id"]
    time.sleep(0.2)
    assert client.post(f"/api/runs/{run_id}/cancel").status_code == 200
    assert wait_for(client, run_id)["status"] == "CANCELLED"
    assert client.post(f"/api/runs/{run_id}/cancel").status_code == 409


def _dist(root, name):
    dist = root / name
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(f"<!doctype html><title>{name}</title>")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    return dist


def test_client_cache_headers(sample_workspace, tmp_path):
    settings = Settings(
        workspace=sample_workspace, client_dist=_dist(tmp_path, "ingestiq"), portal_dist=_dist(tmp_path, "portal")
    )
    with TestClient(create_app(settings)) as c:
        for path in ("/", "/ingestiq/", "/ingestiq/pipelines/daily_orders"):
            assert c.get(path).headers["cache-control"] == "no-cache"
        assert "immutable" in c.get("/ingestiq/assets/index-abc123.js").headers["cache-control"]
        assert "immutable" in c.get("/assets/index-abc123.js").headers["cache-control"]
        assert c.get("/favicon.svg").headers["cache-control"] == "no-cache"


def test_portal_at_root_and_ingestiq_under_its_path(sample_workspace, tmp_path):
    settings = Settings(
        workspace=sample_workspace, client_dist=_dist(tmp_path, "ingestiq"), portal_dist=_dist(tmp_path, "portal")
    )
    with TestClient(create_app(settings)) as c:
        assert "portal" in c.get("/").text
        assert "portal" in c.get("/anything/else").text  # the portal's own routes
        assert "ingestiq" in c.get("/ingestiq/runs/1").text
        r = c.get("/ingestiq", follow_redirects=False)
        assert r.status_code == 308 and r.headers["location"] == "/ingestiq/"
        # old IngestIQ links at the root go on to /ingestiq/, with their query
        r = c.get("/pipelines/daily_orders?tab=runs", follow_redirects=False)
        assert r.status_code == 307 and r.headers["location"] == "/ingestiq/pipelines/daily_orders?tab=runs"
        assert c.get("/api/health").status_code == 200


def test_insightiq_under_its_path_and_data_tabs_in_ingestiq(sample_workspace, tmp_path):
    settings = Settings(
        workspace=sample_workspace,
        client_dist=_dist(tmp_path, "ingestiq"),
        portal_dist=_dist(tmp_path, "portal"),
        insightiq_dist=_dist(tmp_path, "insightiq"),
    )
    with TestClient(create_app(settings)) as c:
        # InsightIQ (no tabs yet) is still served under its path, for its development
        assert "insightiq" in c.get("/insightiq/").text
        assert "immutable" in c.get("/insightiq/assets/index-abc123.js").headers["cache-control"]
        r = c.get("/insightiq", follow_redirects=False)
        assert r.status_code == 308 and r.headers["location"] == "/insightiq/"
        # the Data tabs are IngestIQ's: old links at the root and under /insightiq/ go there
        for old in ("/sql", "/insightiq/sql"):
            r = c.get(old + "?x=1", follow_redirects=False)
            assert r.status_code == 307 and r.headers["location"] == "/ingestiq/sql?x=1"
        assert "ingestiq" in c.get("/ingestiq/catalog").text


def test_settings_under_its_path_and_system_and_users_follow(sample_workspace, tmp_path):
    settings = Settings(
        workspace=sample_workspace,
        client_dist=_dist(tmp_path, "ingestiq"),
        portal_dist=_dist(tmp_path, "portal"),
        settings_dist=_dist(tmp_path, "settings"),
    )
    with TestClient(create_app(settings)) as c:
        assert "settings" in c.get("/settings/users").text
        for old in ("/system", "/ingestiq/system", "/users", "/ingestiq/users", "/ai-assist", "/ingestiq/ai-assist"):
            r = c.get(old, follow_redirects=False)
            assert r.status_code == 307 and r.headers["location"] == "/settings" + old.removeprefix("/ingestiq")


def test_without_a_portal_build_root_goes_to_ingestiq(sample_workspace, tmp_path):
    settings = Settings(
        workspace=sample_workspace, client_dist=_dist(tmp_path, "ingestiq"), portal_dist=tmp_path / "no-portal"
    )
    with TestClient(create_app(settings)) as c:
        r = c.get("/", follow_redirects=False)
        assert r.status_code == 307 and r.headers["location"] == "/ingestiq/"
