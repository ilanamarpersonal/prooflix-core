from prooflix.pipelines.graph import find_cycle, topological_order


def errors_of(ws_factory, pipeline_id="p"):
    return ws_factory.workspace.load_all()[pipeline_id].errors


def test_sample_workspace_is_valid(sample_workspace):
    from prooflix.pipelines import Workspace

    defs = Workspace(sample_workspace).load_all()
    assert set(defs) >= {"daily_orders", "ingest_orders", "transform_orders", "hello_world"}
    assert all(d.valid for d in defs.values()), {k: d.errors for k, d in defs.items()}


def test_yaml_syntax_error(ws_factory):
    ws_factory.add("p", "tasks: [\n")
    assert any("YAML syntax error" in e for e in errors_of(ws_factory))


def test_schema_errors(ws_factory):
    ws_factory.add("p", """
        tasks:
          - key: a
            type: python
            entrypoint: not-valid
          - key: b
            type: rocket
    """)
    errs = errors_of(ws_factory)
    assert any("entrypoint" in e for e in errs)
    assert any("tasks.1" in e for e in errs)


def test_duplicate_keys_unknown_dep_and_cycle(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: a, type: shell, command: "true", depends_on: [c]}
          - {key: a, type: shell, command: "true"}
          - {key: b, type: shell, command: "true", depends_on: [missing]}
          - {key: c, type: shell, command: "true", depends_on: [d]}
          - {key: d, type: shell, command: "true", depends_on: [c]}
    """)
    errs = errors_of(ws_factory)
    assert "Duplicate task key 'a'" in errs
    assert "Task 'b' depends on unknown task 'missing'" in errs
    assert any(e.startswith("Task dependency cycle") for e in errs)


def test_reference_checks(ws_factory):
    ws_factory.add("p", """
        parameters: {x: 1}
        tasks:
          - {key: a, type: python, entrypoint: "testtasks:add", parameters: {a: "${params.y}", b: 1}}
          - {key: b, type: python, entrypoint: "testtasks:add", parameters: {a: "${tasks.a.output}", b: 1}}
          - {key: c, type: shell, command: "echo ${tasks.nope.output}", depends_on: [a]}
        outputs:
          bad: ${tasks.a.result}
    """)
    errs = errors_of(ws_factory)
    assert any("undeclared parameter 'y'" in e for e in errs)
    assert any("uses the output of 'a' but does not depend on it" in e for e in errs)
    assert any("unknown task 'nope'" in e for e in errs)
    assert any("must look like ${tasks.<key>.output" in e for e in errs)


def test_unknown_and_invalid_sub_pipelines(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: a, type: pipeline, pipeline: ghost}
          - {key: b, type: pipeline, pipeline: broken}
    """)
    ws_factory.add("broken", "tasks: []\n")
    errs = errors_of(ws_factory)
    assert "Task 'a' calls unknown pipeline 'ghost'" in errs
    assert "Task 'b' calls pipeline 'broken', which is invalid" in errs


def test_undeclared_sub_pipeline_parameters(ws_factory):
    ws_factory.add("child", """
        parameters: {x: 1}
        tasks: [{key: t, type: shell, command: "true"}]
    """)
    ws_factory.add("p", """
        tasks:
          - {key: a, type: pipeline, pipeline: child, parameters: {x: 2, y: 3}}
    """)
    assert errors_of(ws_factory) == ["Task 'a' passes parameters not declared by 'child': y"]


def test_recursive_sub_pipelines(ws_factory):
    ws_factory.add("a", "tasks: [{key: t, type: pipeline, pipeline: b}]\n")
    ws_factory.add("b", "tasks: [{key: t, type: pipeline, pipeline: c}]\n")
    ws_factory.add("c", "tasks: [{key: t, type: pipeline, pipeline: a}]\n")
    ws_factory.add("self", "tasks: [{key: t, type: pipeline, pipeline: self}]\n")
    defs = ws_factory.workspace.load_all()
    assert "Recursive sub-pipeline call: a -> b -> c -> a" in defs["a"].errors
    assert "Recursive sub-pipeline call: self -> self" in defs["self"].errors


def test_validate_source_uses_unsaved_override(ws_factory):
    ws_factory.add("child", "tasks: [{key: t, type: shell, command: 'true'}]\n")
    ws = ws_factory.workspace
    assert ws.validate_source("p", "tasks: [{key: x, type: pipeline, pipeline: child}]") == []
    errs = ws.validate_source("child", "tasks: [{key: x, type: pipeline, pipeline: child}]")
    assert errs == ["Recursive sub-pipeline call: child -> child"]


def test_graph_helpers():
    assert topological_order({"c": ["b"], "b": ["a"], "a": []}) == ["a", "b", "c"]
    assert find_cycle({"a": ["b"], "b": ["a"]}) == ["a", "b", "a"]
    assert find_cycle({"a": ["b"], "b": []}) is None
