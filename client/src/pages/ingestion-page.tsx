import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import {
  AlarmClock,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Pencil,
  Play,
  Plug,
  Plus,
  Trash2,
  X,
  XCircle,
} from "lucide-react"

import { DbIcon } from "@/components/db-icon"
import { ErrorAlert } from "@/components/error-alert"
import { Pager } from "@/components/pager"
import { activeRunsByPipeline } from "@/components/running-badge"
import { PageHeader } from "@/components/page-header"
import { StatusBadge } from "@/components/status-badge"
import { StopButton } from "@/components/stop-button"
import { TriggerFields, useTrigger } from "@/components/trigger-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useQueryClient } from "@tanstack/react-query"
import {
  api,
  useDbConnections,
  useDbKinds,
  useDeleteDbConnection,
  useDeleteIngestionJob,
  useIngestionJobs,
  useRuns,
  useSaveDbConnection,
  useSaveIngestionJob,
  useSourceTables,
  useStartRun,
} from "@/lib/api"
import { describeCron } from "@/lib/schedule"
import type { DbConnection, DbKind, IngestionJob, JobTable, SourceTable } from "@/lib/types"
import { TERMINAL_STATUSES } from "@/lib/types"
import { usePagination } from "@/lib/use-pagination"
import { cn, formatDateTime } from "@/lib/utils"

const selectClass =
  "border-input bg-background h-9 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
const NEW = "\u0000new"

