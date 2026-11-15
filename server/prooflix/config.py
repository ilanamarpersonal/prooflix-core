"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# server/prooflix/config.py -> repository root is two levels above the package.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKSPACES = REPO_ROOT / "workspaces"
DEFAULT_CLIENT_DIST = REPO_ROOT / "client" / "dist"


@dataclass(frozen=True)
class Settings:
    """Server settings.

    Environment variables:
      PROOFLIX_WORKSPACES  folder of workspaces: each sub-folder with ``pipelines/``
                           is a workspace (default <repo>/workspaces)
      PROOFLIX_WORKSPACE   default workspace (default: the first one in PROOFLIX_WORKSPACES)
      PROOFLIX_MAX_DEPTH   maximum sub-pipeline nesting depth (default 10)
      PROOFLIX_CORS        comma-separated allowed browser origins
      PROOFLIX_CATALOG     folder holding catalog schemas that are not part of a
                           project (default: a "catalog" folder next to the workspaces folder)
      PROOFLIX_SCHEDULER   "0" turns off running pipelines on their schedules (default on)
      PROOFLIX_HOME        folder for server-wide state: the list of workspaces and
                           which one is active (default ~/.prooflix)
      PROOFLIX_SOURCE_DATA default source data folder (the raw files pipelines read)
                           for every workspace: its source/ links there
      PROOFLIX_DATA_LAKE   default data lake folder (what pipelines build: bronze,
                           gold, checkpoints) for every workspace: its data/ links there
                           (default for both: the workspace's own folder; a workspace
                           can choose its own, see linked_folders.py)

    ``workspace`` is the default workspace; ``None`` means the first one in
    ``workspaces_root``. The one the server uses is the active workspace chosen
    in the web client, when it still exists (see ``workspaces.py``).
    """

    workspace: Path | None = None
    workspaces_root: Path | None = None  # None: no folder of workspaces (tests)
    max_depth: int = 10
    scheduler: bool = True  # run pipelines on their cron schedules
    cors_origins: tuple[str, ...] = field(
        default=("http://localhost:5173", "http://127.0.0.1:5173")
    )
    client_dist: Path = DEFAULT_CLIENT_DIST
    catalog: Path | None = None  # None: <workspace>/../catalog
    home: Path | None = None  # None: the workspace list is kept in memory only
    source_data: Path | None = None  # None: each workspace's own source/ folder
    data_lake: Path | None = None  # None: each workspace's own data/ folder

    @property
    def folder_defaults(self) -> dict:
        """Server defaults for the linked folders (see linked_folders.py)."""
        return {"source_data": self.source_data, "data_lake": self.data_lake}

    @property
    def workspaces_file(self) -> Path | None:
        return self.home / "workspaces.json" if self.home is not None else None

    @property
    def catalog_dir(self) -> Path:
        if self.catalog is not None:
            return self.catalog
        if self.workspaces_root is not None:
            return self.workspaces_root.parent / "catalog"
        return self._workspace.parent / "catalog"

    @property
    def _workspace(self) -> Path:
        if self.workspace is None:
            raise RuntimeError("No workspace chosen yet (see WorkspaceRegistry)")
        return self.workspace

    @property
    def pipelines_dir(self) -> Path:
        return self._workspace / "pipelines"

    @property
    def state_dir(self) -> Path:
        return self._workspace / ".prooflix"

    @property
    def runs_dir(self) -> Path:
        return self.state_dir / "runs"

    @classmethod
    def from_env(cls) -> "Settings":
        kwargs: dict = {
            "home": Path(os.environ.get("PROOFLIX_HOME") or "~/.prooflix").expanduser().resolve(),
            "workspaces_root": Path(os.environ.get("PROOFLIX_WORKSPACES") or DEFAULT_WORKSPACES)
            .expanduser()
            .resolve(),
        }
        if ws := os.environ.get("PROOFLIX_WORKSPACE"):
            kwargs["workspace"] = Path(ws).expanduser().resolve()
        if catalog := os.environ.get("PROOFLIX_CATALOG"):
            kwargs["catalog"] = Path(catalog).expanduser().resolve()
        if (sched := os.environ.get("PROOFLIX_SCHEDULER")) is not None:
            kwargs["scheduler"] = sched.strip().lower() not in ("0", "false", "no", "off")
        if depth := os.environ.get("PROOFLIX_MAX_DEPTH"):
            kwargs["max_depth"] = int(depth)
        if source := os.environ.get("PROOFLIX_SOURCE_DATA"):
            kwargs["source_data"] = Path(source).expanduser().resolve()
        if lake := os.environ.get("PROOFLIX_DATA_LAKE"):
            kwargs["data_lake"] = Path(lake).expanduser().resolve()
        if cors := os.environ.get("PROOFLIX_CORS"):
            kwargs["cors_origins"] = tuple(o.strip() for o in cors.split(",") if o.strip())
        return cls(**kwargs)
