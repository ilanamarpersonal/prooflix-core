import { useEffect, useState } from "react"
import { Link } from "react-router"
import { useQuery } from "@tanstack/react-query"
import {
  BellRing,
  CheckCircle2,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Trash2,
  Users,
  Webhook,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Pager } from "@/components/pager"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  api,
  useAlertChannels,
  useAlertHistory,
  useAlertKinds,
  useAlertMutation,
  useAlertRules,
  useAuthStatus,
} from "@/lib/api"
import type { AlertChannel, AlertChannelKind, AlertEvent, AlertRule, AlertRuleIn } from "@/lib/types"
import { usePagination } from "@/lib/use-pagination"
import { cn, formatDateTime } from "@/lib/utils"

const NEW = "\u0000new"
const selectClass =
  "border-input bg-background h-9 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

export const CHANNEL_ICONS: Record<string, LucideIcon> = {
  email: Mail,
  slack: MessageSquare,
  teams: Users,
  webhook: Webhook,
}

/** Ready-made log message formats; {name} matches any text and becomes a field of the alert. */
const PRESETS: { label: string; pattern: string; line: string }[] = [
  { label: "Task failed", pattern: "ERROR {message}", line: "ERROR Command exited with code 1" },
  { label: "Alert line", pattern: "ALERT {severity}: {message}", line: "ALERT critical: disk almost full" },
  { label: "Warning", pattern: "WARN {message}", line: "WARN 12 rows rejected" },
  { label: "Retry", pattern: "Retry attempt {attempt} of {max}", line: "Retry attempt 2 of 3" },
]

const SEVERITY_STYLE: Record<string, string> = {
  info: "text-muted-foreground",
  warning: "text-status-running",
  critical: "text-status-failed",
}

/** Raise alerts when a task log line matches a message format, and send them to channels. */
export function AlertsPage() {
  const [editingChannel, setEditingChannel] = useState<string | null>(null)
  const [editingRule, setEditingRule] = useState<string | null>(null)
  const channels = useAlertChannels()
  const rules = useAlertRules()

  return (
    <div>
      <PageHeader
        title="Alerts"
        description="Raise an alert when a pipeline's log shows a line in a format you define, and send it to Email, Slack, Microsoft Teams or a webhook: to one channel, some, or all of them."
        actions={
          <Button onClick={() => setEditingRule(NEW)} disabled={editingRule !== null}>
            <Plus /> New alert rule
          </Button>
        }
      />
      <div className="grid gap-4">
        {editingRule !== null && (
          <RuleForm
            key={editingRule}
            rule={editingRule === NEW ? null : (rules.data?.find((r) => r.id === editingRule) ?? null)}
            channels={channels.data ?? []}
            onDone={() => setEditingRule(null)}
          />
        )}
        <RulesCard rules={rules} channels={channels.data ?? []} onEdit={setEditingRule} editing={editingRule} />
        <ChannelsCard channels={channels} editing={editingChannel} setEditing={setEditingChannel} />
        <HistoryCard />
      </div>
    </div>
  )
}

