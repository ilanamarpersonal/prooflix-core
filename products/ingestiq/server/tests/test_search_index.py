"""Fast search: index builds and alias swaps, incremental updates from Delta versions, and search
through the index, with an in-memory stand-in for OpenSearch."""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from prooflix import delta_log, search_index
from prooflix.config import Settings
from prooflix.main import create_app
from prooflix.search_index import PK, TITLE, Indexer, SearchError


class FakeSearch:
    """The OpenSearch calls search_index uses, in memory; search is a case-insensitive substring match."""

    def __init__(self):
        self.indexes: dict[str, dict[str, dict]] = {}
        self.aliases: dict[str, str] = {}
        self.state: dict[str, dict] = {}
        self.down = False

    def _check(self):
        if self.down:
            raise SearchError("OpenSearch isn't reachable")

    def status(self):
        return {"configured": True, "ok": not self.down, "version": "fake", "error": None}

    def get_state(self, key):
        self._check()
        return self.state.get(key)

    def put_state(self, key, state):
        self.state[key] = state

    def delete_state(self, key):
        self.state.pop(key, None)

    def states(self):
        self._check()
        return dict(self.state)

    def create_index(self, name, mapping):
        self.indexes[name] = {}

    def finish_index(self, name):
        pass

    def refresh(self, name):
        pass

    def _target(self, name):
        return self.aliases.get(name, name)

    def bulk(self, index, ops):
        docs = self.indexes[self._target(index)]
        for op, doc_id, doc in ops:
            if op == "index":
                docs[doc_id] = doc
            else:
                docs.pop(doc_id, None)

    def alias_targets(self, alias):
        return [self.aliases[alias]] if alias in self.aliases else []

    def swap_alias(self, alias, new):
        old = self.alias_targets(alias)
        self.aliases[alias] = new
        return [o for o in old if o != new]

    def delete_index(self, name):
        self.indexes.pop(name, None)

    def count(self, alias):
        return len(self.indexes.get(self._target(alias), {}))

    def search(self, alias, text, fields, limit, offset):
        self._check()
        docs = self.indexes[self._target(alias)]
        hits = [(k, d) for k, d in sorted(docs.items())
                if not text or text.lower() == k.lower()
                or any(text.lower() in str(d.get(f, "")).lower() for f in fields)]
        return hits[offset : offset + limit]


def _commit(log: Path, version: int, *actions: dict) -> None:
    (log / f"{version:020d}.json").write_text("\n".join(json.dumps(a) for a in actions) + "\n")


def _add(path: str) -> dict:
    return {"add": {"path": path, "size": 1, "dataChange": True}}


CUSTOMER = {
    "api_name": "Customer",
    "source": {"table": "tenant1.silver.customers"},
    "primary_key": "customer_id",
    "title": "full_name",
    "index": True,
    "properties": [
        {"api_name": "customer_id", "column": "customer_id"},
        {"api_name": "full_name", "column": "full_name", "searchable": True},
        {"api_name": "city", "column": "city"},
        {"api_name": "email", "column": "email", "sensitive": True, "searchable": True},
    ],
}


@pytest.fixture
def setup(tmp_path: Path):
    ws = tmp_path / "ws"
    (ws / "pipelines").mkdir(parents=True)
    table = ws / "data" / "tenant1" / "silver" / "customers"
    (table / "_delta_log").mkdir(parents=True)
    pq.write_table(pa.table({"customer_id": [1, 2], "full_name": ["Dana Cohen", "Avi Levi"], "city": ["Haifa", "Eilat"],
                             "email": ["d@x.io", "a@x.io"]}), table / "part-0.parquet")
    _commit(table / "_delta_log", 0, {"protocol": {"minReaderVersion": 1, "minWriterVersion": 2}},
            {"metaData": {"id": "x", "configuration": {}}}, _add("part-0.parquet"))
    fake = FakeSearch()
    settings = Settings(workspace=ws, home=tmp_path / "home", scheduler=False, catalog=tmp_path / "catalog",
                        search_url="http://fake:9200")
    app = create_app(settings)
    app.state.indexer = Indexer(backend_factory=lambda s: fake if s.search_url else None)
    with TestClient(app) as c:
        yield c, app, fake, table


def _wait(app, name="Customer"):
    for _ in range(200):
        status = app.state.indexer.status(app, {})
        jobs = [j for j in app.state.indexer.jobs.values() if j.type == name]
        if jobs and jobs[-1].state not in ("queued", "running"):
            return jobs[-1]
        time.sleep(0.02)
    raise AssertionError(f"the index job didn't finish: {status}")


def test_changes_since_follows_files(tmp_path: Path):
    t = tmp_path / "t"
    (t / "_delta_log").mkdir(parents=True)
    for name in ("a.parquet", "b.parquet"):
        pq.write_table(pa.table({"id": [1]}), t / name)
    _commit(t / "_delta_log", 0, _add("a.parquet"))
    _commit(t / "_delta_log", 1, {"remove": {"path": "a.parquet", "dataChange": True}}, _add("b.parquet"))
    assert delta_log.current_version(t) == 1
    c = delta_log.changes_since(t, 0)
    assert not c.rebuild and [p.name for p in c.added] == ["b.parquet"] and [p.name for p in c.removed] == ["a.parquet"]
    (t / "a.parquet").unlink()  # vacuumed
    assert delta_log.changes_since(t, 0).rebuild
    _commit(t / "_delta_log", 2, {"metaData": {"id": "x"}})
    assert "schema" in delta_log.changes_since(t, 1).reason


