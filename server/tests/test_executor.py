import asyncio

import pytest

from prooflix.engine import PipelineExecutor
from prooflix.pipelines import PipelineValidationError, Workspace
from prooflix.runs import RunStatus, RunStore

S, F, K, C = RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.SKIPPED, RunStatus.CANCELLED


def make_executor(ws: Workspace, **kw) -> tuple[PipelineExecutor, RunStore]:
    store = RunStore(ws.root / ".prooflix" / "runs")
    return PipelineExecutor(ws, store, **kw), store


def run(ws, pipeline, params=None, **kw):
    executor, store = make_executor(ws, **kw)
    result = asyncio.run(executor.run(pipeline, params))
    return result, store


def statuses(run_):
    return {k: t.status for k, t in run_.tasks.items()}


def test_sample_daily_orders_end_to_end(sample_workspace):
    result, store = run(Workspace(sample_workspace), "daily_orders", {"run_date": "2026-11-07"})
    assert result.status == S, result.error
    assert result.outputs == {"orders": 8, "rejected": 2, "total_revenue": 898.49}
    ingest_child = store.get(result.tasks["ingest"].child_run_id)
    assert ingest_child.parent_run_id == result.id
    assert ingest_child.root_run_id == result.id
    assert ingest_child.depth == 1
    assert ingest_child.parameters["run_date"] == "2026-11-07"
    tree = store.tree(result.id)
    assert [c["pipeline"] for c in tree["children"]] == ["ingest_orders", "transform_orders"]
    assert (sample_workspace / "data/output/2026-11-07/summary.json").is_file()


def test_outputs_flow_between_tasks_and_sub_pipelines(ws_factory):
    ws_factory.add("child", """
        parameters: {x: 0}
        tasks:
          - {key: double, type: python, entrypoint: "testtasks:add", parameters: {a: "${params.x}", b: "${params.x}"}}
        outputs:
          value: ${tasks.double.output}
    """)
    ws_factory.add("grandparent", """
        tasks:
          - {key: p, type: pipeline, pipeline: parent}
        outputs:
          final: ${tasks.p.output.result}
    """)
    ws_factory.add("parent", """
        parameters: {start: 5}
        tasks:
          - {key: first, type: pipeline, pipeline: child, parameters: {x: "${params.start}"}}
          - key: second
            type: pipeline
            pipeline: child
            depends_on: [first]
            parameters: {x: "${tasks.first.output.value}"}
        outputs:
          result: ${tasks.second.output.value}
    """)
    result, store = run(ws_factory.workspace, "grandparent")
    assert result.status == S, result.error
    assert result.outputs == {"final": 20}
    parent = store.get(result.tasks["p"].child_run_id)
    assert parent.depth == 1
    second = store.get(parent.tasks["second"].child_run_id)
    assert second.depth == 2 and second.root_run_id == result.id
    assert second.parameters == {"x": 10}


def test_failure_skips_downstream_but_runs_independent_branches(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: bad, type: python, entrypoint: "testtasks:boom"}
          - {key: after_bad, type: shell, command: "true", depends_on: [bad]}
          - {key: after_after, type: shell, command: "true", depends_on: [after_bad]}
          - {key: independent, type: shell, command: "echo hi"}
    """)
    result, _ = run(ws_factory.workspace, "p")
    assert result.status == F
    assert statuses(result) == {"bad": F, "after_bad": K, "after_after": K, "independent": S}
    assert result.tasks["bad"].error == "RuntimeError: boom"
    assert result.error == "Task 'bad' failed: RuntimeError: boom"


def test_failing_sub_pipeline_fails_parent_task(ws_factory):
    ws_factory.add("child", "tasks: [{key: x, type: shell, command: 'exit 3'}]\n")
    ws_factory.add("p", """
        tasks:
          - {key: sub, type: pipeline, pipeline: child}
          - {key: next, type: shell, command: "true", depends_on: [sub]}
    """)
    result, store = run(ws_factory.workspace, "p")
    assert statuses(result) == {"sub": F, "next": K}
    assert "Command exited with code 3" in result.tasks["sub"].error
    assert store.get(result.tasks["sub"].child_run_id).status == F


def test_retries(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: f, type: python, entrypoint: "testtasks:flaky", retries: 2, parameters: {fail_times: 2}}
    """)
    result, _ = run(ws_factory.workspace, "p")
    task = result.tasks["f"]
    assert task.status == S and task.attempt == 3 and task.output == {"calls": 3}


