import json

import pytest
from fastapi.testclient import TestClient

from prooflix.api.sql import table_name
from prooflix.config import Settings
from prooflix.main import create_app


@pytest.fixture
def client(sample_workspace, tmp_path):
    out = sample_workspace / "data" / "output" / "2026-01-01"
    out.mkdir(parents=True)
    (out / "clean_orders.json").write_text(
        json.dumps([{"order_id": 1, "amount": 10.5, "tags": ["a"]}, {"order_id": 2, "amount": 4}])
    )
    (out / "summary.json").write_text(json.dumps({"total": 14.5, "by_country": {"IL": 14.5}}))
    (sample_workspace / ".prooflix").mkdir(exist_ok=True)
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client")
    with TestClient(create_app(settings)) as c:
        yield c


# ---------------------------------------------------------------- workspace
def test_tree_lists_workspace_without_hidden_folders(client):
    tree = client.get("/api/workspace/tree").json()
    assert tree["type"] == "dir"
    top = [c["name"] for c in tree["children"]]
    assert {"data", "pipelines", "src"} <= set(top)
    assert ".prooflix" not in top
    assert top.index("data") < top.index("pipelines")  # folders sorted by name


def test_read_file(client):
    res = client.get("/api/workspace/file", params={"path": "pipelines/hello_world.yaml"})
    assert res.status_code == 200
    body = res.json()
    assert body["content"] and not body["binary"] and not body["truncated"]


@pytest.mark.parametrize("path", ["../outside.txt", "/etc/passwd", ".prooflix", "missing.txt"])
def test_read_file_refuses_paths_outside_or_hidden(client, path):
    assert client.get("/api/workspace/file", params={"path": path}).status_code in (400, 404)


# ---------------------------------------------------------------- sql
def test_table_name():
    from pathlib import Path

    assert table_name(Path("orders.csv")) == "orders"
    assert table_name(Path("output/2026-11-07/clean_orders.json")) == "output_2026_11_07_clean_orders"
    assert table_name(Path("2026.csv")) == "t_2026"


def test_tables_lists_csv_and_json_files(client):
    tables = {t["name"]: t for t in client.get("/api/sql/tables").json()}
    assert tables["orders"]["source"] == "data/orders.csv"
    assert tables["orders"]["row_count"] > 0
    clean = tables["output_2026_01_01_clean_orders"]
    assert [c["name"] for c in clean["columns"]] == ["order_id", "amount", "tags"]
    assert tables["output_2026_01_01_summary"]["row_count"] == 1


