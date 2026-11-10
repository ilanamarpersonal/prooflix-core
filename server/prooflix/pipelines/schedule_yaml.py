"""Set or remove a pipeline's ``schedule:`` block in its YAML text.

Only that block changes: every other line, comments included, stays as it is, so a
schedule set from the UI looks like one written by hand.
"""

from __future__ import annotations

import json
import re

_TOP_LEVEL_KEY = re.compile(r"^[A-Za-z_][\w-]*\s*:")


def _block_range(lines: list[str]) -> tuple[int, int] | None:
    """[start, end) of the top-level ``schedule:`` block (its indented lines included)."""
    for i, line in enumerate(lines):
        if re.match(r"^schedule\s*:", line):
            end = i + 1
            while end < len(lines) and (lines[end].startswith((" ", "\t")) or not lines[end].strip()):
                end += 1
            while end > i + 1 and not lines[end - 1].strip():  # leave blank lines after it alone
                end -= 1
            return i, end
    return None


def render_schedule(cron: str, timezone: str, enabled: bool) -> list[str]:
    return [
        "schedule:",
        f"  cron: {json.dumps(cron)}",  # quoted: "*" would otherwise be YAML syntax
        f"  timezone: {json.dumps(timezone) if not re.fullmatch(r'[A-Za-z0-9_/+-]+', timezone) else timezone}",
        f"  enabled: {'true' if enabled else 'false'}",
    ]


def set_schedule(source: str, schedule: tuple[str, str, bool] | None) -> str:
    """The YAML with its schedule block replaced, added (before ``tasks:``) or, with
    ``schedule=None``, removed."""
    lines = source.splitlines()
    found = _block_range(lines)
    new = render_schedule(*schedule) if schedule is not None else []
    if found is not None:
        start, end = found
        if not new:
            # drop the block and a comment line right above it that described it
            if start > 0 and lines[start - 1].lstrip().startswith("#") and "schedule" in lines[start - 1].lower():
                start -= 1
            if start > 0 and not lines[start - 1].strip() and (end >= len(lines) or not lines[end].strip()):
                start -= 1  # don't leave two blank lines behind
        lines[start:end] = new
    elif new:
        tasks = next((i for i, line in enumerate(lines) if re.match(r"^tasks\s*:", line)), None)
        if tasks is None:
            lines = lines + ([""] if lines and lines[-1].strip() else []) + new
        else:
            # above tasks:, and above the comment lines that introduce it
            at = tasks
            while at > 0 and lines[at - 1].lstrip().startswith("#"):
                at -= 1
            lines[at:at] = new + [""]
    text = "\n".join(lines)
    return text + "\n" if source.endswith("\n") or not source else text
