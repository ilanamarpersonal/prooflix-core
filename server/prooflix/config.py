"""Runtime settings, read from environment variables."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# server/prooflix/config.py -> repository root is two levels above the package.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKSPACES = REPO_ROOT / "workspaces"
DEFAULT_CLIENT_DIST = REPO_ROOT / "client" / "dist"
PARAMETERS_FILE = "parameters.json"  # in PROOFLIX_HOME: values edited in the System tab


def load_saved_parameters(home: Path | None) -> dict[str, str]:
    """Parameter values edited in the web client ({"PROOFLIX_MAX_DEPTH": "4", ...})."""
    if home is None:
        return {}
    try:
        data = json.loads((home / PARAMETERS_FILE).read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)} if isinstance(data, dict) else {}


def save_parameters(home: Path, values: dict[str, str]) -> None:
    home.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=home, prefix=f".{PARAMETERS_FILE}.")
    with os.fdopen(fd, "w") as f:
        json.dump(dict(sorted(values.items())), f, indent=2)
    os.replace(tmp, home / PARAMETERS_FILE)


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

    A value edited in the System tab is saved to ``PROOFLIX_HOME/parameters.json``
    and wins over the environment variable from the next start on.

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
    # the values from PROOFLIX_HOME/parameters.json this server started with
    saved_parameters: dict[str, str] = field(default_factory=dict, compare=False)

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
        home = Path(os.environ.get("PROOFLIX_HOME") or "~/.prooflix").expanduser().resolve()
        saved = load_saved_parameters(home)
        # a value saved in the System tab wins over the environment variable
        env = {**os.environ, **saved}
        kwargs: dict = {
            "home": home,
            "saved_parameters": saved,
            "workspaces_root": Path(env.get("PROOFLIX_WORKSPACES") or DEFAULT_WORKSPACES)
            .expanduser()
            .resolve(),
        }
        if ws := env.get("PROOFLIX_WORKSPACE"):
            kwargs["workspace"] = Path(ws).expanduser().resolve()
        if catalog := env.get("PROOFLIX_CATALOG"):
            kwargs["catalog"] = Path(catalog).expanduser().resolve()
        if (sched := env.get("PROOFLIX_SCHEDULER")) is not None:
            kwargs["scheduler"] = parse_flag(sched)
        if depth := env.get("PROOFLIX_MAX_DEPTH"):
            kwargs["max_depth"] = int(depth)
        if source := env.get("PROOFLIX_SOURCE_DATA"):
            kwargs["source_data"] = Path(source).expanduser().resolve()
        if lake := env.get("PROOFLIX_DATA_LAKE"):
            kwargs["data_lake"] = Path(lake).expanduser().resolve()
        if cors := env.get("PROOFLIX_CORS"):
            kwargs["cors_origins"] = tuple(o.strip() for o in cors.split(",") if o.strip())
        return cls(**kwargs)


def parse_flag(value: str) -> bool:
    return value.strip().lower() not in ("0", "false", "no", "off")
