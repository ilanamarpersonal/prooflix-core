"""Source data and data lake folders: per workspace (web client), server default
(PROOFLIX_SOURCE_DATA / PROOFLIX_DATA_LAKE), or the workspace's own source/ and data/."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import linked_folders
from prooflix.config import Settings
from prooflix.main import create_app


def make_ws(path: Path) -> Path:
    (path / "pipelines").mkdir(parents=True)
    (path / "src").mkdir()
    return path


def make_lake(path: Path) -> Path:
    table = path / "tenant1" / "bronze" / "customers"
    table.mkdir(parents=True)
    pq.write_table(pa.table({"id": [1, 2, 3]}), table / "part-0.parquet")
    return path


def client(root: Path, tmp_path: Path, data_lake: Path | None = None, source_data: Path | None = None) -> TestClient:
    settings = Settings(
        workspaces_root=root,
        client_dist=tmp_path / "no-client",
        home=tmp_path / "home",
        scheduler=False,
        data_lake=data_lake,
        source_data=source_data,
    )
    return TestClient(create_app(settings))


def test_default_is_the_workspace_data_folder(tmp_path):
    ws = make_ws(tmp_path / "ws")
    lake = linked_folders.resolve(ws, "data_lake", None)
    assert lake.path == (ws / "data").resolve() and lake.origin == "default"
    source = linked_folders.resolve(ws, "source_data", None)
    assert source.path == (ws / "source").resolve() and source.origin == "default"


def test_server_default_links_data(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    lake = make_lake(tmp_path / "lake")
    with client(root, tmp_path, data_lake=lake) as c:
        assert (ws / "data").is_symlink() and (ws / "data").resolve() == lake.resolve()
        body = c.get("/api/workspace/folders/data-lake").json()
        assert body["origin"] == "server" and body["linked"] is True
        assert body["server_default"] == str(lake.resolve())
        # the catalog and SQL see the lake's tables as data/...
        tables = {t["name"]: t for t in c.get("/api/sql/tables").json()}
        assert "customers" in tables
        r = c.post("/api/sql/query", json={"sql": "SELECT count(*) AS n FROM tenant1.bronze.customers"})
        assert r.status_code == 200, r.text
        assert r.json()["rows"] == [[3]]


def test_workspace_setting_wins_and_can_be_cleared(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    server_lake = make_lake(tmp_path / "server-lake")
    own_lake = make_lake(tmp_path / "own-lake")
    with client(root, tmp_path, data_lake=server_lake) as c:
        r = c.put("/api/workspace/folders/data-lake", json={"path": str(own_lake)})
        assert r.status_code == 200, r.text
        assert r.json()["origin"] == "workspace" and (ws / "data").resolve() == own_lake.resolve()
        # saved with the workspace
        assert linked_folders.read_setting(ws, "data_lake") == own_lake.resolve()
        # cleared: back to the server default
        r = c.put("/api/workspace/folders/data-lake", json={"path": None})
        assert r.json()["origin"] == "server" and (ws / "data").resolve() == server_lake.resolve()


def test_workspace_setting_without_server_default_goes_back_to_data(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    lake = make_lake(tmp_path / "lake")
    with client(root, tmp_path) as c:
        c.put("/api/workspace/folders/data-lake", json={"path": str(lake)})
        assert (ws / "data").is_symlink()
        r = c.put("/api/workspace/folders/data-lake", json={"path": None})
        assert r.json()["origin"] == "default" and r.json()["linked"] is False
        assert not (ws / "data").exists()  # the link is gone; the lake is untouched
        assert (lake / "tenant1" / "bronze" / "customers" / "part-0.parquet").is_file()


def test_setting_survives_a_restart(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    lake = make_lake(tmp_path / "lake")
    with client(root, tmp_path) as c:
        c.put("/api/workspace/folders/data-lake", json={"path": str(lake)})
    (ws / "data").unlink()  # e.g. the workspace was copied without the link
    with client(root, tmp_path) as c:
        assert (ws / "data").resolve() == lake.resolve()
        assert c.get("/api/workspace/folders/data-lake").json()["origin"] == "workspace"


@pytest.mark.parametrize("bad", ["relative/path", "/does/not/exist"])
def test_rejects_bad_folders(tmp_path, bad):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    with client(root, tmp_path) as c:
        assert c.put("/api/workspace/folders/data-lake", json={"path": bad}).status_code == 400


def test_never_replaces_a_data_folder_with_files(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    (ws / "data").mkdir()
    (ws / "data" / "mine.csv").write_text("a\n1\n")
    lake = make_lake(tmp_path / "lake")
    with client(root, tmp_path, data_lake=lake) as c:
        # the server default can't be used: the server still starts on data/
        assert not (ws / "data").is_symlink()
        r = c.put("/api/workspace/folders/data-lake", json={"path": str(lake)})
        assert r.status_code == 400 and "move them" in r.json()["detail"]
        assert linked_folders.read_setting(ws, "data_lake") is None  # nothing saved
    assert (ws / "data" / "mine.csv").read_text() == "a\n1\n"


def test_lake_inside_the_workspace_is_refused(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    (ws / "lake").mkdir()
    with client(root, tmp_path) as c:
        r = c.put("/api/workspace/folders/data-lake", json={"path": str(ws / "lake")})
        assert r.status_code == 400


def test_files_in_the_lake_open_in_the_workspace_viewer(tmp_path):
    root = tmp_path / "workspaces"
    make_ws(root / "main")
    lake = tmp_path / "lake"
    (lake / "tenant1" / "source").mkdir(parents=True)
    (lake / "tenant1" / "source" / "a.csv").write_text("x\n1\n")
    with client(root, tmp_path, data_lake=lake) as c:
        r = c.get("/api/workspace/file", params={"path": "data/tenant1/source/a.csv"})
        assert r.status_code == 200 and r.json()["content"] == "x\n1\n"
        # but nothing outside the lake or workspace
        assert c.get("/api/workspace/file", params={"path": "data/../../lake/tenant1/source/a.csv"}).status_code == 400


def test_pipeline_code_reads_data_through_the_link(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    lake = tmp_path / "lake"
    (lake / "in").mkdir(parents=True)
    (lake / "in" / "n.txt").write_text("41")
    (ws / "src" / "job.py").write_text(
        textwrap.dedent(
            """
            def run(ctx):
                n = int((ctx.workspace / "data/in/n.txt").read_text())
                (ctx.workspace / "data/out.txt").write_text(str(n + 1))
                return {"n": n + 1}
            """
        )
    )
    (ws / "pipelines" / "p.yaml").write_text(
        "name: P\ntasks:\n  - key: t\n    type: python\n    entrypoint: job:run\n"
    )
    with client(root, tmp_path, data_lake=lake) as c:
        run = c.post("/api/pipelines/p/runs", json={}).json()
        import time

        for _ in range(50):
            run = c.get(f"/api/runs/{run['id']}").json()
            if run["status"] not in ("PENDING", "QUEUED", "RUNNING"):
                break
            time.sleep(0.1)
        assert run["status"] == "SUCCEEDED", run
    assert (lake / "out.txt").read_text() == "42"  # written in the lake, in place


def test_source_data_is_a_separate_read_folder_and_the_checkpoint_stays_in_the_lake(tmp_path):
    """Bronze-like code reads source/ and writes its output and checkpoint under data/."""
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    source = tmp_path / "raw"
    (source / "customers").mkdir(parents=True)
    (source / "customers" / "c.csv").write_text("id\n1\n2\n")
    lake = tmp_path / "lake"
    lake.mkdir()
    (ws / "src" / "ingest.py").write_text(
        textwrap.dedent(
            """
            def run(source_dir, destination_dir, checkpoint_file, ctx):
                src = ctx.workspace / source_dir
                n = sum(len(p.read_text().splitlines()) - 1 for p in src.rglob("*.csv"))
                out = ctx.workspace / destination_dir
                out.mkdir(parents=True, exist_ok=True)
                (out / "rows.txt").write_text(str(n))
                cp = ctx.workspace / checkpoint_file
                cp.parent.mkdir(parents=True, exist_ok=True)
                cp.write_text("done")
                return {"rows": n}
            """
        )
    )
    (ws / "pipelines" / "bronze.yaml").write_text(
        textwrap.dedent(
            """
            name: Bronze
            tasks:
              - key: ingest
                type: python
                entrypoint: ingest:run
                parameters:
                  source_dir: source
                  destination_dir: data/tenant1/bronze
                  checkpoint_file: data/tenant1/checkpoint/last_checkpoint.txt
            """
        )
    )
    with client(root, tmp_path, data_lake=lake, source_data=source) as c:
        assert (ws / "source").resolve() == source.resolve() and (ws / "data").resolve() == lake.resolve()
        body = c.get("/api/workspace/folders/source-data").json()
        assert body["origin"] == "server" and body["link"] == "source" and body["linked"] is True
        run = c.post("/api/pipelines/bronze/runs", json={}).json()
        import time

        for _ in range(50):
            run = c.get(f"/api/runs/{run['id']}").json()
            if run["status"] not in ("PENDING", "QUEUED", "RUNNING"):
                break
            time.sleep(0.1)
        assert run["status"] == "SUCCEEDED", run
    assert (lake / "tenant1" / "bronze" / "rows.txt").read_text() == "2"
    assert (lake / "tenant1" / "checkpoint" / "last_checkpoint.txt").read_text() == "done"
    assert sorted(p.name for p in source.rglob("*")) == ["c.csv", "customers"]  # nothing written to the source


def test_each_folder_is_set_on_its_own(tmp_path):
    root = tmp_path / "workspaces"
    ws = make_ws(root / "main")
    source = tmp_path / "raw"
    source.mkdir()
    lake = tmp_path / "lake"
    lake.mkdir()
    with client(root, tmp_path) as c:
        assert c.put("/api/workspace/folders/source-data", json={"path": str(source)}).status_code == 200
        assert c.put("/api/workspace/folders/data-lake", json={"path": str(lake)}).status_code == 200
        assert linked_folders.read_setting(ws, "source_data") == source.resolve()
        assert linked_folders.read_setting(ws, "data_lake") == lake.resolve()
        # clearing one leaves the other
        c.put("/api/workspace/folders/source-data", json={"path": None})
        assert not (ws / "source").exists() and (ws / "data").resolve() == lake.resolve()
        assert c.get("/api/workspace/folders/nope").status_code == 404

