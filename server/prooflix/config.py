"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# server/prooflix/config.py -> repository root is two levels above the package.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKSPACE = REPO_ROOT / "workspace"
DEFAULT_CLIENT_DIST = REPO_ROOT / "client" / "dist"


@dataclass(frozen=True)
class Settings:
    """Server settings.

    Environment variables:
      PROOFLIX_WORKSPACE   workspace root (contains ``pipelines/`` and ``src/``)
      PROOFLIX_MAX_DEPTH   maximum sub-pipeline nesting depth (default 10)
      PROOFLIX_CORS        comma-separated allowed browser origins
    """

    workspace: Path = DEFAULT_WORKSPACE
    max_depth: int = 10
    cors_origins: tuple[str, ...] = field(
        default=("http://localhost:5173", "http://127.0.0.1:5173")
    )
    client_dist: Path = DEFAULT_CLIENT_DIST

    @property
    def pipelines_dir(self) -> Path:
        return self.workspace / "pipelines"

    @property
    def state_dir(self) -> Path:
        return self.workspace / ".prooflix"

    @property
    def runs_dir(self) -> Path:
        return self.state_dir / "runs"

    @classmethod
    def from_env(cls) -> "Settings":
        kwargs: dict = {}
        if ws := os.environ.get("PROOFLIX_WORKSPACE"):
            kwargs["workspace"] = Path(ws).expanduser().resolve()
        if depth := os.environ.get("PROOFLIX_MAX_DEPTH"):
            kwargs["max_depth"] = int(depth)
        if cors := os.environ.get("PROOFLIX_CORS"):
            kwargs["cors_origins"] = tuple(o.strip() for o in cors.split(",") if o.strip())
        return cls(**kwargs)
