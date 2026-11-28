"""Platform tasks: generic Spark tasks that ship with Prooflix, so every workspace has them.

Pipelines call them like workspace code, by entrypoint (``prooflix.tasks.<module>:<function>``).
They hold no business logic: what they do comes from their parameters (a connection and tables
to copy, a link's SQL).

- ``prooflix.tasks.jdbc_ingest:run``: copies relational database tables into bronze (the jobs of
  the Ingestion tab).
- ``prooflix.tasks.link_tables:build``: builds the table of a computed link from its Spark SQL
  (the Object Model's computed links).

Only the functions in ``PLATFORM_TASKS`` can be called (principle 14: besides workspace code, a
task runs only these vetted functions).

**The workspace runtime contract.** Spark's settings (master, packages, Unity Catalog, the
lakehouse folder) belong to the workspace, and every task of a workspace shares one Spark session.
So platform tasks use the workspace's runtime, from its ``src/``, through ``workspace_runtime()``:

    runtime.spark_session.get_spark(ctx)                     the shared SparkSession
    runtime.catalog.tenant_catalog(ctx, schemas, catalog)    a catalog; .table(schema, name) -> TableRef
    infra.materialization.ensure_table / overwrite / table_exists

A workspace made from Prooflix's template has them (``src/runtime/spark_session.py`` is checked
before a pipeline calling a platform task is written). The executor puts the running project's
``src/`` first on the import path before it calls a platform task.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace

PLATFORM_TASKS = frozenset({
    "prooflix.tasks.jdbc_ingest:run",
    "prooflix.tasks.link_tables:build",
})
# pipelines written before these tasks moved here still run them
LEGACY_ENTRYPOINTS = {
    "bronze.jdbc_ingest:run": "prooflix.tasks.jdbc_ingest:run",
    "gold.link_tables:build": "prooflix.tasks.link_tables:build",
}
RUNTIME_MODULE = Path("src") / "runtime" / "spark_session.py"  # the contract's marker in a project
WORKSPACE_PACKAGES = ("runtime", "infra")


def is_platform(entrypoint: str) -> bool:
    return entrypoint in PLATFORM_TASKS


def runtime_project(ws) -> Path | None:
    """The workspace project whose src/ has the runtime platform tasks need (pipelines go there)."""
    return next((p for p in ws.projects() if (p / RUNTIME_MODULE).is_file()), None)


def workspace_runtime() -> SimpleNamespace:
    """The running workspace's Spark runtime (see the contract above)."""
    try:
        spark_session = importlib.import_module("runtime.spark_session")
        catalog = importlib.import_module("runtime.catalog")
        materialization = importlib.import_module("infra.materialization")
    except ImportError as e:
        raise RuntimeError(
            f"this workspace has no Spark runtime for platform tasks ({e}): it needs src/runtime/spark_session.py, "
            "src/runtime/catalog.py and src/infra/materialization.py"
        ) from None
    return SimpleNamespace(
        get_spark=spark_session.get_spark,
        tenant_catalog=catalog.tenant_catalog,
        ensure_table=materialization.ensure_table,
        overwrite=materialization.overwrite,
        table_exists=materialization.table_exists,
    )
