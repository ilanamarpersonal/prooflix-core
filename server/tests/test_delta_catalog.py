import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import delta_log
from prooflix.config import Settings
from prooflix.main import create_app


def _commit(log: Path, version: int, *actions: dict) -> None:
    (log / f"{version:020d}.json").write_text("\n".join(json.dumps(a) for a in actions) + "\n")


def _add(path: str, rows: int) -> dict:
    return {"add": {"path": path, "size": 1, "dataChange": True, "stats": json.dumps({"numRecords": rows})}}


def make_table(folder: Path) -> None:
    """v0: a.parquet (2 rows); v1: overwrite with b.parquet (3 rows), a.parquet removed."""
    log = folder / "_delta_log"
    log.mkdir(parents=True)
    pq.write_table(pa.table({"id": [1, 2]}), folder / "a.parquet")
    pq.write_table(pa.table({"id": [10, 20, 30]}), folder / "b.parquet")
    _commit(log, 0, {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}},
            {"metaData": {"id": "x", "configuration": {}}}, _add("a.parquet", 2))
    _commit(log, 1, {"remove": {"path": "a.parquet", "dataChange": True}}, _add("b.parquet", 3))


def test_current_files_replays_adds_and_removes(tmp_path):
    make_table(tmp_path / "t")
    files = delta_log.current_files(tmp_path / "t")
    assert [(f.path.name, f.rows) for f in files] == [("b.parquet", 3)]


def test_checkpoint_then_later_commits(tmp_path):
    t = tmp_path / "t"
    make_table(t)
    log = t / "_delta_log"
    # a checkpoint at v1 (only b live), then v2 adds c; the v0/v1 commits are gone
    pq.write_table(pa.table({"add": [{"path": "b.parquet", "stats": json.dumps({"numRecords": 3})}, None]}),
                   log / f"{1:020d}.checkpoint.parquet")
    (log / "_last_checkpoint").write_text(json.dumps({"version": 1}))
    (log / f"{0:020d}.json").unlink()
    (log / f"{1:020d}.json").unlink()
    pq.write_table(pa.table({"id": [40]}), t / "c.parquet")
    _commit(log, 2, _add("c.parquet", 1))
    assert [(f.path.name, f.rows) for f in delta_log.current_files(t)] == [("b.parquet", 3), ("c.parquet", 1)]


def test_deletion_vectors_are_refused(tmp_path):
    t = tmp_path / "t"
    make_table(t)
    _commit(t / "_delta_log", 2, {"add": {"path": "b.parquet", "deletionVector": {"storageType": "u"}}})
    with pytest.raises(delta_log.UnsupportedDeltaTable):
        delta_log.current_files(t)


def test_catalog_lists_nested_delta_tables_under_their_schema(sample_workspace, tmp_path):
    lake = sample_workspace / "data" / "tenant9" / "lakehouse"
    make_table(lake / "bronze" / "accounts")
    make_table(lake / "gold" / "daily")
    settings = Settings(workspace=sample_workspace, client_dist=tmp_path / "no-client", scheduler=False)
    with TestClient(create_app(settings)) as c:
        schemas = {s["name"]: [t["name"] for t in s["tables"]] for s in c.get("/api/catalog").json()}
        assert schemas.get("tenant9.bronze") == ["accounts"]
        assert schemas.get("tenant9.gold") == ["daily"]
        assert "tenant9.lakehouse" not in schemas
        res = c.post("/api/sql/query", json={"sql": "SELECT count(*) AS n, sum(id) AS s FROM tenant9.bronze.accounts"})
        assert res.status_code == 200, res.text
        assert res.json()["rows"] == [[3, 60]]  # only the current version: b.parquet