def test_query_returns_rows_with_numbers(client):
    res = client.post(
        "/api/sql/query",
        json={"sql": "SELECT order_id, amount FROM output_2026_01_01_clean_orders ORDER BY order_id"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["columns"] == ["order_id", "amount"]
    assert body["rows"] == [[1, 10.5], [2, 4]]
    assert body["truncated"] is False


def test_query_limit_truncates(client):
    body = client.post("/api/sql/query", json={"sql": "SELECT * FROM orders", "limit": 2}).json()
    assert body["row_count"] == 2 and body["truncated"] is True


@pytest.mark.parametrize(
    "sql",
    [
        "DELETE FROM orders",
        "CREATE TABLE x (a)",
        "ATTACH DATABASE 'evil.db' AS evil",
        "SELECT * FROM nope",
        "SELECT 1; SELECT 2",
    ],
)
def test_query_rejects_writes_and_bad_sql(client, sql, sample_workspace):
    res = client.post("/api/sql/query", json={"sql": sql})
    assert res.status_code == 400
    assert res.json()["detail"]
    assert not (sample_workspace / "evil.db").exists()


# ---------------------------------------------------------------- import
import base64 as _b64


def _file(path, text):
    return {"path": path, "content_base64": _b64.b64encode(text.encode()).decode()}


PIPELINE_YAML = """\
name: Imported
tasks:
  - key: hello
    type: python
    entrypoint: imported_jobs.hello:run
"""


def test_import_writes_files_and_reports_pipelines(client, sample_workspace):
    res = client.post(
        "/api/workspace/import",
        json={
            "files": [
                _file("pipelines/imported.yaml", PIPELINE_YAML),
                _file("src/imported_jobs/__init__.py", ""),
                _file("src/imported_jobs/hello.py", "def run():\n    print('hi')\n    return 1\n"),
            ]
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["pipelines"] == ["imported"]
    assert (sample_workspace / "src/imported_jobs/hello.py").read_text().startswith("def run")
    # the imported pipeline is picked up and valid
    assert client.get("/api/pipelines/imported").json()["valid"] is True
    tree = client.get("/api/workspace/tree").json()
    src = next(c for c in tree["children"] if c["name"] == "src")
    assert "imported_jobs" in [c["name"] for c in src["children"]]


def test_import_refuses_to_overwrite_without_flag(client, sample_workspace):
    original = (sample_workspace / "pipelines/hello_world.yaml").read_text()
    res = client.post(
        "/api/workspace/import", json={"files": [_file("pipelines/hello_world.yaml", "x: 1\n")]}
    )
    assert res.status_code == 409
    assert res.json()["detail"]["conflicts"] == ["pipelines/hello_world.yaml"]
    assert (sample_workspace / "pipelines/hello_world.yaml").read_text() == original

    res = client.post(
        "/api/workspace/import",
        json={"files": [_file("pipelines/hello_world.yaml", original + "\n")], "overwrite": True},
    )
    assert res.status_code == 200


@pytest.mark.parametrize(
    "path", ["../escape.py", "/abs.py", "src/../../escape.py", ".git/config", "src/.env", "src/__pycache__/x.pyc"]
)
def test_import_rejects_unsafe_paths(client, sample_workspace, path):
    res = client.post("/api/workspace/import", json={"files": [_file(path, "x")]})
    assert res.status_code == 400
    assert not (sample_workspace.parent / "escape.py").exists()


def test_import_is_all_or_nothing(client, sample_workspace):
    res = client.post(
        "/api/workspace/import",
        json={"files": [_file("src/ok.py", "x = 1\n"), _file("../bad.py", "x")]},
    )
    assert res.status_code == 400
    assert not (sample_workspace / "src/ok.py").exists()


# ---------------------------------------------------------------- remove
def test_remove_file_moves_it_to_trash(client, sample_workspace):
    res = client.delete("/api/workspace/item", params={"path": "pipelines/hello_world.yaml"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["type"] == "file" and body["files"] == 1
    assert not (sample_workspace / "pipelines/hello_world.yaml").exists()
    assert (sample_workspace / body["trash"]).is_file()
    assert "hello_world" not in [p["id"] for p in client.get("/api/pipelines").json()]


def test_remove_folder(client, sample_workspace):
    project = sample_workspace / "proj" / "pipelines"
    project.mkdir(parents=True)
    (project / "p.yaml").write_text("tasks:\n  - key: a\n    type: shell\n    command: 'true'\n")
    assert "p" in [p["id"] for p in client.get("/api/pipelines").json()]
    body = client.delete("/api/workspace/item", params={"path": "proj"}).json()
    assert body["type"] == "dir" and body["files"] == 1
    assert not (sample_workspace / "proj").exists()
    assert "p" not in [p["id"] for p in client.get("/api/pipelines").json()]


@pytest.mark.parametrize("path", [".", "../x", ".prooflix", "missing.txt", "/etc/hosts"])
def test_remove_refuses_root_hidden_and_outside(client, path):
    assert client.delete("/api/workspace/item", params={"path": path}).status_code in (400, 404)


# ---------------------------------------------------------------- schemas and catalog
def _add_project_with_data(root):
    project = root / "my-project"
    (project / "pipelines").mkdir(parents=True)
    (project / "pipelines" / "proj_p.yaml").write_text(
        "tasks:\n  - key: a\n    type: shell\n    command: 'true'\n"
    )
    (project / "data").mkdir()
    (project / "data" / "orders.csv").write_text("id,amount\n1,5\n2,7\n")
    (root / "empty-project" / "pipelines").mkdir(parents=True)


def test_project_tables_live_in_their_own_schema(client, sample_workspace):
    _add_project_with_data(sample_workspace)
    tables = {t["qualified"]: t for t in client.get("/api/sql/tables").json()}
    assert tables["orders"]["schema"] == "main"  # the workspace's own data/orders.csv
    assert tables["my_project.orders"]["schema"] == "my_project"
    assert tables["my_project.orders"]["name"] == "orders"
    body = client.post("/api/sql/query", json={"sql": "SELECT SUM(amount) FROM my_project.orders"}).json()
    assert body["rows"] == [[12]]
    # both "orders" tables can be used side by side
    body = client.post(
        "/api/sql/query",
        json={"sql": "SELECT (SELECT COUNT(*) FROM orders) > 0, (SELECT COUNT(*) FROM my_project.orders)"},
    ).json()
    assert body["rows"] == [[1, 2]]


def test_catalog_lists_schemas_and_tables(client, sample_workspace):
    _add_project_with_data(sample_workspace)
    cat = {s["name"]: s for s in client.get("/api/catalog").json()}
    assert list(cat) == ["main", "empty_project", "my_project"]
    assert cat["my_project"]["project"] == "my-project"
    assert cat["my_project"]["data_dir"] == "my-project/data"
    assert [t["name"] for t in cat["my_project"]["tables"]] == ["orders"]
    assert cat["my_project"]["tables"][0]["columns"] == [
        {"name": "id", "type": "INTEGER"},
        {"name": "amount", "type": "INTEGER"},
    ]
    assert cat["empty_project"]["tables"] == [] and cat["empty_project"]["data_dir"] is None


def test_catalog_without_workspace_data_has_no_main(client, sample_workspace):
    import shutil

    shutil.rmtree(sample_workspace / "data")
    assert client.get("/api/catalog").json() == []