def test_publish_builds_the_index_and_search_uses_it(setup):
    c, app, fake, table = setup
    assert c.post("/api/ontology/publish", json={"type": CUSTOMER}).status_code == 200
    job = _wait(app)
    assert job.state == "done" and job.kind == "full" and job.done == 2
    alias = search_index.alias_name(app.state.workspace.root, "Customer")
    docs = fake.indexes[fake.aliases[alias]]
    assert docs["1"][TITLE] == "Dana Cohen" and docs["1"][PK] == "1"
    assert "email" not in docs["1"]  # sensitive properties never go into the index

    status = c.get("/api/ontology/index").json()["types"]["Customer"]
    assert status["ready"] and status["state"]["docs"] == 2 and status["state"]["fingerprint"] == "delta:0"
    found = c.get("/api/ontology/objects/search", params={"q": "coh"}).json()["groups"][0]
    assert found["engine"] == "index" and [o["pk"] for o in found["objects"]] == ["1"]
    assert found["objects"][0]["properties"]["city"] == "Haifa"
    assert c.get("/api/ontology/objects/suggest", params={"q": "avi"}).json() == [
        {"type": "Customer", "pk": "2", "title": "Avi Levi"}]
    assert c.get("/api/ontology/objects/types").json()[0]["indexed"] is True

    # OpenSearch down: search falls back to the lake and says so
    fake.down = True
    found = c.get("/api/ontology/objects/search", params={"q": "coh"}).json()["groups"][0]
    assert found["engine"] == "lake" and [o["pk"] for o in found["objects"]] == ["1"]
    fake.down = False


def test_new_delta_versions_update_only_the_changed_objects(setup):
    c, app, fake, table = setup
    c.post("/api/ontology/publish", json={"type": CUSTOMER})
    _wait(app)
    alias = search_index.alias_name(app.state.workspace.root, "Customer")
    first = fake.aliases[alias]
    # v1: a new customer; v2: part-0 rewritten without Avi (deleted) and with Dana renamed
    pq.write_table(pa.table({"customer_id": [3], "full_name": ["Noa Bar"], "city": ["Acre"], "email": ["n@x.io"]}),
                   table / "part-1.parquet")
    _commit(table / "_delta_log", 1, _add("part-1.parquet"))
    pq.write_table(pa.table({"customer_id": [1], "full_name": ["Dana Cohen-Levi"], "city": ["Haifa"],
                             "email": ["d@x.io"]}), table / "part-2.parquet")
    _commit(table / "_delta_log", 2, {"remove": {"path": "part-0.parquet", "dataChange": True}},
            _add("part-2.parquet"))

    app.state.indexer.tick(app)  # what the watcher does every minute
    job = _wait(app)
    assert job.state == "done" and job.kind == "update" and job.total == 3  # keys 1, 2 and 3
    assert fake.aliases[alias] == first  # updated in place, not rebuilt
    docs = fake.indexes[first]
    assert sorted(docs) == ["1", "3"] and docs["1"][TITLE] == "Dana Cohen-Levi"
    assert fake.state[search_index.state_key(app.state.workspace.root, "Customer")]["fingerprint"] == "delta:2"

    # a changed definition rebuilds into a new index and swaps the alias
    changed = copy.deepcopy(CUSTOMER)
    changed["properties"][2]["searchable"] = True
    c.post("/api/ontology/publish", json={"type": changed, "modified": c.get("/api/ontology/types/Customer").json()["modified"]})
    job = _wait(app)
    assert job.kind == "full" and fake.aliases[alias] != first and first not in fake.indexes

    # Fast search turned off: the index goes away
    off = copy.deepcopy(changed) | {"index": False}
    c.post("/api/ontology/publish", json={"type": off, "modified": c.get("/api/ontology/types/Customer").json()["modified"]})
    assert alias not in fake.aliases or not fake.indexes.get(fake.aliases.get(alias, ""), None)
    assert c.get("/api/ontology/objects/search", params={"q": "noa"}).json()["groups"][0]["engine"] == "lake"


def test_rebuild_and_routes_without_opensearch(setup, tmp_path: Path):
    c, app, fake, table = setup
    c.post("/api/ontology/publish", json={"type": CUSTOMER})
    _wait(app)
    assert c.post("/api/ontology/index/Customer/rebuild").json()["kind"] == "full"
    assert _wait(app).state == "done"
    off = copy.deepcopy(CUSTOMER) | {"api_name": "Other", "index": False}
    c.post("/api/ontology/publish", json={"type": off})
    assert c.post("/api/ontology/index/Other/rebuild").status_code == 409
    app.state.indexer.backend_factory = lambda s: None
    assert c.get("/api/ontology/index").json()["configured"] is False
    assert c.post("/api/ontology/index/Customer/rebuild").status_code == 409
    assert c.get("/api/ontology/objects/search", params={"q": "dana"}).json()["groups"][0]["engine"] == "lake"


def test_the_watcher_respects_cancel_and_waits_after_a_failure(setup):
    c, app, fake, table = setup
    from prooflix.search_index import Job

    key = search_index.state_key(app.state.workspace.root, "Customer")
    c.post("/api/ontology/publish", json={"type": CUSTOMER})
    _wait(app)
    fake.state.clear()  # as if the index were never built
    app.state.indexer.jobs[key] = Job(type="Customer", kind="full", state="cancelled")
    app.state.indexer.tick(app)
    assert app.state.indexer.jobs[key].state == "cancelled"  # not restarted
    app.state.indexer.jobs[key] = Job(type="Customer", kind="full", state="failed", finished=search_index._now())
    app.state.indexer.tick(app)
    assert app.state.indexer.jobs[key].state == "failed"  # not retried yet
    assert c.post("/api/ontology/index/Customer/rebuild").status_code == 200  # a person can always rebuild
    assert _wait(app).state == "done"