/** Copy tables of relational databases into bronze, by hand or on a cron schedule. */
export function IngestionPage() {
  const [editingConnection, setEditingConnection] = useState<string | null>(null)
  const [editingJob, setEditingJob] = useState<string | null>(null)
  const jobs = useIngestionJobs()
  const connections = useDbConnections()
  const kindOf = (name: string | null) => connections.data?.find((c) => c.name === name)?.kind ?? ""
  const pager = usePagination(jobs.data?.jobs, 10)
  // every job's runs that are going, to skip them in Run all
  const runs = useRuns({ rootOnly: true, limit: 200 })
  const active = useMemo(() => activeRunsByPipeline(runs.data), [runs.data])
  // jobs ticked to run together (on any page)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const allJobs = jobs.data?.jobs ?? []
  const selectable = allJobs.filter((j) => !j.errors.length)
  const chosen = allJobs.filter((j) => selected.has(j.id))
  const allChosen = selectable.length > 0 && selectable.every((j) => selected.has(j.id))
  // jobs the date range panel will run (null: closed)
  const [rangeFor, setRangeFor] = useState<string[] | null>(null)
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div>
      <PageHeader
        title="Ingestion"
        description="Copy tables of Oracle, SQL Server, MySQL and PostgreSQL databases into the bronze layer. Define a connection, choose the tables, columns and the column that tells which rows are new, and run the job by hand or on a schedule."
        actions={
          <Button onClick={() => setEditingJob(NEW)} disabled={!connections.data?.length || editingJob !== null}>
            <Plus /> New ingestion job
          </Button>
        }
      />
      <div className="grid gap-4">
        <ConnectionsCard editing={editingConnection} setEditing={setEditingConnection} />

        {editingJob !== null && (
          <JobEditor
            key={editingJob}
            job={editingJob === NEW ? null : (jobs.data?.jobs.find((j) => j.id === editingJob) ?? null)}
            connections={connections.data ?? []}
            onDone={() => setEditingJob(null)}
          />
        )}

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
            <CardTitle className="flex-1 text-base">Ingestion jobs</CardTitle>
            {chosen.length > 0 && (
              <>
                <span className="text-muted-foreground text-sm">{chosen.length} selected</span>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <RunJobsButton jobs={chosen} active={active} label="Run selected" />
              </>
            )}
            {allJobs.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRangeFor((chosen.length ? chosen : selectable).map((j) => j.id))}
                title="Ingest only the rows between two dates, replacing them in bronze"
              >
                <CalendarRange /> Ingest dates ({chosen.length ? chosen.length : "all"})
              </Button>
            )}
            <RunJobsButton
              jobs={allJobs}
              active={active}
              label="Run all"
              variant={chosen.length ? "outline" : "default"}
            />
          </CardHeader>
          {jobs.error && (
            <div className="p-4">
              <ErrorAlert error={jobs.error} />
            </div>
          )}
          {rangeFor && (
            <DateRangePanel
              key={rangeFor.join(",")}
              jobs={allJobs.filter((j) => rangeFor.includes(j.id))}
              active={active}
              onClose={() => setRangeFor(null)}
            />
          )}
          {jobs.data && !jobs.data.task_ready && (
            <div className="p-4">
              <ErrorAlert
                title="This workspace can't run ingestion jobs"
                error={new Error(`It has no ${jobs.data.task_module} (the Spark task the jobs call).`)}
              />
            </div>
          )}
          {jobs.isLoading ? (
            <Skeleton className="m-4 h-20" />
          ) : !jobs.data?.jobs.length ? (
            <p className="text-muted-foreground p-4 text-sm">
              No ingestion jobs yet.{" "}
              {connections.data?.length
                ? "Click New ingestion job to choose tables to copy."
                : "Add a database connection first."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all ingestion jobs"
                      title="Select every job (all pages)"
                      className="accent-primary size-4"
                      checked={allChosen}
                      ref={(el) => {
                        if (el) el.indeterminate = chosen.length > 0 && !allChosen
                      }}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(selectable.map((j) => j.id)))}
                    />
                  </TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Tables</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pager.items.map((j) => (
                  <JobRow
                    selected={selected.has(j.id)}
                    onToggle={() => toggle(j.id)}
                    onDates={() => setRangeFor([j.id])}
                    key={j.id}
                    job={j}
                    kind={kindOf(j.connection)}
                    onEdit={() => setEditingJob(j.id)}
                    editing={editingJob === j.id}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {!!jobs.data?.jobs.length && (
            <div className="px-2 pb-2">
              <Pager pagination={pager} label="jobs" />
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ jobs
/** Runs jobs for the rows between two chosen dates only (both days included). */
function DateRangePanel({
  jobs,
  active,
  onClose,
}: {
  jobs: IngestionJob[]
  active: Map<string, unknown[]>
  onClose: () => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const runnable = jobs.filter((j) => !active.has(j.id))
  const busy = jobs.length - runnable.length
  const backwards = !!from && !!to && to < from
  // tables a date range can't filter: no watermark, or a numeric one
  const undated = jobs.flatMap((j) => j.tables.filter((t) => !t.watermark).map((t) => `${j.id}: ${t.source}`))

  const run = async () => {
    setPending(true)
    setResult(null)
    const results = await Promise.allSettled(runnable.map((j) => api.runJobForDates(j.id, from || null, to || null)))
    setPending(false)
    void qc.invalidateQueries({ queryKey: ["runs"] })
    void qc.invalidateQueries({ queryKey: ["ingestion", "jobs"] })
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
    const failed = results
      .map((r, i) => (r.status === "rejected" ? `${runnable[i].id}: ${(r.reason as Error).message}` : null))
      .filter(Boolean)
    if (ok.length === 1 && !failed.length) return navigate(`/runs/${ok[0].id}`)
    setResult(
      failed.length
        ? { ok: false, text: `Started ${ok.length}; not started: ${failed.join("; ")}` }
        : { ok: true, text: `Started ${ok.length} job${ok.length === 1 ? "" : "s"}` },
    )
  }

  return (
    <div className="bg-muted/30 grid gap-3 border-b px-4 py-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <CalendarRange className="text-primary size-4" />
        Ingest between two dates
        <span className="text-muted-foreground font-normal">
          · {jobs.length === 1 ? jobs[0].name : `${jobs.length} jobs`}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
          <X /> Close
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="From (included)">
          <Input
            type="date"
            className="w-44"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To (included)">
          <Input
            type="date"
            className="w-44"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Button onClick={run} disabled={pending || (!from && !to) || backwards || runnable.length === 0}>
          {pending ? <Loader2 className="animate-spin" /> : <Play />} Ingest {from || "…"} to {to || "now"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Each table with a date or timestamp watermark copies the rows between the two days (both included). Rows already
        in bronze are overwritten: by their key columns when the table has some, else the whole range is replaced. So a
        range can be ingested again without duplicates. Leave a date empty to keep that side open. Tables with a numeric
        watermark or none are skipped.
      </p>
      {backwards && <p className="text-destructive text-xs">The to date is before the from date.</p>}
      {busy > 0 && (
        <p className="text-muted-foreground text-xs">
          {busy} job{busy === 1 ? " is" : "s are"} running and will be skipped.
        </p>
      )}
      {undated.length > 0 && (
        <p className="text-muted-foreground text-xs">Skipped (no watermark): {undated.join(", ")}</p>
      )}
      {result && (
        <p className={cn("text-xs", result.ok ? "text-status-succeeded" : "text-destructive")}>{result.text}</p>
      )}
    </div>
  )
}

/** Starts the given jobs that are valid and not running already (Run all, Run selected). */
function RunJobsButton({
  jobs,
  active,
  label,
  variant = "default",
  onStarted,
}: {
  jobs: IngestionJob[]
  active: Map<string, unknown[]>
  label: string
  variant?: "default" | "outline"
  onStarted?: () => void
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const startable = jobs.filter((j) => !j.errors.length && !active.has(j.id))
  const running = jobs.filter((j) => active.has(j.id)).length
  const invalid = jobs.filter((j) => j.errors.length).length

  const runAll = async () => {
    const skipped = [running && `${running} already running`, invalid && `${invalid} with errors`].filter(Boolean)
    const note = skipped.length ? `\n\nSkipped: ${skipped.join(", ")}.` : ""
    if (!window.confirm(`Run ${startable.length} ingestion job${startable.length === 1 ? "" : "s"} now?${note}`)) return
    setPending(true)
    setResult(null)
    const results = await Promise.allSettled(startable.map((j) => api.startRun(j.id, {})))
    setPending(false)
    void qc.invalidateQueries({ queryKey: ["runs"] })
    const failed = results
      .map((r, i) => (r.status === "rejected" ? `${startable[i].id}: ${(r.reason as Error).message}` : null))
      .filter(Boolean)
    const started = results.length - failed.length
    onStarted?.()
    setResult(
      failed.length
        ? { ok: false, text: `Started ${started}; not started: ${failed.join("; ")}` }
        : { ok: true, text: `Started ${started} job${started === 1 ? "" : "s"}` },
    )
  }

  if (!jobs.length) return null
  return (
    <div className="flex items-center gap-3">
      {result && (
        <span
          className={cn("max-w-96 truncate text-xs", result.ok ? "text-status-succeeded" : "text-destructive")}
          title={result.text}
        >
          {result.text}
        </span>
      )}
      <Button
        size="sm"
        variant={variant}
        onClick={runAll}
        disabled={pending || startable.length === 0}
        title={startable.length === 0 ? "Every job is running or has errors" : undefined}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Play />} {label} ({startable.length})
      </Button>
    </div>
  )
}

function JobRow({
  job,
  kind,
  onEdit,
  editing,
  selected,
  onToggle,
  onDates,
}: {
  job: IngestionJob
  kind: string
  selected: boolean
  onToggle: () => void
  onDates: () => void
  onEdit: () => void
  editing: boolean
}) {
  const navigate = useNavigate()
  const runs = useRuns({ pipeline: job.id, limit: 5 })
  const start = useStartRun()
  const remove = useDeleteIngestionJob()
  const last = runs.data?.[0]
  const active = runs.data?.filter((r) => !TERMINAL_STATUSES.includes(r.status))
  const s = job.schedule
  return (
    <TableRow className={cn((editing || selected) && "bg-accent/40")}>
      <TableCell>
        <input
          type="checkbox"
          aria-label={`Select ${job.name}`}
          className="accent-primary size-4"
          checked={selected}
          disabled={job.errors.length > 0}
          onChange={onToggle}
        />
      </TableCell>
      <TableCell>
        <Link to={`/pipelines/${job.id}`} className="font-medium hover:underline">
          {job.name}
        </Link>
        <div className="text-muted-foreground font-mono text-xs">{job.id}</div>
        {job.errors.map((e) => (
          <p key={e} className="text-destructive text-xs">
            {e}
          </p>
        ))}
      </TableCell>
      <TableCell className="font-mono text-sm">
        <span className="flex items-center gap-2">
          <DbIcon kind={kind} className="size-4" />
          {job.connection}
        </span>
      </TableCell>
      <TableCell className="text-sm">
        <span title={job.tables.map((t) => `${t.source} → bronze.${t.target}`).join("\n")}>
          {job.tables.length} table{job.tables.length === 1 ? "" : "s"}
        </span>
        <div className="text-muted-foreground max-w-56 truncate text-xs">
          {job.tables
            .slice(0, 3)
            .map((t) => t.target)
            .join(", ")}
          {job.tables.length > 3 && ", …"}
        </div>
        <div className="text-muted-foreground text-xs">from {job.start_date ?? "the system start date"}</div>
      </TableCell>
      <TableCell className="text-sm">
        {!s ? (
          <span className="text-muted-foreground">Manual only</span>
        ) : (
          <>
            <div>{describeCron(s.cron)}</div>
            {s.enabled ? (
              <div className="text-muted-foreground flex items-center gap-1 text-xs">
                <AlarmClock className="size-3" /> next {formatDateTime(s.next_run)}
              </div>
            ) : (
              <Badge variant="outline">paused</Badge>
            )}
          </>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {last ? (
          <Link to={`/runs/${last.id}`} className="flex flex-col gap-0.5 hover:underline">
            <StatusBadge status={last.status} />
            <span className="text-muted-foreground text-xs">{formatDateTime(last.started_at ?? last.created_at)}</span>
          </Link>
        ) : (
          <span className="text-muted-foreground">never</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          {active?.length ? (
            <StopButton runs={active} size="sm" />
          ) : (
            <Button
              size="sm"
              onClick={() =>
                start.mutate({ id: job.id, parameters: {} }, { onSuccess: (run) => navigate(`/runs/${run.id}`) })
              }
              disabled={start.isPending || job.errors.length > 0}
            >
              {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run now
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onDates}
            disabled={job.errors.length > 0}
            aria-label={`Ingest ${job.name} between two dates`}
            title="Ingest between two dates"
          >
            <CalendarRange />
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit} aria-label={`Edit ${job.name}`}>
            <Pencil />
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Delete ${job.name}`}
            disabled={remove.isPending}
            onClick={() =>
              window.confirm(`Delete the ingestion job ${job.name}? Its bronze tables and run history stay.`) &&
              remove.mutate(job.id)
            }
          >
            <Trash2 />
          </Button>
        </div>
        {(start.error || remove.error) && (
          <p className="text-destructive mt-1 text-xs">{(start.error ?? remove.error)?.message}</p>
        )}
      </TableCell>
    </TableRow>
  )
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")

function JobEditor({
  job,
  connections,
  onDone,
}: {
  job: IngestionJob | null
  connections: DbConnection[]
  onDone: () => void
}) {
  const [id, setId] = useState(job?.id ?? "")
  const [name, setName] = useState(job?.name ?? "")
  const [connection, setConnection] = useState(job?.connection ?? connections[0]?.name ?? "")
  const [startDate, setStartDate] = useState(job?.start_date ?? "")
  // chosen tables by source ("schema.table")
  const [picked, setPicked] = useState<Map<string, JobTable>>(
    () => new Map((job?.tables ?? []).map((t) => [t.source, t])),
  )
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const trigger = useTrigger(job?.schedule)
  const tables = useSourceTables(connection || null)
  const save = useSaveIngestionJob()

  // a new job is named after its connection until the user types an id
  const [idTouched, setIdTouched] = useState(!!job)
  useEffect(() => {
    if (!idTouched && connection) setId(`ingest_${slug(connection)}`)
  }, [connection, idTouched])

  const shown = useMemo(
    () =>
      (tables.data ?? []).filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(filter.trim().toLowerCase())),
    [tables.data, filter],
  )

  // jobs saved before key columns existed: overwrite by the primary key from now on
  useEffect(() => {
    if (!tables.data) return
    setPicked((prev) => {
      if (![...prev.values()].some((t) => t.keys === undefined)) return prev
      const next = new Map(prev)
      for (const [source, t] of next) {
        if (t.keys !== undefined) continue
        const src = tables.data.find((x) => `${x.schema}.${x.name}` === source)
        next.set(source, { ...t, keys: src?.primary_key ?? [] })
      }
      return next
    })
  }, [tables.data])

  const toggleTable = (t: SourceTable) =>
    setPicked((prev) => {
      const next = new Map(prev)
      const source = `${t.schema}.${t.name}`
      if (next.has(source)) next.delete(source)
      else
        next.set(source, {
          source,
          target: slug(`${connection}_${t.name}`),
          columns: [],
          watermark: suggestWatermark(t),
          keys: t.primary_key,
        })
      return next
    })
  const updateTable = (source: string, change: Partial<JobTable>) =>
    setPicked((prev) => new Map(prev).set(source, { ...prev.get(source)!, ...change }))

  const submit = () =>
    save.mutate(
      {
        id,
        createOnly: !job,
        body: {
          name: name.trim() || null,
          connection,
          start_date: startDate || null,
          schedule: trigger.schedule,
          tables: [...picked.values()],
        },
      },
      { onSuccess: onDone },
    )

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <CardTitle className="flex-1 text-base">{job ? `Edit ${job.name}` : "New ingestion job"}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onDone}>
          <X /> Close
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 px-4 py-4 text-sm">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Job id (the pipeline it is saved as)">
            <Input
              className="w-56 font-mono"
              value={id}
              disabled={!!job}
              onChange={(e) => {
                setIdTouched(true)
                setId(e.target.value.toLowerCase())
              }}
              placeholder="ingest_bankdb"
            />
          </Field>
          <Field label="Name (optional)">
            <Input className="w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder={id} />
          </Field>
          <Field label="Database connection">
            <select
              className={cn(selectClass, "w-56")}
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value)
                setPicked(new Map())
              }}
            >
              {connections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start date (first run copies rows from here on)">
            <div className="flex items-center gap-1">
              <Input type="date" className="w-44" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              {startDate && (
                <Button variant="ghost" size="sm" onClick={() => setStartDate("")} aria-label="Clear the start date">
                  <X />
                </Button>
              )}
            </div>
          </Field>
        </div>
        {!startDate && (
          <p className="text-muted-foreground -mt-3 text-xs">
            No start date: the first run starts from the system start date (PROOFLIX_START_DATE), or copies every row
            when that isn't set either.
          </p>
        )}

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">Tables</span>
            <span className="text-muted-foreground">{picked.size} selected</span>
            <Input
              className="ml-auto h-8 w-56"
              placeholder="Filter tables"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {tables.error && <ErrorAlert title={`Can't list the tables of ${connection}`} error={tables.error} />}
          {tables.isLoading ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="max-h-[28rem] overflow-y-auto rounded-md border">
              {shown.length === 0 && tables.data && (
                <p className="text-muted-foreground p-3">{tables.data.length ? "No table matches." : "No tables."}</p>
              )}
              {shown.map((t) => {
                const source = `${t.schema}.${t.name}`
                const chosen = picked.get(source)
                const expanded = open === source
                return (
                  <div key={source} className={cn("border-b last:border-b-0", chosen && "bg-accent/30")}>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <input
                        type="checkbox"
                        className="accent-primary size-4"
                        aria-label={`Ingest ${source}`}
                        checked={!!chosen}
                        onChange={() => toggleTable(t)}
                      />
                      <button
                        type="button"
                        className="flex items-center gap-1 font-mono hover:underline"
                        onClick={() => setOpen(expanded ? null : source)}
                        aria-expanded={expanded}
                      >
                        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        {source}
                      </button>
                      <span className="text-muted-foreground text-xs">{t.columns.length} columns</span>
                      {chosen && (
                        <span className="text-muted-foreground ml-auto text-xs">
                          → bronze.{chosen.target} ·{" "}
                          {chosen.columns.length ? `${chosen.columns.length} columns` : "all columns"} ·{" "}
                          {chosen.watermark ? `new rows by ${chosen.watermark}` : "full copy"}
                          {chosen.watermark &&
                            (chosen.keys?.length ? ` · overwrite by ${chosen.keys.join(", ")}` : " · append")}
                        </span>
                      )}
                    </div>
                    {expanded && (
                      <TableSettings
                        table={t}
                        chosen={chosen}
                        onPick={() => !chosen && toggleTable(t)}
                        onChange={(c) => updateTable(source, c)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {/* tables chosen earlier that the database no longer lists */}
          {tables.data &&
            [...picked.keys()]
              .filter((s) => !tables.data.some((t) => `${t.schema}.${t.name}` === s))
              .map((s) => (
                <p key={s} className="text-destructive text-xs">
                  {s} is not in the database any more.{" "}
                  <button
                    className="underline"
                    onClick={() =>
                      setPicked((p) => {
                        const n = new Map(p)
                        n.delete(s)
                        return n
                      })
                    }
                  >
                    Remove it
                  </button>
                </p>
              ))}
        </div>

        <div className="grid gap-3">
          <span className="font-medium">Trigger</span>
          <TriggerFields trigger={trigger} manualText="The job runs only when you click Run now." />
        </div>

        {save.error && <ErrorAlert title="Not saved" error={save.error} />}
        <div className="flex items-center gap-2">
          <Button
            onClick={submit}
            disabled={save.isPending || !id || !connection || picked.size === 0 || trigger.blocked}
          >
            {save.isPending && <Loader2 className="animate-spin" />} {job ? "Save job" : "Create job"}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** An "updated_at"-like timestamp column, else none (a full copy). */
function suggestWatermark(t: SourceTable): string | null {
  const ok = t.columns.filter((c) => c.watermark)
  const prefer = [/updated|modified|changed/i, /_ts$|timestamp|created|_at$/i, /date/i]
  for (const re of prefer) {
    const hit = ok.find((c) => re.test(c.name) && !/^(int|bigint|smallint|number)/i.test(c.type))
    if (hit) return hit.name
  }
  return null
}

function TableSettings({
  table,
  chosen,
  onPick,
  onChange,
}: {
  table: SourceTable
  chosen: JobTable | undefined
  onPick: () => void
  onChange: (c: Partial<JobTable>) => void
}) {
  const all = table.columns.map((c) => c.name)
  const selected = chosen ? (chosen.columns.length ? new Set(chosen.columns) : new Set(all)) : new Set<string>()
  const setColumns = (next: Set<string>) => {
    const ordered = all.filter((c) => next.has(c))
    const watermark = chosen?.watermark && !next.has(chosen.watermark) ? null : chosen?.watermark
    const keys = (chosen?.keys ?? []).filter((k) => next.has(k))
    onChange({ columns: ordered.length === all.length ? [] : ordered, watermark: watermark ?? null, keys })
  }
  if (!chosen)
    return (
      <div className="bg-muted/40 px-9 py-2 text-xs">
        <div className="text-muted-foreground mb-1">{table.columns.map((c) => `${c.name} ${c.type}`).join(" · ")}</div>
        <button className="underline" onClick={onPick}>
          Ingest this table
        </button>
      </div>
    )
  return (
    <div className="bg-muted/40 grid gap-3 px-9 py-3">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Bronze table">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground font-mono text-xs">bronze.</span>
            <Input
              className="h-8 w-56 font-mono"
              value={chosen.target}
              onChange={(e) => onChange({ target: e.target.value.toLowerCase() })}
            />
          </div>
        </Field>
        <Field label="Which rows each run copies">
          <select
            className={cn(selectClass, "h-8 w-80")}
            value={chosen.watermark ?? ""}
            onChange={(e) => onChange({ watermark: e.target.value || null })}
          >
            <option value="">The whole table, replacing the copy (no watermark)</option>
            {table.columns
              .filter((c) => c.watermark && selected.has(c.name))
              .map((c) => (
                <option key={c.name} value={c.name}>
                  New rows by {c.name} ({c.type})
                </option>
              ))}
          </select>
        </Field>
      </div>
      {chosen.watermark && (
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              Key columns: a row whose key is already in bronze is overwritten (none: new rows are appended)
            </span>
            {table.primary_key.length > 0 && (
              <button className="underline" onClick={() => onChange({ keys: table.primary_key })}>
                primary key
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {table.columns
              .filter((c) => selected.has(c.name))
              .map((c) => {
                const on = (chosen.keys ?? []).includes(c.name)
                return (
                  <button
                    key={c.name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      onChange({
                        keys: on
                          ? (chosen.keys ?? []).filter((k) => k !== c.name)
                          : all.filter((x) => x === c.name || (chosen.keys ?? []).includes(x)),
                      })
                    }
                    className={cn(
                      "rounded-md border px-2 py-0.5 font-mono text-xs",
                      on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {c.name}
                    {table.primary_key.includes(c.name) && <span className="text-muted-foreground"> · PK</span>}
                  </button>
                )
              })}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">Columns</span>
          <button className="underline" onClick={() => setColumns(new Set(all))}>
            all
          </button>
          <span className="text-muted-foreground">
            {selected.size} of {all.length}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-4 gap-y-1">
          {table.columns.map((c) => (
            <label key={c.name} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="accent-primary size-3.5"
                checked={selected.has(c.name)}
                disabled={selected.size === 1 && selected.has(c.name)}
                onChange={() => {
                  const next = new Set(selected)
                  if (next.has(c.name)) next.delete(c.name)
                  else next.add(c.name)
                  setColumns(next)
                }}
              />
              <span className="font-mono">{c.name}</span>
              <span className="text-muted-foreground truncate">{c.type}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ connections
function ConnectionsCard({
  editing,
  setEditing,
}: {
  editing: string | null
  setEditing: (name: string | null) => void
}) {
  const connections = useDbConnections()
  const kinds = useDbKinds()
  const remove = useDeleteDbConnection()
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "pending">>({})
  const kindLabel = (k: string) => kinds.data?.find((x) => x.kind === k)?.label ?? k

  const test = async (name: string) => {
    setTests((t) => ({ ...t, [name]: "pending" }))
    try {
      const r = await api.testDbConnection(name)
      setTests((t) => ({
        ...t,
        [name]: r.ok ? { ok: true, text: `connected · ${r.tables} tables` } : { ok: false, text: r.error ?? "failed" },
      }))
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, text: (e as Error).message } }))
    }
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <Database className="text-primary size-4" />
        <CardTitle className="flex-1 text-base">Database connections</CardTitle>
        <Button variant="outline" size="sm" onClick={() => setEditing(NEW)} disabled={editing !== null}>
          <Plus /> Add connection
        </Button>
      </CardHeader>
      {connections.error && (
        <div className="p-4">
          <ErrorAlert error={connections.error} />
        </div>
      )}
      {editing !== null && kinds.data && (
        <ConnectionForm
          key={editing}
          kinds={kinds.data}
          current={editing === NEW ? null : (connections.data?.find((c) => c.name === editing) ?? null)}
          onDone={(saved) => {
            setEditing(null)
            if (saved) void test(saved)
          }}
        />
      )}
      {connections.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : !connections.data?.length ? (
        editing === null && (
          <p className="text-muted-foreground p-4 text-sm">
            No connections yet. Add one for each database to ingest from. The password stays on the Prooflix server (not
            in the workspace or git); a read-only database user is enough.
          </p>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>JDBC URL</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.data.map((c) => {
              const t = tests[c.name]
              return (
                <TableRow key={c.name}>
                  <TableCell className="font-mono font-medium">{c.name}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <DbIcon kind={c.kind} />
                      {kindLabel(c.kind)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-96 font-mono text-xs break-all whitespace-normal">{c.jdbc_url}</TableCell>
                  <TableCell className="font-mono text-sm">{c.user}</TableCell>
                  <TableCell className="max-w-80 text-xs whitespace-normal">
                    {t === "pending" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : t ? (
                      <span
                        className={cn("flex items-start gap-1", t.ok ? "text-status-succeeded" : "text-destructive")}
                      >
                        {t.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
                        {t.text}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">not tested</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => test(c.name)} disabled={t === "pending"}>
                        <Plug /> Test
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(c.name)}
                        aria-label={`Edit ${c.name}`}
                        disabled={editing !== null}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => window.confirm(`Delete the connection ${c.name}?`) && remove.mutate(c.name)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
      {remove.error && (
        <div className="p-4 pt-0">
          <ErrorAlert title="Not deleted" error={remove.error} />
        </div>
      )}
    </Card>
  )
}

const BASE_KEYS = new Set(["host", "port", "database", "user", "password"])

function initialValues(kind: DbKind, current: DbConnection | null): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const f of kind.fields) {
    if (current && current.kind === kind.kind) {
      values[f.key] = BASE_KEYS.has(f.key)
        ? current[f.key as keyof DbConnection]
        : (current.options[f.key] ?? f.default)
    } else values[f.key] = f.default ?? ""
  }
  return values
}

function ConnectionForm({
  kinds,
  current,
  onDone,
}: {
  kinds: DbKind[]
  current: DbConnection | null
  onDone: (saved: string | null) => void
}) {
  const [name, setName] = useState(current?.name ?? "")
  const [kindId, setKindId] = useState(current?.kind ?? kinds[0].kind)
  const kind = kinds.find((k) => k.kind === kindId)!
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(kind, current))
  const save = useSaveDbConnection()

  const chooseKind = (k: string) => {
    setKindId(k)
    const next = kinds.find((x) => x.kind === k)!
    // keep what was typed in the shared fields; the port follows the type
    const fresh = initialValues(next, current)
    for (const key of ["host", "database", "user", "password"]) if (values[key]) fresh[key] = values[key]
    setValues(fresh)
  }

  const missingFields = [
    ...(name.trim() ? [] : ["Connection name"]),
    ...kind.fields
      .filter((f) => f.required && f.type !== "bool" && !String(values[f.key] ?? "").trim())
      .map((f) => f.label),
  ]
  const badName = !!name && !/^[a-z][a-z0-9_]*$/.test(name)
  const submit = () => {
    const options: Record<string, unknown> = {}
    for (const f of kind.fields) if (!BASE_KEYS.has(f.key)) options[f.key] = values[f.key]
    save.mutate(
      {
        name,
        body: {
          kind: kindId,
          host: String(values.host ?? ""),
          port: values.port ? Number(values.port) : null,
          database: String(values.database ?? ""),
          user: String(values.user ?? ""),
          password: String(values.password ?? ""),
          options,
        },
      },
      { onSuccess: () => onDone(name) },
    )
  }

  return (
    <div className="bg-muted/30 grid gap-4 border-b px-4 py-4 text-sm">
      <div role="radiogroup" aria-label="Database type" className="flex flex-wrap gap-1.5">
        {kinds.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={k.kind === kindId}
            onClick={() => chooseKind(k.kind)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
              k.kind === kindId
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("contents", k.kind === kindId && "[&_svg]:rounded-sm [&_svg]:bg-white [&_svg]:p-px")}>
              <DbIcon kind={k.kind} className="size-4" />
            </span>
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Field label="Connection name">
          <Input
            className="w-44 font-mono"
            value={name}
            disabled={!!current}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="e.g. bankdb"
            aria-invalid={badName || undefined}
          />
        </Field>
        {kind.fields.map((f) => (
          <Field key={f.key} label={f.label + (f.required || f.type === "bool" ? "" : " (optional)")} help={f.help}>
            {f.type === "select" ? (
              <select
                className={cn(selectClass, "w-40")}
                value={String(values[f.key] ?? "")}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                {f.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : f.type === "bool" ? (
              <label className="flex h-9 items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary size-4"
                  checked={!!values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
                />
                {values[f.key] ? "yes" : "no"}
              </label>
            ) : (
              <Input
                type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
                className={f.type === "number" ? "w-24" : f.key === "host" ? "w-56" : "w-44"}
                value={String(values[f.key] ?? "")}
                autoComplete={f.type === "password" ? "new-password" : "off"}
                onFocus={(e) => f.type === "password" && e.target.value === "********" && e.target.select()}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </div>
      {save.error && <ErrorAlert title="Not saved" error={save.error} />}
      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={save.isPending || missingFields.length > 0 || badName}>
          {save.isPending && <Loader2 className="animate-spin" />} Save and test
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        {missingFields.length > 0 ? (
          <span className="text-destructive text-xs">Fill in: {missingFields.join(", ")}</span>
        ) : badName ? (
          <span className="text-destructive text-xs">
            Connection name: lowercase letters, digits and _, starting with a letter
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            Saved on the Prooflix server only, readable by its user; jobs refer to it by name.
          </span>
        )}
      </div>
    </div>
  )
}

function Field({ label, help, children }: { label: string; help?: string | null; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-muted-foreground text-xs" title={help ?? undefined}>
        {label}
      </span>
      {children}
    </div>
  )
}
