import pytest

from prooflix.pipelines.errors import TemplateError
from prooflix.pipelines.templating import iter_references, resolve

SCOPE = {
    "params": {"n": 3, "name": "orders", "items": [1, 2]},
    "tasks": {"a": {"output": {"path": "x.json", "rows": [{"id": 7}]}}},
    "run": {"id": "r1", "pipeline": "p"},
}


def test_full_reference_keeps_type():
    assert resolve("${params.n}", SCOPE) == 3
    assert resolve("${params.items}", SCOPE) == [1, 2]
    assert resolve("${tasks.a.output.rows.0.id}", SCOPE) == 7


def test_embedded_reference_is_interpolated():
    assert resolve("file ${tasks.a.output.path} for ${params.name}", SCOPE) == "file x.json for orders"
    assert resolve("items=${params.items}", SCOPE) == "items=[1, 2]"


def test_nested_structures():
    assert resolve({"a": ["${params.n}", {"b": "${run.id}"}]}, SCOPE) == {"a": [3, {"b": "r1"}]}


def test_other_dollar_braces_untouched():
    assert resolve("echo ${HOME} $USER", SCOPE) == "echo ${HOME} $USER"


def test_missing_reference_raises():
    with pytest.raises(TemplateError, match="missing"):
        resolve("${params.missing}", SCOPE)


def test_iter_references():
    refs = list(iter_references({"x": "${params.n} ${tasks.a.output.path}", "y": ["${run.id}"]}))
    assert refs == [("params", "n"), ("tasks", "a", "output", "path"), ("run", "id")]
