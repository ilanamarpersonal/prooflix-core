import { useEffect, useState } from "react"
import { Link } from "react-router"
import { useQuery } from "@tanstack/react-query"
import { AlarmClock, CalendarClock, Loader2, Pause, Play, Settings2, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api, useSetSchedule } from "@/lib/api"
import {
  MINUTE_STEPS,
  SECOND_STEPS,
  TRIGGER_KINDS,
  WEEKDAYS,
  describeCron,
  fromCron,
  timeZones,
  toCron,
  type TriggerForm,
  type TriggerKind,
} from "@/lib/schedule"
import type { PipelineDetail } from "@/lib/types"
import { cn, formatDateTime } from "@/lib/utils"

const selectClass =
  "border-input bg-background h-9 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

/** How a pipeline is triggered: shows the schedule and edits it. */
export function TriggerCard({ pipeline }: { pipeline: PipelineDetail }) {
  const schedule = pipeline.schedule
  const [editing, setEditing] = useState(false)
  const setSchedule = useSetSchedule()

  const togglePause = () =>
    schedule &&
    setSchedule.mutate({
      id: pipeline.id,
      schedule: { cron: schedule.cron, timezone: schedule.timezone, enabled: !schedule.enabled },
    })

  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
        <CalendarClock className="text-primary size-4" />
        <span className="font-medium">Trigger</span>
        {!schedule ? (
          <span className="text-muted-foreground">Manual only: runs when you start it</span>
        ) : (
          <>
            <span>{describeCron(schedule.cron)}</span>
            <span className="text-muted-foreground">{schedule.timezone}</span>
            {schedule.enabled ? (
              <Badge variant="secondary" className="gap-1">
                <AlarmClock className="size-3" /> next {formatDateTime(schedule.next_run)}
              </Badge>
            ) : (
              <Badge variant="outline">paused</Badge>
            )}
            {schedule.last_run_id && (
              <Link to={`/runs/${schedule.last_run_id}`} className="text-muted-foreground hover:underline">
                last scheduled run {formatDateTime(schedule.last_run_at)}
              </Link>
            )}
            {schedule.last_skipped_at && (
              <span className="text-muted-foreground" title="The previous run was still going">
                skipped {formatDateTime(schedule.last_skipped_at)}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex gap-2">
          {schedule && (
            <Button variant="outline" size="sm" onClick={togglePause} disabled={setSchedule.isPending}>
              <span className="contents">{schedule.enabled ? <Pause /> : <Play />}</span> {schedule.enabled ? "Pause" : "Resume"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
            <Settings2 /> {editing ? "Close" : "Change trigger"}
          </Button>
        </div>
      </CardContent>
      {schedule?.last_error && (
        <div className="px-4 pb-3">
          <ErrorAlert title="The last scheduled run could not start" error={new Error(schedule.last_error)} />
        </div>
      )}
      {editing && <TriggerEditor pipeline={pipeline} onDone={() => setEditing(false)} />}
    </Card>
  )
}

function TriggerEditor({ pipeline, onDone }: { pipeline: PipelineDetail; onDone: () => void }) {
  const current = pipeline.schedule
  const [form, setForm] = useState<TriggerForm>(() => fromCron(current?.cron))
  const [tz, setTz] = useState(current?.timezone ?? "UTC")
  const [enabled, setEnabled] = useState(current?.enabled ?? true)
  const setSchedule = useSetSchedule()
  const zones = timeZones()
  const cron = toCron(form)
  const update = (change: Partial<TriggerForm>) => setForm((f) => ({ ...f, ...change }))

  // the next run times, checked by the server (also validates a custom cron)
  const [debounced, setDebounced] = useState(cron)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cron), 300)
    return () => clearTimeout(t)
  }, [cron])
  const previewQuery = useQuery({
    queryKey: ["schedule-preview", debounced, tz],
    queryFn: () => api.previewSchedule(debounced!, tz),
    enabled: !!debounced,
  })
  // only show times that belong to the cron on screen, never the previous one's
  const upToDate = debounced === cron && !previewQuery.isPlaceholderData
  const preview = { data: upToDate ? previewQuery.data : undefined, isFetching: !upToDate || previewQuery.isFetching }
  const invalid = !!cron && preview.data && !preview.data.valid

  const save = () =>
    setSchedule.mutate(
      { id: pipeline.id, schedule: cron ? { cron, timezone: tz, enabled } : null },
      { onSuccess: onDone },
    )

  return (
    <div className="grid gap-4 border-t px-4 py-4 text-sm">
      <div role="radiogroup" aria-label="Trigger" className="flex flex-wrap gap-1.5">
        {TRIGGER_KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={form.kind === kind}
            onClick={() =>
              setForm((f) => ({
                ...f,
                kind: kind as TriggerKind,
                cron: kind === "cron" ? (toCron(f) ?? f.cron) : f.cron,
              }))
            }
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              form.kind === kind
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {form.kind !== "manual" && (
        <div className="flex flex-wrap items-end gap-4">
          {form.kind === "seconds" && (
            <Field label="Every">
              <select
                className={selectClass}
                value={form.everySeconds}
                onChange={(e) => update({ everySeconds: +e.target.value })}
              >
                {SECOND_STEPS.map((n) => (
                  <option key={n} value={n}>
                    {n} second{n === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.kind === "minutes" && (
            <Field label="Every">
              <select className={selectClass} value={form.every} onChange={(e) => update({ every: +e.target.value })}>
                {MINUTE_STEPS.map((n) => (
                  <option key={n} value={n}>
                    {n} minute{n === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.kind === "hourly" && (
            <Field label="At minute">
              <Input
                type="number"
                min={0}
                max={59}
                className="w-24"
                value={form.minute}
                onChange={(e) => update({ minute: Math.min(59, Math.max(0, +e.target.value || 0)) })}
              />
            </Field>
          )}
          {form.kind === "weekly" && (
            <Field label="On">
              <div className="flex gap-1">
                {WEEKDAYS.map((name, d) => {
                  const on = form.days.includes(d)
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={on}
                      onClick={() => update({ days: on ? form.days.filter((x) => x !== d) : [...form.days, d] })}
                      className={cn(
                        "h-9 w-11 rounded-md border text-xs",
                        on ? "border-primary bg-primary/10 text-foreground font-medium" : "text-muted-foreground",
                      )}
                    >
                      {name}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}
          {form.kind === "monthly" && (
            <Field label="On day">
              <select className={selectClass} value={form.day} onChange={(e) => update({ day: +e.target.value })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(form.kind === "daily" || form.kind === "weekly" || form.kind === "monthly") && (
            <Field label="At">
              <Input
                type="time"
                className="w-32"
                value={form.time}
                onChange={(e) => update({ time: e.target.value })}
              />
            </Field>
          )}
          {form.kind === "cron" && (
            <Field label="Cron expression: minute hour day-of-month month day-of-week, or 6 fields with seconds first">
              <Input
                className="w-72 font-mono"
                value={form.cron}
                onChange={(e) => update({ cron: e.target.value })}
                placeholder="0 9 * * 1-5   or   */15 * * * * *"
                aria-invalid={invalid || undefined}
              />
            </Field>
          )}
          <Field label="Time zone">
            <select className={cn(selectClass, "max-w-56")} value={tz} onChange={(e) => setTz(e.target.value)}>
              {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex h-9 items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
        </div>
      )}

      {form.kind === "manual" ? (
        <p className="text-muted-foreground">
          The pipeline runs only when you start it (or when another pipeline calls it).
        </p>
      ) : (
        <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <code className="text-foreground font-mono">{cron}</code>
          {preview.isFetching && <Loader2 className="size-3.5 animate-spin" />}
          {invalid ? (
            <span className="text-destructive">{preview.data?.error}</span>
          ) : preview.data?.valid ? (
            <span>
              next runs: {preview.data.next_runs.map((t) => formatDateTime(t)).join(" · ")}
              {!enabled && " (saved paused: none of these run until you resume)"}
            </span>
          ) : null}
        </div>
      )}

      {setSchedule.error && <ErrorAlert title="Could not save the trigger" error={setSchedule.error} />}
      <div className="flex gap-2">
        <Button
          onClick={save}
          disabled={setSchedule.isPending || !!invalid || (form.kind === "weekly" && !form.days.length)}
        >
          {setSchedule.isPending && <Loader2 className="animate-spin" />} Save trigger
        </Button>
        <Button variant="ghost" onClick={onDone}>
          <X /> Cancel
        </Button>
        <span className="text-muted-foreground self-center text-xs">
          Saved as a <code className="font-mono">schedule:</code> block in{" "}
          <code className="font-mono">{pipeline.file ?? `${pipeline.id}.yaml`}</code>
        </span>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}
