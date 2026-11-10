import datetime as dt
import io
from pathlib import Path

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix.api.sql import table_key, table_name
from prooflix.config import Settings
from prooflix.main import create_app


def write_parquet(path: Path, rows: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


def parquet_bytes(rows: list[dict]) -> bytes:
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows), buf)
    return buf.getvalue()


@pytest.fixture
def client(sample_workspace, tmp_path):
    data = sample_workspace / "data"
    # the catalog reads Parquet only: data/orders.parquet is the table "orders"
    pq.write_table(pacsv.read_csv(data / "orders.csv"), data / "orders.parquet")
    # each folder in data/ is a schema named after it (a tenant ID), and a folder
    # of Parquet files is one table: data/<catalog>/<schema>/<table>/ is
    # tenant1.bronze.clean_orders (source/ and checkpoint/
    # hold no Parquet, so they add no tables)
    out = data / "tenant1" / "bronze" / "clean_orders"
    (data / "tenant1" / "source").mkdir(parents=True)
    (data / "tenant1" / "source" / "orders.avro").write_bytes(b"Obj\x01")
    (data / "tenant1" / "checkpoint").mkdir()
    (data / "tenant1" / "checkpoint" / "last_checkpoint.txt").write_text("2026-01-01T00:00:00+00:00")
    write_parquet(out / "part-0.parquet", [{"order_id": 1, "amount": 10.5, "tags": ["a"]}])
    write_parquet(out / "part-1.parquet", [{"order_id": 2, "amount": 4.0, "tags": None}])
    write_parquet(
        data / "tenant1" / "bronze" / "summary" / "summary.parquet",
        [{"total": 14.5, "day": dt.date(2026, 1, 1), "at": dt.datetime(2026, 1, 1, 8, 30)}],
    )
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
def test_table_name_and_key():
    assert table_name(Path("orders.parquet")) == "orders"
    assert table_name(Path("output/2026-11-07/clean_orders")) == "output_2026_11_07_clean_orders"
    assert table_name(Path("2026.parquet")) == "t_2026"
    assert table_key(Path("orders.parquet")) == Path("orders.parquet")
    assert table_key(Path("destination/customers/part-0.parquet")) == Path("destination/customers")


def test_tables_are_parquet_files_and_folders_only(client, sample_workspace):
    (sample_workspace / "data" / "notes.json").write_text('[{"a": 1}]')  # not a data lake file
    tables = {t["qualified"]: t for t in client.get("/api/sql/tables").json()}
    assert set(tables) == {"orders", "tenant1.bronze.clean_orders", "tenant1.bronze.summary"}
    assert tables["orders"]["source"] == "data/orders.parquet"
    assert tables["orders"]["row_count"] > 0
    clean = tables["tenant1.bronze.clean_orders"]
    assert (clean["catalog"], clean["schema"], clean["name"]) == ("tenant1", "tenant1.bronze", "clean_orders")
    assert clean["source"] == "data/tenant1/bronze/clean_orders"
    assert clean["row_count"] == 2  # both part files
    assert [c["name"] for c in clean["columns"]] == ["order_id", "amount", "tags"]
    summary = tables["tenant1.bronze.summary"]
    assert summary["row_count"] == 1
    assert [c["type"] for c in summary["columns"]] == ["REAL", "TEXT", "TEXT"]


def test_dates_and_timestamps_are_iso_text(client):
    rows = client.post("/api/sql/query", json={"sql": "SELECT day, at FROM tenant1.bronze.summary"}).json()["rows"]
    assert rows == [["2026-01-01", "2026-01-01 08:30:00"]]


def test_hidden_and_underscore_parquet_files_are_skipped(client, sample_workspace):
    write_parquet(sample_workspace / "data" / "_tmp" / "x.parquet", [{"a": 1}])
    write_parquet(sample_workspace / "data" / ".cache" / "y.parquet", [{"a": 1}])
    (sample_workspace / "data" / "broken.parquet").write_text("not parquet")
    names = {t["qualified"] for t in client.get("/api/sql/tables").json()}
    assert not names & {"t_tmp", "tmp", "cache", "broken"}
    assert not {n.split(".")[0] for n in names} & {"_tmp", "tmp", "cache", "s_tmp"}


