import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDownToLine,
  CornerDownLeft,
  History,
  Library,
  Loader2,
  LogOut,
  Moon,
  Play,
  Plus,
  Search,
  SquareTerminal,
  Table2,
  UserPlus,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import { IconTile } from "@/components/icon-tile"
import { api, useLogout } from "@/lib/api"
import type { Section } from "@/lib/tabs"
import type { AppUser } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Command {
  id: string
  group: string
  label: string
  /** shown on the right: what kind of thing it is, a status */
  hint?: string
  icon: LucideIcon | ((props: { className?: string }) => React.ReactElement)
  /** a page: shown with its menu tile */
  page?: boolean
  color?: string
  /** extra words it is found by */
  keywords?: string
  run: () => void | Promise<unknown>
}

const GROUP_ORDER = ["Go to", "Actions", "Pipelines", "Ingestion jobs", "Tables", "Recent runs"]
const PER_GROUP = 6

/**
 * Ctrl/Cmd+K: jump to any page, pipeline, run or table, or run an action, by typing.
 * It only offers what the user's tabs allow (the server checks again).
 */
export function CommandPalette({
  sections,
  user,
  onClose,
}: {
  sections: Section[]
  user: AppUser | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const logout = useLogout()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const has = (id: string) => sections.some((s) => s.id === id)

  // fetched only while the palette is open, and only for tabs the user has
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: api.listPipelines, enabled: has("pipelines") })
  const runs = useQuery({
    queryKey: ["runs", { rootOnly: true, limit: 15 }],
    queryFn: () => api.listRuns({ rootOnly: true, limit: 15 }),
    enabled: has("pipelines"),
  })
  const tables = useQuery({
    queryKey: ["sql", "tables"],
    queryFn: api.sqlTables,
    enabled: has("sql") || has("catalog"),
  })
  const jobs = useQuery({ queryKey: ["ingestion", "jobs"], queryFn: api.ingestionJobs, enabled: has("ingestion") })
  const loading = pipelines.isLoading || tables.isLoading || jobs.isLoading

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    const go = (path: string, state?: unknown) => () => navigate(path, state ? { state } : undefined)
    for (const s of sections) {
      out.push({
        id: `go:${s.id}`,
        group: "Go to",
        label: s.label,
        icon: s.icon,
        page: true,
        color: s.color,
        hint: "page",
        run: go(s.home),
      })
    }
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
    if (user?.role === "admin" && has("users"))
      out.push({ id: "add-user", group: "Actions", label: "Add user", icon: UserPlus, run: go("/users") })
    out.push({
      id: "theme",
      group: "Actions",
      label: "Switch dark or light mode",
      icon: Moon,
      keywords: "theme dark light",
      run: () => {
        const dark = !document.documentElement.classList.contains("dark")
        document.documentElement.classList.toggle("dark", dark)
        try {
          localStorage.setItem("prooflix-theme", dark ? "dark" : "light")
        } catch {
          /* storage unavailable */
        }
      },
    })
    if (user)
      out.push({
        id: "sign-out",
        group: "Actions",
        label: "Sign out",
        icon: LogOut,
        keywords: "logout",
        run: () => logout.mutateAsync(undefined),
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
      if (p.valid && Object.keys(p.parameters).length === 0)
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
  }, [sections, user, pipelines.data, runs.data, tables.data, jobs.data])

  // every typed word must appear (any order); labels that start with the query rank first
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = commands
      .map((c) => {
        const label = c.label.toLowerCase()
        const text = `${label} ${(c.keywords ?? "").toLowerCase()} ${c.group.toLowerCase()}`
        if (!words.every((w) => text.includes(w))) return null
        const score = !words.length ? 0 : label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2
        return { c, score }
      })
      .filter((m): m is { c: Command; score: number } => m !== null)
    const grouped: Command[] = []
    for (const g of GROUP_ORDER) {
      if (!words.length && g !== "Go to" && g !== "Actions" && g !== "Recent runs") continue
      const inGroup = matches
        .filter((m) => m.c.group === g)
        .sort((a, b) => a.score - b.score)
        .slice(0, !words.length && g === "Actions" ? 5 : !words.length && g === "Recent runs" ? 3 : PER_GROUP)
      grouped.push(...inGroup.map((m) => m.c))
    }
    return grouped
  }, [commands, query])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index])

  const runCommand = async (c: Command) => {
    setError(null)
    setBusy(c.id)
    try {
      await c.run()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, shown.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter" && shown[index]) {
      e.preventDefault()
      void runCommand(shown[index])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Search and run commands"
        className="bg-popover text-popover-foreground w-full max-w-xl overflow-hidden rounded-lg border shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pipelines, runs, tables, pages, or type an action"
            className="h-12 w-full bg-transparent text-sm outline-none"
            role="combobox"
            aria-expanded
            aria-controls="command-list"
            aria-activedescendant={shown[index] ? `cmd-${index}` : undefined}
          />
          {loading && <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />}
          <kbd className="bg-muted text-muted-foreground rounded px-1.5 font-mono text-xs">esc</kbd>
        </div>
        <div ref={listRef} id="command-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
          {shown.length === 0 && <p className="text-muted-foreground px-3 py-6 text-center text-sm">No match.</p>}
          {shown.map((c, i) => {
            const header = i === 0 || shown[i - 1].group !== c.group
            const Icon = c.icon
            return (
              <div key={c.id}>
                {header && <div className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">{c.group}</div>}
                <div
                  id={`cmd-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => void runCommand(c)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm",
                    i === index && "bg-accent",
                  )}
                >
                  {busy === c.id ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                  ) : c.page ? (
                    <IconTile icon={Icon} color={c.color} className="size-5 [&>svg]:size-3" />
                  ) : (
                    <Icon className="text-muted-foreground size-4 shrink-0" />
                  )}
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{c.hint}</span>}
                  {i === index && <CornerDownLeft className="text-muted-foreground size-3.5 shrink-0" />}
                </div>
              </div>
            )
          })}
        </div>
        {error && <p className="text-destructive border-t px-3 py-2 text-xs">{error}</p>}
        <div className="text-muted-foreground flex gap-4 border-t px-3 py-1.5 text-xs">
          <span>↑ ↓ to move</span>
          <span>Enter to open or run</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
