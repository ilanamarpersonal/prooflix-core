import { useMemo } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDownToLine, History, Library, Play, Plus, SquareTerminal, Table2, Workflow } from "lucide-react"

import type { Command } from "@prooflix/ui/app/command-palette"
import type { UseCommands } from "@prooflix/ui/app/product-app"
import { api } from "@/lib/api"

/** IngestIQ's search commands: its pipelines, ingestion jobs, tables and recent runs, and actions on them. */
export const useIngestiqCommands: UseCommands = (sections) => {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const has = (id: string) => sections.some((s) => s.id === id)

  // fetched only while the palette is open, and only for tabs the user has
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: api.listPipelines, enabled: has("pipelines") })
  const runs = useQuery({
    queryKey: ["runs", { rootOnly: true, limit: 15 }],
    queryFn: () => api.listRuns({ rootOnly: true, limit: 15 }),
    enabled: has("pipelines"),
  })
  const jobs = useQuery({ queryKey: ["ingestion", "jobs"], queryFn: api.ingestionJobs, enabled: has("ingestion") })
  const tables = useQuery({
    queryKey: ["sql", "tables"],
    queryFn: api.sqlTables,
    enabled: has("sql") || has("catalog"),
  })

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    const go = (path: string, state?: unknown) => () => navigate(path, state ? { state } : undefined)
    if (has("pipelines"))
      out.push({ id: "new-pipeline", group: "Actions", label: "New pipeline", icon: Plus, run: go("/pipelines/new") })
    if (has("sql"))
      out.push({
        id: "new-query",
        group: "Actions",
        label: "New query",
        icon: SquareTerminal,
        keywords: "sql editor",
        run: go("/sql", { sql: "SELECT 1;", title: "New query" }),
      })

    for (const p of pipelines.data ?? []) {
      out.push({
        id: `open:${p.id}`,
        group: "Pipelines",
        label: p.name,
        hint: p.id,
        icon: Workflow,
        keywords: p.id,
        run: go(`/pipelines/${p.id}`),
      })
      // runs with the defaults, so not for a pipeline with a required parameter that has no default
      const needsValues = Object.values(p.parameter_specs).some(
        (s) => s.required && (s.default == null || s.default === ""),
      )
      if (p.valid && !needsValues)
        out.push({
          id: `run:${p.id}`,
          group: "Actions",
          label: `Run pipeline ${p.name}`,
          hint: "run",
          icon: Play,
          keywords: p.id,
          run: async () => {
            const run = await api.startRun(p.id, {})
            void qc.invalidateQueries({ queryKey: ["runs"] })
            navigate(`/runs/${run.id}`)
          },
        })
    }
    for (const j of jobs.data?.jobs ?? []) {
      out.push({
        id: `job:${j.id}`,
        group: "Ingestion jobs",
        label: j.name,
        hint: j.connection ?? "",
        icon: ArrowDownToLine,
        keywords: j.id,
        run: go("/ingestion"),
      })
      if (!j.errors.length)
        out.push({
          id: `runjob:${j.id}`,
          group: "Actions",
          label: `Run ingestion job ${j.name}`,
          hint: "run",
          icon: Play,
          keywords: `${j.id} ingest`,
          run: async () => {
            const run = await api.runJobForDates(j.id, null, null)
            void qc.invalidateQueries({ queryKey: ["runs"] })
            if (has("pipelines")) navigate(`/runs/${run.id}`)
            else navigate("/ingestion")
          },
        })
    }
    for (const t of tables.data ?? []) {
      if (has("catalog"))
        out.push({
          id: `table:${t.qualified}`,
          group: "Tables",
          label: t.qualified,
          hint: "open",
          icon: Library,
          keywords: `${t.schema} ${t.name} table`,
          run: go(`/catalog?table=${encodeURIComponent(`${t.schema}.${t.name}`)}`),
        })
      if (has("sql"))
        out.push({
          id: `query:${t.qualified}`,
          group: "Tables",
          label: `Query ${t.qualified}`,
          hint: "SQL",
          icon: Table2,
          keywords: `${t.schema} ${t.name} select`,
          run: go("/sql", { sql: `SELECT *\nFROM ${t.qualified}\nLIMIT 100;`, title: t.name }),
        })
    }
    for (const r of runs.data ?? []) {
      out.push({
        id: `runid:${r.id}`,
        group: "Recent runs",
        label: `${r.pipeline_name ?? r.pipeline} · ${r.id}`,
        hint: r.status.toLowerCase(),
        icon: History,
        keywords: `${r.pipeline} ${r.status}`,
        run: go(`/runs/${r.id}`),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, pipelines.data, runs.data, jobs.data, tables.data])

  return {
    commands,
    groups: ["Pipelines", "Ingestion jobs", "Tables", "Recent runs"],
    loading: pipelines.isLoading || jobs.isLoading || tables.isLoading,
  }
}
