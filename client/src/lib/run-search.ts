import type { Run } from "@/lib/types"
import { formatDateTime } from "@/lib/utils"

const TRIGGER_WORDS: Record<string, string> = {
  schedule: "scheduled schedule",
  pipeline: "sub-pipeline subpipeline child",
  manual: "manual",
}

/** Everything a run can be found by, lowercase. */
function searchText(run: Run): string {
  const trigger = run.trigger ?? (run.parent_run_id ? "pipeline" : "manual")
  return [
    run.id,
    run.pipeline,
    run.pipeline_name ?? "",
    run.status,
    TRIGGER_WORDS[trigger] ?? trigger,
    formatDateTime(run.started_at ?? run.created_at),
    (run.started_at ?? run.created_at).slice(0, 10), // 2026-11-10
    run.error ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

/**
 * Runs matching a search. Commas separate alternatives (a run matches if any
 * alternative does), and within one alternative every word must appear:
 *   "e2e failed"          failed runs of E2E
 *   "e8d93, 178a9"        those two runs
 *   "scheduled, failed"   scheduled runs and failed runs
 */
export function searchRuns(runs: Run[] | undefined, query: string): Run[] | undefined {
  const alternatives = query
    .toLowerCase()
    .split(",")
    .map((alt) => alt.split(/\s+/).filter(Boolean))
    .filter((words) => words.length)
  if (!runs || !alternatives.length) return runs
  return runs.filter((run) => {
    const text = searchText(run)
    return alternatives.some((words) => words.every((w) => text.includes(w)))
  })
}