def test_query_returns_rows_with_numbers(client):
    res = client.post(
        "/api/sql/query",
        json={"sql": "SELECT order_id, amount FROM tenant1.bronze.clean_orders ORDER BY order_id"},
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
    write_parquet(project / "data" / "orders.parquet", [{"id": 1, "amount": 5}, {"id": 2, "amount": 7}])
    (root / "empty-project" / "pipelines").mkdir(parents=True)


def test_project_tables_live_in_their_own_schema(client, sample_workspace):
    _add_project_with_data(sample_workspace)
    tables = {t["qualified"]: t for t in client.get("/api/sql/tables").json()}
    assert tables["orders"]["schema"] == "main"  # the workspace's own data/orders.parquet
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
    # data/tenant1/bronze is schema bronze of catalog tenant1; empty-project has no tables
    assert list(cat) == ["main", "tenant1.bronze", "my_project"]
    bronze = cat["tenant1.bronze"]
    assert (bronze["catalog"], bronze["data_dir"], bronze["location"]) == ("tenant1", "data/tenant1/bronze", "workspace")
    assert cat["my_project"]["catalog"] == ""
    assert cat["my_project"]["project"] == "my-project"
    assert cat["my_project"]["data_dir"] == "my-project/data"
    assert [t["name"] for t in cat["my_project"]["tables"]] == ["orders"]
    assert cat["my_project"]["tables"][0]["columns"] == [
        {"name": "id", "type": "INTEGER"},
        {"name": "amount", "type": "INTEGER"},
    ]


def test_catalog_without_workspace_data_has_no_main(client, sample_workspace):
    import shutil

    shutil.rmtree(sample_workspace / "data")
    assert client.get("/api/catalog").json() == []


# ---------------------------------------------------------------- catalog import / export
import io as _io
import zipfile as _zipfile


def _upload(name, content):
    data = content if isinstance(content, bytes) else content.encode()
    return {"name": name, "content_base64": _b64.b64encode(data).decode()}


def test_catalog_import_into_new_schema_and_export(client, sample_workspace):
    res = client.post(
        "/api/catalog/import",
        json={
            "schema": "Sales Data",
            "files": [
                _upload("deals.parquet", parquet_bytes([{"id": 1, "amount": 10}, {"id": 2, "amount": 20}])),
                _upload("regions.parquet", parquet_bytes([{"code": "IL"}])),
            ],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body == {"schema": "sales_data", "folder": "catalog/Sales-Data", "tables": ["deals", "regions"], "created_schema": True}
    # a new schema lives in the catalog folder next to the workspace, not in the workspace
    catalog_dir = sample_workspace.parent / "catalog"
    assert (catalog_dir / "Sales-Data" / "deals.parquet").is_file()
    assert not (sample_workspace / "Sales-Data").exists()
    assert "Sales-Data" not in [c["name"] for c in client.get("/api/workspace/tree").json()["children"]]
    tables = {t["qualified"]: t for t in client.get("/api/sql/tables").json()}
    assert tables["sales_data.deals"]["source"] == "catalog/Sales-Data/deals.parquet"
    assert tables["sales_data.deals"]["in_workspace"] is False
    assert tables["orders"]["in_workspace"] is True
    rows = client.post("/api/sql/query", json={"sql": "SELECT SUM(amount) FROM sales_data.deals"}).json()["rows"]
    assert rows == [[30]]
    cat = {c["name"]: c for c in client.get("/api/catalog").json()}
    assert cat["sales_data"]["location"] == "catalog" and cat["main"]["location"] == "workspace"

    csv_res = client.get("/api/catalog/export", params={"table": "sales_data.deals"})
    assert csv_res.headers["content-type"].startswith("text/csv")
    assert "sales_data.deals.csv" in csv_res.headers["content-disposition"]
    assert csv_res.text.replace("\r\n", "\n") == "id,amount\n1,10\n2,20\n"

    zip_res = client.get("/api/catalog/export", params={"schema": "sales_data"})
    assert sorted(_zipfile.ZipFile(_io.BytesIO(zip_res.content)).namelist()) == ["deals.csv", "regions.csv"]

    everything = _zipfile.ZipFile(_io.BytesIO(client.get("/api/catalog/export").content)).namelist()
    assert "sales_data/deals.csv" in everything and "main/orders.csv" in everything


def test_catalog_import_conflict_and_overwrite(client, sample_workspace):
    upload = _upload("orders.parquet", parquet_bytes([{"a": 1}]))
    res = client.post("/api/catalog/import", json={"schema": "main", "files": [upload]})
    assert res.status_code == 409
    assert res.json()["detail"]["conflicts"] == ["orders"]
    res = client.post("/api/catalog/import", json={"schema": "main", "files": [upload], "overwrite": True})
    assert res.status_code == 200
    assert client.post("/api/sql/query", json={"sql": "SELECT * FROM orders"}).json()["rows"] == [[1]]


@pytest.mark.parametrize(
    "files",
    [
        [_upload("notes.txt", "hello")],
        [_upload("deals.csv", "id,amount\n1,10\n")],  # CSV and JSON are not data lake files
        [_upload("regions.json", '[{"code":"IL"}]')],
        [_upload("bad.parquet", "not parquet")],
        [_upload(".hidden.parquet", parquet_bytes([{"a": 1}]))],
    ],
)
def test_catalog_import_rejects_non_tables(client, sample_workspace, files):
    res = client.post("/api/catalog/import", json={"schema": "new_one", "files": files})
    assert res.status_code == 400
    assert not (sample_workspace / "new_one").exists()
    assert not (sample_workspace.parent / "catalog" / "new_one").exists()


def test_export_unknown_table_or_schema(client):
    assert client.get("/api/catalog/export", params={"table": "nope.x"}).status_code == 404
    assert client.get("/api/catalog/export", params={"schema": "nope"}).status_code == 404


def test_export_table_as_parquet_zip(client, sample_workspace):
    import pyarrow.parquet as pq

    write_parquet(
        sample_workspace / "data" / "mixed.parquet",
        [{"id": 1, "amount": 2.5, "label": "a"}, {"id": 2, "amount": None, "label": "b"}, {"id": 3, "amount": 4.0, "label": None}],
    )
    res = client.get("/api/catalog/export", params={"table": "main.mixed", "format": "parquet"})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/zip"
    assert 'filename="main.mixed-parquet.zip"' in res.headers["content-disposition"]
    zf = _zipfile.ZipFile(_io.BytesIO(res.content))
    assert zf.namelist() == ["main.mixed.parquet"]
    table = pq.read_table(_io.BytesIO(zf.read("main.mixed.parquet")))
    assert table.column_names == ["id", "amount", "label"]
    assert [str(t) for t in table.schema.types] == ["int64", "double", "string"]
    assert table.to_pylist() == [
        {"id": 1, "amount": 2.5, "label": "a"},
        {"id": 2, "amount": None, "label": "b"},
        {"id": 3, "amount": 4.0, "label": None},
    ]


def test_export_schema_as_parquet_zip(client):
    res = client.get("/api/catalog/export", params={"schema": "main", "format": "parquet"})
    names = _zipfile.ZipFile(_io.BytesIO(res.content)).namelist()
    assert "orders.parquet" in names and all(n.endswith(".parquet") for n in names)
    assert client.get("/api/catalog/export", params={"format": "xlsx"}).status_code == 422


# ---------------------------------------------------------------- three-level names
def test_three_part_names_in_queries(client):
    sql = """
        SELECT c.order_id, s.total, 'tenant1.bronze.x' AS text  -- tenant1.bronze.nope
        FROM Tenant1 . Bronze .clean_orders c, tenant1.bronze.summary s
        ORDER BY c.order_id
    """
    body = client.post("/api/sql/query", json={"sql": sql}).json()
    assert body["rows"] == [[1, 14.5, "tenant1.bronze.x"], [2, 14.5, "tenant1.bronze.x"]], body
    # catalog.schema.table.column works too
    sql = "SELECT tenant1.bronze.clean_orders.order_id FROM tenant1.bronze.clean_orders ORDER BY 1"
    assert client.post("/api/sql/query", json={"sql": sql}).json()["rows"] == [[1], [2]]


def test_rewrite_three_part_names_leaves_strings_and_other_names():
    from prooflix.api.sql import rewrite_three_part_names as rewrite

    names = ["main", "tenant1.bronze", "my_project"]
    assert rewrite("SELECT * FROM tenant1.bronze.t", names) == 'SELECT * FROM "tenant1.bronze".t'
    assert rewrite("SELECT 'tenant1.bronze.t'", names) == "SELECT 'tenant1.bronze.t'"
    assert rewrite("SELECT * FROM xtenant1.bronze.t, my_project.t", names) == (
        "SELECT * FROM xtenant1.bronze.t, my_project.t"
    )


def test_catalog_folder_files_outside_schema_folders_are_ignored(client, sample_workspace):
    write_parquet(sample_workspace / "data" / "tenant1" / "loose.parquet", [{"a": 1}])
    assert "loose" not in {t["name"] for t in client.get("/api/sql/tables").json()}
