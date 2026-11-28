import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { CornerDownLeft, Loader2, LogOut, Moon, Search } from "lucide-react"

import { useLogout, type AuthUser } from "../auth/api"
import { IconTile } from "../components/icon-tile"
import { setTheme } from "../components/theme-toggle"
import { cn } from "../lib/utils"
import type { Section } from "./sections"

export interface Command {
  id: string
  group: string
  label: string
  /** shown on the right: what kind of thing it is, a status */
  hint?: string
  icon: (props: { className?: string }) => React.ReactNode
  /** a page: shown with its menu tile */
  page?: boolean
  color?: string
  /** extra words it is found by */
  keywords?: string
  run: () => void | Promise<unknown>
}

/** "Go to" and "Actions" come first; a product adds its own groups (Pipelines, Tables, ...) after them. */
const FIRST_GROUPS = ["Go to", "Actions"]
const PER_GROUP = 6

/**
 * Ctrl/Cmd+K in every product: jump to any page, or run an action, by typing. The product adds its
 * own commands (its pipelines, tables, ...) and their groups; it only offers what the user's tabs
 * allow (the server checks again).
 */
export function CommandPalette({
  sections,
  user,
  commands: extra,
  groups = [],
  loading = false,
  onClose,
}: {
  sections: Section[]
  user: AuthUser | null
  /** the product's own commands */
  commands: Command[]
  /** the product's groups, in order, after "Go to" and "Actions"; the last one is shown before typing */
  groups?: string[]
  loading?: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const logout = useLogout()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const GROUP_ORDER = [...FIRST_GROUPS, ...groups]
  const recent = groups[groups.length - 1]

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    for (const s of sections) {
      out.push({
        id: `go:${s.id}`,
        group: "Go to",
        label: s.label,
        icon: s.icon,
        page: true,
        color: s.color,
        hint: "page",
        run: () => navigate(s.home),
      })
    }
    out.push(...extra.filter((c) => c.group === "Actions"))
    out.push({
      id: "theme",
      group: "Actions",
      label: "Switch dark or light mode",
      icon: Moon,
      keywords: "theme dark light",
      run: () => setTheme(!document.documentElement.classList.contains("dark")),
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
    out.push(...extra.filter((c) => c.group !== "Actions"))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, user, extra])

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
      if (!words.length && g !== "Go to" && g !== "Actions" && g !== recent) continue
      const inGroup = matches
        .filter((m) => m.c.group === g)
        .sort((a, b) => a.score - b.score)
        .slice(0, !words.length && g === "Actions" ? 5 : !words.length && g === recent ? 3 : PER_GROUP)
      grouped.push(...inGroup.map((m) => m.c))
    }
    return grouped
  }, [commands, query, recent])

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
