"""Small graph helpers shared by task DAGs and the pipeline call graph."""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable, Mapping


def find_cycle(edges: Mapping[str, Iterable[str]]) -> list[str] | None:
    """Return one cycle as ``[a, b, ..., a]`` or ``None`` if the graph is acyclic.

    ``edges`` maps a node to the nodes it points at. Targets that are not keys
    are treated as leaf nodes.
    """
    white, grey, black = 0, 1, 2
    color: dict[str, int] = {n: white for n in edges}
    stack: list[str] = []

    def visit(node: str) -> list[str] | None:
        color[node] = grey
        stack.append(node)
        for nxt in edges.get(node, ()):
            state = color.get(nxt, white)
            if state == grey:
                return stack[stack.index(nxt):] + [nxt]
            if state == white and nxt in edges:
                found = visit(nxt)
                if found:
                    return found
        stack.pop()
        color[node] = black
        return None

    for node in edges:
        if color[node] == white:
            found = visit(node)
            if found:
                return found
    return None


def topological_order(deps: Mapping[str, Iterable[str]]) -> list[str]:
    """Order nodes so every node comes after its dependencies (stable by input order).

    ``deps`` maps a node to the nodes it depends on. Raises ``ValueError`` on a cycle.
    """
    remaining = {n: set(d) for n, d in deps.items()}
    order: list[str] = []
    ready = deque(n for n, d in remaining.items() if not d)
    while ready:
        node = ready.popleft()
        order.append(node)
        for other, d in remaining.items():
            if node in d:
                d.discard(node)
                if not d and other not in order and other not in ready:
                    ready.append(other)
    if len(order) != len(remaining):
        raise ValueError("graph contains a cycle")
    return order


def ancestors(deps: Mapping[str, Iterable[str]]) -> dict[str, set[str]]:
    """Map each node to all of its transitive dependencies."""
    result: dict[str, set[str]] = {}

    def collect(node: str, trail: frozenset[str]) -> set[str]:
        if node in result:
            return result[node]
        found: set[str] = set()
        for dep in deps.get(node, ()):
            if dep in trail:
                continue  # cycles are reported elsewhere
            found.add(dep)
            found |= collect(dep, trail | {dep})
        result[node] = found
        return found

    for n in deps:
        collect(n, frozenset({n}))
    return result


def shortest_path(edges: Mapping[str, Iterable[str]], start: str, target: str) -> list[str] | None:
    """Breadth-first path from ``start`` to ``target`` (both included)."""
    queue = deque([[start]])
    seen = {start}
    while queue:
        path = queue.popleft()
        if path[-1] == target:
            return path
        for nxt in edges.get(path[-1], ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(path + [nxt])
    return None