def test_timeout(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: s, type: python, entrypoint: "testtasks:async_sleep", timeout_seconds: 0.1, parameters: {seconds: 5}}
    """)
    result, _ = run(ws_factory.workspace, "p")
    assert result.tasks["s"].status == F
    assert result.tasks["s"].error == "Timed out after 0.1s"


def test_shell_output_logs_and_env(ws_factory):
    ws_factory.add("p", """
        parameters: {name: prooflix}
        tasks:
          - key: sh
            type: shell
            command: 'echo "hello $GREETING_TARGET from ${run.pipeline}"'
            env: {GREETING_TARGET: "${params.name}"}
    """)
    result, _ = run(ws_factory.workspace, "p")
    task = result.tasks["sh"]
    assert task.status == S
    assert task.output == {"exit_code": 0, "stdout": "hello prooflix from p"}
    assert any("hello prooflix from p" in line for line in task.logs)


def test_python_ctx_log_and_kwargs(ws_factory):
    ws_factory.add("p", """
        tasks:
          - {key: e, type: python, entrypoint: "testtasks:echo", parameters: {a: 1, b: [2]}}
    """)
    result, _ = run(ws_factory.workspace, "p")
    assert result.tasks["e"].output == {"a": 1, "b": [2]}
    assert any("echo {'a': 1, 'b': [2]}" in line for line in result.tasks["e"].logs)


def test_parameter_overrides_and_unknown_parameters(ws_factory):
    ws_factory.add("p", """
        parameters: {a: 1, b: 2}
        tasks:
          - {key: s, type: python, entrypoint: "testtasks:add", parameters: {a: "${params.a}", b: "${params.b}"}}
        outputs: {sum: "${tasks.s.output}"}
    """)
    result, _ = run(ws_factory.workspace, "p", {"b": 40})
    assert result.outputs == {"sum": 41}
    assert result.parameters == {"a": 1, "b": 40}
    executor, _ = make_executor(ws_factory.workspace)
    with pytest.raises(PipelineValidationError, match="Unknown parameters: zzz"):
        executor.prepare("p", {"zzz": 1})


def test_invalid_pipeline_cannot_run(ws_factory):
    ws_factory.add("p", "tasks: [{key: a, type: pipeline, pipeline: ghost}]\n")
    executor, _ = make_executor(ws_factory.workspace)
    with pytest.raises(PipelineValidationError, match="unknown pipeline 'ghost'"):
        executor.prepare("p")


def test_max_depth(ws_factory):
    ws_factory.add("leaf", "tasks: [{key: t, type: shell, command: 'true'}]\n")
    ws_factory.add("mid", "tasks: [{key: t, type: pipeline, pipeline: leaf}]\n")
    ws_factory.add("top", "tasks: [{key: t, type: pipeline, pipeline: mid}]\n")
    result, _ = run(ws_factory.workspace, "top", max_depth=1)
    assert result.status == F
    assert "Maximum sub-pipeline depth (1) exceeded" in result.error


def test_cancel_propagates_to_child_runs(ws_factory):
    ws_factory.add("child", "tasks: [{key: wait, type: shell, command: 'sleep 30'}]\n")
    ws_factory.add("p", """
        tasks:
          - {key: sub, type: pipeline, pipeline: child}
          - {key: after, type: shell, command: "true", depends_on: [sub]}
    """)
    executor, store = make_executor(ws_factory.workspace)

    async def scenario():
        started = executor.start("p")
        for _ in range(100):
            await asyncio.sleep(0.02)
            child_id = store.get(started.id).tasks["sub"].child_run_id
            if child_id and store.get(child_id).tasks["wait"].status == RunStatus.RUNNING:
                break
        executor.cancel(started.id)
        await asyncio.sleep(0.2)
        return store.get(started.id), store.get(child_id)

    parent, child = asyncio.run(scenario())
    assert parent.status == C
    assert statuses(parent) == {"sub": C, "after": C}
    assert child.status == C and child.tasks["wait"].status == C


def test_cancelling_only_the_child_fails_the_parent_task(ws_factory):
    ws_factory.add("child", "tasks: [{key: wait, type: shell, command: 'sleep 30'}]\n")
    ws_factory.add("p", "tasks: [{key: sub, type: pipeline, pipeline: child}]\n")
    executor, store = make_executor(ws_factory.workspace)

    async def scenario():
        started = executor.start("p")
        child_id = None
        for _ in range(100):
            await asyncio.sleep(0.02)
            child_id = store.get(started.id).tasks["sub"].child_run_id
            if child_id and executor.is_active(child_id):
                break
        executor.cancel(child_id)
        await asyncio.sleep(0.2)
        return store.get(started.id), store.get(child_id)

    parent, child = asyncio.run(scenario())
    assert child.status == C
    assert parent.status == F
    assert "was cancelled" in parent.tasks["sub"].error


def test_runs_persist_and_interrupted_runs_are_recovered(ws_factory):
    ws_factory.add("p", "tasks: [{key: t, type: shell, command: 'true'}]\n")
    result, store = run(ws_factory.workspace, "p")
    reloaded = RunStore(ws_factory.root / ".prooflix" / "runs")
    assert reloaded.get(result.id).status == S

    stuck = reloaded.get(result.id)
    stuck.status = RunStatus.RUNNING
    reloaded.save(stuck)
    again = RunStore(ws_factory.root / ".prooflix" / "runs")
    assert again.recover_interrupted() == 1
    assert again.get(result.id).status == F
