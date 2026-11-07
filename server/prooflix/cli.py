"""Command line interface: ``prooflix serve | validate | run``."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from .config import DEFAULT_WORKSPACE, Settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prooflix", description=__doc__)
    parser.add_argument(
        "--workspace",
        type=Path,
        default=None,
        help=f"workspace directory (default: $PROOFLIX_WORKSPACE or {DEFAULT_WORKSPACE})",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="start the API server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true", help="auto-reload on code changes")

    sub.add_parser("validate", help="validate every pipeline in the workspace")

    run = sub.add_parser("run", help="run a pipeline and wait for it to finish")
    run.add_argument("pipeline")
    run.add_argument(
        "-p", "--param", action="append", default=[], metavar="KEY=VALUE",
        help="parameter override; VALUE is parsed as JSON, else used as text (repeatable)",
    )

    args = parser.parse_args(argv)
    if args.workspace:
        os.environ["PROOFLIX_WORKSPACE"] = str(args.workspace.expanduser().resolve())
    settings = Settings.from_env()

    if args.command == "serve":
        return _serve(args)
    if args.command == "validate":
        return _validate(settings)
    return asyncio.run(_run(settings, args.pipeline, args.param))


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run(
        "prooflix.main:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        reload_dirs=[str(Path(__file__).parent)] if args.reload else None,
    )
    return 0


def _validate(settings: Settings) -> int:
    from .pipelines import Workspace

    defs = Workspace(settings.workspace).load_all()
    if not defs:
        print(f"No pipelines found in {settings.pipelines_dir}")
        return 1
    ok = True
    for pid, d in defs.items():
        mark = "ok     " if d.valid else "INVALID"
        print(f"{mark} {pid}")
        for err in d.errors:
            print(f"        - {err}")
        ok &= d.valid
    return 0 if ok else 1


async def _run(settings: Settings, pipeline_id: str, raw_params: list[str]) -> int:
    from .engine import PipelineExecutor
    from .pipelines import PipelineError, Workspace
    from .runs import RunStatus, RunStore

    params = {}
    for item in raw_params:
        key, sep, value = item.partition("=")
        if not sep:
            print(f"Invalid parameter '{item}', expected KEY=VALUE", file=sys.stderr)
            return 2
        params[key] = _parse_value(value)

    store = RunStore(settings.runs_dir)
    executor = PipelineExecutor(Workspace(settings.workspace), store, max_depth=settings.max_depth)
    try:
        run = await executor.run(pipeline_id, params)
    except PipelineError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    _print_tree(store, run.id, indent=0)
    if run.outputs:
        print("outputs:", json.dumps(run.outputs, indent=2))
    return 0 if run.status == RunStatus.SUCCEEDED else 1


def _parse_value(value: str):
    """JSON values (numbers, true/false, lists, objects) keep their type; anything else is text."""
    try:
        return json.loads(value)
    except ValueError:
        return value


def _print_tree(store, run_id: str, indent: int) -> None:
    run = store.get(run_id)
    pad = "  " * indent
    print(f"{pad}{run.pipeline} [{run.id}] {run.status.value}")
    for task in run.tasks.values():
        line = f"{pad}  - {task.key} ({task.type}) {task.status.value}"
        if task.error:
            line += f": {task.error}"
        print(line)
        if task.child_run_id:
            _print_tree(store, task.child_run_id, indent + 2)


if __name__ == "__main__":
    raise SystemExit(main())