// ------------------------------------------------------------ rules
function RulesCard({
  rules,
  channels,
  onEdit,
  editing,
}: {
  rules: ReturnType<typeof useAlertRules>
  channels: AlertChannel[]
  onEdit: (id: string) => void
  editing: string | null
}) {
  const remove = useAlertMutation((id: string) => api.deleteAlertRule(id))
  const toggle = useAlertMutation((r: AlertRule) => api.saveAlertRule(r.id, { ...r, enabled: !r.enabled }))
  const nameOf = (id: string) => channels.find((c) => c.id === id)?.name ?? id
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <BellRing className="text-primary size-4" />
        <CardTitle className="flex-1 text-base">Alert rules</CardTitle>
      </CardHeader>
      {rules.error && (
        <div className="p-4">
          <ErrorAlert error={rules.error} />
        </div>
      )}
      {rules.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : !rules.data?.length ? (
        <p className="text-muted-foreground p-4 text-sm">
          No rules yet. Click New alert rule and choose the log message format to watch for, such as{" "}
          <code className="font-mono">ERROR {"{message}"}</code> for failed tasks.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rule</TableHead>
              <TableHead>Message format</TableHead>
              <TableHead>Pipelines</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data.map((r) => (
              <TableRow key={r.id} className={cn(editing === r.id && "bg-accent/40", !r.enabled && "opacity-60")}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  <div className={cn("text-xs", SEVERITY_STYLE[r.severity])}>
                    {r.severity}
                    {!r.enabled && " · paused"} · cooldown {Math.round(r.cooldown_seconds / 60)} min
                  </div>
                </TableCell>
                <TableCell className="max-w-72 font-mono text-xs break-all whitespace-normal">
                  {r.mode === "regex" && <Badge variant="outline">regex</Badge>} {r.pattern}
                </TableCell>
                <TableCell className="text-sm">
                  {r.pipelines.length ? r.pipelines.join(", ") : "All pipelines"}
                </TableCell>
                <TableCell className="max-w-64 text-sm whitespace-normal">
                  {r.channels.length ? r.channels.map(nameOf).join(", ") : <span>All channels</span>}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => toggle.mutate(r)} disabled={toggle.isPending}>
                      {r.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button size="sm" variant="outline" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r.id)}>
                      <Pencil />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Delete ${r.name}`}
                      onClick={() => window.confirm(`Delete the alert rule ${r.name}?`) && remove.mutate(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {(remove.error || toggle.error) && (
        <div className="p-4 pt-0">
          <ErrorAlert error={(remove.error ?? toggle.error)!} />
        </div>
      )}
    </Card>
  )
}

function RuleForm({
  rule,
  channels,
  onDone,
}: {
  rule: AlertRule | null
  channels: AlertChannel[]
  onDone: () => void
}) {
  const auth = useAuthStatus().data
  const canListPipelines = !auth?.enabled || !!auth.user?.visible_tabs.includes("pipelines")
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: api.listPipelines, enabled: canListPipelines })
  const [form, setForm] = useState<AlertRuleIn>(
    rule ?? {
      name: "",
      enabled: true,
      mode: "format",
      pattern: PRESETS[0].pattern,
      severity: "warning",
      pipelines: [],
      channels: [],
      cooldown_seconds: 300,
    },
  )
  const [sample, setSample] = useState(rule ? "" : PRESETS[0].line)
  const set = (change: Partial<AlertRuleIn>) => setForm((f) => ({ ...f, ...change }))
  const save = useAlertMutation(() => api.saveAlertRule(rule?.id ?? null, form))

  // does the sample line match? checked by the server, as the rules are
  const [check, setCheck] = useState<{ matches: boolean; fields: Record<string, string>; error?: string } | null>(null)
  useEffect(() => {
    setCheck(null) // never show the answer for an earlier format or line
    if (!sample || !form.pattern) return
    let current = true
    const t = setTimeout(() => {
      api
        .tryAlertFormat(form.mode, form.pattern, sample)
        .then((r) => current && setCheck(r))
        .catch((e: Error) => current && setCheck({ matches: false, fields: {}, error: e.message }))
    }, 300)
    return () => {
      current = false
      clearTimeout(t)
    }
  }, [form.mode, form.pattern, sample])

  const toggleIn = (key: "pipelines" | "channels", id: string) =>
    set({ [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] })

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <CardTitle className="flex-1 text-base">{rule ? `Edit ${rule.name}` : "New alert rule"}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onDone}>
          <X /> Close
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 px-4 py-4 text-sm">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Name">
            <Input
              className="w-64"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Failed task"
            />
          </Field>
          <Field label="Severity">
            <select
              className={cn(selectClass, "w-36")}
              value={form.severity}
              onChange={(e) => set({ severity: e.target.value as AlertRuleIn["severity"] })}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Cooldown (minutes)">
            <Input
              type="number"
              min={0}
              max={1440}
              className="w-28"
              value={Math.round(form.cooldown_seconds / 60)}
              onChange={(e) => set({ cooldown_seconds: Math.max(0, Math.min(1440, +e.target.value || 0)) * 60 })}
            />
          </Field>
          <label className="flex h-9 items-center gap-2">
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
        <p className="text-muted-foreground -mt-3 text-xs">
          The cooldown sends at most one alert per pipeline in that time; matches in between are counted in the next
          one.
        </p>

        <div className="grid gap-2">
          <span className="font-medium">Log message format</span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  set({ mode: "format", pattern: p.pattern })
                  setSample(p.line)
                }}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  form.mode === "format" && form.pattern === p.pattern
                    ? "border-primary bg-primary/10"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={cn(selectClass, "w-36")}
              value={form.mode}
              onChange={(e) => set({ mode: e.target.value as "format" | "regex" })}
            >
              <option value="format">Format</option>
              <option value="regex">Regular expression</option>
            </select>
            <Input
              className="min-w-72 flex-1 font-mono"
              value={form.pattern}
              onChange={(e) => set({ pattern: e.target.value })}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            {form.mode === "format" ? (
              <>
                Text to look for in a task's log; <code className="font-mono">{"{name}"}</code> matches any text and
                becomes a field of the alert. A task can print its own alerts, such as{" "}
                <code className="font-mono">print("ALERT critical: tank empty")</code>.
              </>
            ) : (
              <>A Python regular expression; named groups like (?P&lt;name&gt;…) become fields of the alert.</>
            )}
          </p>
          <div className="bg-muted/40 grid gap-2 rounded-md p-3">
            <Field label="Try a log line">
              <Input
                className="font-mono"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder="Paste a line from a run's output"
              />
            </Field>
            {check &&
              (check.error ? (
                <span className="text-destructive text-xs">{check.error}</span>
              ) : check.matches ? (
                <span className="text-status-succeeded flex flex-wrap items-center gap-2 text-xs">
                  <CheckCircle2 className="size-4" /> Raises an alert
                  {Object.entries(check.fields).map(([k, v]) => (
                    <Badge key={k} variant="secondary" className="font-mono font-normal">
                      {k} = {v}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground flex items-center gap-2 text-xs">
                  <XCircle className="size-4" /> No alert for this line
                </span>
              ))}
          </div>
        </div>

        <div className="grid gap-2">
          <span className="font-medium">Pipelines</span>
          <ChoiceRow
            all={form.pipelines.length === 0}
            allLabel="All pipelines"
            onAll={() => set({ pipelines: [] })}
            onSome={() =>
              set({
                pipelines: form.pipelines.length ? form.pipelines : (pipelines.data ?? []).slice(0, 1).map((p) => p.id),
              })
            }
            someLabel="Only these"
          />
          {form.pipelines.length > 0 &&
            (canListPipelines ? (
              <div className="flex flex-wrap gap-2">
                {(pipelines.data ?? []).map((p) => (
                  <CheckChip key={p.id} on={form.pipelines.includes(p.id)} onClick={() => toggleIn("pipelines", p.id)}>
                    {p.name}
                  </CheckChip>
                ))}
              </div>
            ) : (
              <Input
                className="font-mono"
                value={form.pipelines.join(", ")}
                onChange={(e) =>
                  set({
                    pipelines: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="pipeline ids, comma-separated"
              />
            ))}
        </div>

        <div className="grid gap-2">
          <span className="font-medium">Send to</span>
          <ChoiceRow
            all={form.channels.length === 0}
            allLabel="All channels"
            onAll={() => set({ channels: [] })}
            onSome={() =>
              set({ channels: form.channels.length ? form.channels : channels.slice(0, 1).map((c) => c.id) })
            }
            someLabel="Specific channels"
          />
          {form.channels.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Every channel{channels.length ? ` (${channels.map((c) => c.name).join(", ")})` : ""}, including ones you
              add later.
              {channels.length === 0 && " There are no channels yet: add one below."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {channels.map((c) => {
                const Icon = CHANNEL_ICONS[c.kind]
                return (
                  <CheckChip key={c.id} on={form.channels.includes(c.id)} onClick={() => toggleIn("channels", c.id)}>
                    <Icon className="size-4" /> {c.name}
                  </CheckChip>
                )
              })}
            </div>
          )}
        </div>

        {save.error && <ErrorAlert title="Not saved" error={save.error} />}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => save.mutate(undefined, { onSuccess: onDone })}
            disabled={save.isPending || !form.name.trim() || !form.pattern}
          >
            {save.isPending && <Loader2 className="animate-spin" />} {rule ? "Save rule" : "Create rule"}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ChoiceRow({
  all,
  allLabel,
  someLabel,
  onAll,
  onSome,
}: {
  all: boolean
  allLabel: string
  someLabel: string
  onAll: () => void
  onSome: () => void
}) {
  return (
    <div role="radiogroup" className="flex gap-1.5">
      {[
        { on: all, label: allLabel, click: onAll },
        { on: !all, label: someLabel, click: onSome },
      ].map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={o.on}
          onClick={o.click}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm",
            o.on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CheckChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5",
        on ? "border-primary bg-primary/10" : "text-muted-foreground",
      )}
    >
      <input type="checkbox" className="accent-primary size-4" checked={on} onChange={onClick} />
      {children}
    </label>
  )
}

// ------------------------------------------------------------ channels
function ChannelsCard({
  channels,
  editing,
  setEditing,
}: {
  channels: ReturnType<typeof useAlertChannels>
  editing: string | null
  setEditing: (id: string | null) => void
}) {
  const kinds = useAlertKinds()
  const remove = useAlertMutation((id: string) => api.deleteAlertChannel(id))
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "pending">>({})
  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "pending" }))
    try {
      const r = await api.testAlertChannel(id)
      setTests((t) => ({
        ...t,
        [id]: r.ok ? { ok: true, text: "test alert sent" } : { ok: false, text: r.error ?? "failed" },
      }))
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, text: (e as Error).message } }))
    }
  }
  const labelOf = (k: string) => kinds.data?.channels.find((c) => c.kind === k)?.label ?? k
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <Send className="text-primary size-4" />
        <CardTitle className="flex-1 text-base">Channels</CardTitle>
        <Button variant="outline" size="sm" onClick={() => setEditing(NEW)} disabled={editing !== null}>
          <Plus /> Add channel
        </Button>
      </CardHeader>
      {editing !== null && kinds.data && (
        <ChannelForm
          key={editing}
          kinds={kinds.data.channels}
          current={editing === NEW ? null : (channels.data?.find((c) => c.id === editing) ?? null)}
          onDone={(saved) => {
            setEditing(null)
            if (saved) void test(saved)
          }}
        />
      )}
      {channels.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : !channels.data?.length ? (
        editing === null && (
          <p className="text-muted-foreground p-4 text-sm">
            No channels yet. Add an Email, Slack, Microsoft Teams or webhook channel for alerts to go to. Webhook URLs
            and passwords stay on the Prooflix server.
          </p>
        )
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Sends to</TableHead>
              <TableHead>Test</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {channels.data.map((c) => {
              const Icon = CHANNEL_ICONS[c.kind]
              const t = tests[c.id]
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-muted-foreground font-mono text-xs">{c.id}</div>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Icon className="size-4" /> {labelOf(c.kind)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-64 text-xs break-all whitespace-normal">
                    {c.kind === "email"
                      ? c.config.recipients
                      : c.kind === "webhook"
                        ? "a webhook URL"
                        : `a ${labelOf(c.kind)} webhook`}
                  </TableCell>
                  <TableCell className="max-w-72 text-xs whitespace-normal">
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
                      <Button size="sm" variant="outline" onClick={() => test(c.id)} disabled={t === "pending"}>
                        <Send /> Test
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${c.name}`}
                        onClick={() => setEditing(c.id)}
                        disabled={editing !== null}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => window.confirm(`Delete the channel ${c.name}?`) && remove.mutate(c.id)}
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

const DEFAULTS: Record<string, Record<string, string>> = {
  email: { smtp_port: "587", security: "starttls" },
}

function ChannelForm({
  kinds,
  current,
  onDone,
}: {
  kinds: AlertChannelKind[]
  current: AlertChannel | null
  onDone: (saved: string | null) => void
}) {
  const [kind, setKind] = useState<AlertChannelKind["kind"]>(current?.kind ?? "slack")
  const [id, setId] = useState(current?.id ?? "")
  const [name, setName] = useState(current?.name ?? "")
  const [config, setConfig] = useState<Record<string, string>>(current?.config ?? DEFAULTS[kind] ?? {})
  const spec = kinds.find((k) => k.kind === kind)!
  const save = useAlertMutation(() => api.saveAlertChannel(id, { kind, name, config }))
  const missing = !id || spec.fields.some((f) => f.required && !(config[f.key] ?? "").trim())

  return (
    <div className="bg-muted/30 grid gap-4 border-b px-4 py-4 text-sm">
      <div role="radiogroup" aria-label="Channel type" className="flex flex-wrap gap-1.5">
        {kinds.map((k) => {
          const Icon = CHANNEL_ICONS[k.kind]
          return (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={k.kind === kind}
              disabled={!!current && current.kind !== k.kind}
              onClick={() => {
                setKind(k.kind)
                setConfig(DEFAULTS[k.kind] ?? {})
              }}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-40",
                k.kind === kind
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-4" /> {k.label}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Field label="Id">
          <Input
            className="w-40 font-mono"
            value={id}
            disabled={!!current}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            placeholder="ops-slack"
          />
        </Field>
        <Field label="Name">
          <Input className="w-48" value={name} onChange={(e) => setName(e.target.value)} placeholder="#data-alerts" />
        </Field>
        {spec.fields.map((f) => (
          <Field key={f.key} label={f.label + (f.required ? "" : " (optional)")}>
            {f.key === "security" ? (
              <select
                className={cn(selectClass, "w-36")}
                value={config[f.key] ?? "starttls"}
                onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
              >
                <option value="starttls">STARTTLS</option>
                <option value="ssl">SSL/TLS</option>
                <option value="none">None</option>
              </select>
            ) : (
              <Input
                type={f.secret ? "password" : f.key === "smtp_port" ? "number" : "text"}
                autoComplete={f.secret ? "new-password" : "off"}
                className={f.key === "url" || f.key === "recipients" ? "w-96" : f.key === "smtp_port" ? "w-24" : "w-48"}
                value={config[f.key] ?? ""}
                onFocus={(e) => f.secret && e.target.value === "********" && e.target.select()}
                onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                placeholder={f.key === "url" && kind === "slack" ? "https://hooks.slack.com/services/…" : undefined}
              />
            )}
          </Field>
        ))}
      </div>
      {save.error && <ErrorAlert title="Not saved" error={save.error} />}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => save.mutate(undefined, { onSuccess: () => onDone(id) })}
          disabled={save.isPending || missing}
        >
          {save.isPending && <Loader2 className="animate-spin" />} Save and test
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs">Saving sends a test alert to the channel.</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ history
function HistoryCard() {
  const history = useAlertHistory()
  const auth = useAuthStatus().data
  const canOpenRuns = !auth?.enabled || !!auth.user?.visible_tabs.includes("pipelines")
  const pager = usePagination(history.data, 10)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const remove = useAlertMutation((ids: string[] | null) => api.deleteAlerts(ids))
  const all = history.data ?? []
  // forget selections of alerts that are gone
  const chosen = all.filter((e) => selected.has(e.id)).map((e) => e.id)
  const pageIds = pager.items.map((e) => e.id)
  const pageChosen = pageIds.length > 0 && pageIds.every((id) => selected.has(id))

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const deleteIds = (ids: string[] | null, what: string) => {
    if (!window.confirm(`Delete ${what} from Recent alerts?`)) return
    remove.mutate(ids, { onSuccess: () => setSelected(new Set()) })
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b px-4 py-3">
        <CardTitle className="flex-1 text-base">Recent alerts</CardTitle>
        {chosen.length > 0 && (
          <>
            <span className="text-muted-foreground text-sm">{chosen.length} selected</span>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => deleteIds(chosen, `${chosen.length} alert${chosen.length === 1 ? "" : "s"}`)}
              disabled={remove.isPending}
            >
              <Trash2 /> Delete selected
            </Button>
          </>
        )}
        {all.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => deleteIds(null, `all ${all.length} alerts`)}
            disabled={remove.isPending}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete all
          </Button>
        )}
      </CardHeader>
      {remove.error && (
        <div className="p-4 pb-0">
          <ErrorAlert title="Not deleted" error={remove.error} />
        </div>
      )}
      {!all.length ? (
        <p className="text-muted-foreground p-4 text-sm">No alerts raised yet.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select the alerts on this page"
                    className="accent-primary size-4"
                    checked={pageChosen}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        for (const id of pageIds) {
                          if (pageChosen) next.delete(id)
                          else next.add(id)
                        }
                        return next
                      })
                    }
                  />
                </TableHead>
                <TableHead>When</TableHead>
                <TableHead>Alert</TableHead>
                <TableHead>Log line</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pager.items.map((e: AlertEvent) => (
                <TableRow key={e.id} className={cn(selected.has(e.id) && "bg-accent/40")}>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`Select the alert of ${formatDateTime(e.at)}`}
                      className="accent-primary size-4"
                      checked={selected.has(e.id)}
                      onChange={() => toggle(e.id)}
                    />
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.at)}</TableCell>
                  <TableCell className="text-sm">
                    <div className="font-medium">{e.rule}</div>
                    <div className={cn("text-xs", SEVERITY_STYLE[e.severity])}>
                      {e.severity} ·{" "}
                      {canOpenRuns ? (
                        <Link to={`/runs/${e.run_id}`} className="hover:underline">
                          {e.pipeline} / {e.task}
                        </Link>
                      ) : (
                        `${e.pipeline} / ${e.task}`
                      )}
                      {e.suppressed > 0 && ` · +${e.suppressed} during cooldown`}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-96 font-mono text-xs break-all whitespace-normal">{e.line}</TableCell>
                  <TableCell className="text-xs whitespace-normal">
                    {e.note && <span className="text-muted-foreground">{e.note}</span>}
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(e.deliveries).map(([cid, d]) => {
                        const Icon = CHANNEL_ICONS[d.kind] ?? Send
                        return (
                          <Badge
                            key={cid}
                            variant="outline"
                            title={d.error ?? d.status}
                            className={cn(
                              "gap-1 font-normal",
                              d.status === "failed" && "text-destructive",
                              d.status === "sent" && "text-status-succeeded",
                            )}
                          >
                            <Icon className="size-3" /> {d.channel}{" "}
                            {d.status === "sending" ? "…" : d.status === "sent" ? "✓" : "✗"}
                          </Badge>
                        )
                      })}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Delete the alert of ${formatDateTime(e.at)}`}
                      onClick={() => deleteIds([e.id], "this alert")}
                      disabled={remove.isPending}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-2 pb-2">
            <Pager pagination={pager} label="alerts" />
          </div>
        </>
      )}
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}
