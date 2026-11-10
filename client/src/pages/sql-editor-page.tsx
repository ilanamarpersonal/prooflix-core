import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import {
  ChevronRight,
  Layers,
  Library,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  Table2,
  X,
} from "lucide-react"

import { DataGrid } from "@/components/data-grid"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useSqlQuery, useSqlTables } from "@/lib/api"
import { caretPosition, completeAt, type Completion, type Suggestion } from "@/lib/sql-completion"
import type { SqlResult, SqlTable } from "@/lib/types"
import { useFillHeight } from "@/lib/use-fill-height"
import { cn } from "@/lib/utils"

const TABS_KEY = "prooflix-sql-tabs"
const OLD_DRAFT_KEY = "prooflix-sql-draft" // single query kept by earlier versions
const DEFAULT_SQL = "-- Tables are listed on the left; a project's tables are written schema.table\nSELECT 1;"

interface QueryTab {
  id: string
  title: string
  sql: string
}

interface TabsState {
  tabs: QueryTab[]
  active: string
}

// Results are kept outside the components, per query tab, so they are still
// there when you switch query tabs or leave the SQL Editor and come back.
const results = new Map<string, SqlResult>()

const newId = () => Math.random().toString(36).slice(2, 10)

const EDITOR_HEIGHT_KEY = "prooflix-sql-editor-height"
const DEFAULT_EDITOR_HEIGHT = 176
const MIN_EDITOR_HEIGHT = 96
const MIN_RESULTS_HEIGHT = 160 // the divider never squeezes the results below this
const KEY_STEP = 24 // px per arrow key on the divider

function loadEditorHeight() {
  try {
    const h = Number(localStorage.getItem(EDITOR_HEIGHT_KEY))
    return h >= MIN_EDITOR_HEIGHT && h <= 2000 ? h : DEFAULT_EDITOR_HEIGHT
  } catch {
    return DEFAULT_EDITOR_HEIGHT
  }
}

function saveEditorHeight(h: number) {
  try {
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(Math.round(h)))
  } catch {
    /* storage unavailable */
  }
}

function nextTitle(tabs: QueryTab[]) {
  const used = new Set(tabs.map((t) => t.title))
  let n = 1
  while (used.has(`Query ${n}`)) n++
  return `Query ${n}`
}

function loadTabs(): TabsState {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (raw) {
      const s = JSON.parse(raw) as TabsState
      if (Array.isArray(s.tabs) && s.tabs.length) {
        return { tabs: s.tabs, active: s.tabs.some((t) => t.id === s.active) ? s.active : s.tabs[0].id }
      }
    }
    const first = { id: newId(), title: "Query 1", sql: localStorage.getItem(OLD_DRAFT_KEY) ?? DEFAULT_SQL }
    return { tabs: [first], active: first.id }
  } catch {
    const first = { id: newId(), title: "Query 1", sql: DEFAULT_SQL }
    return { tabs: [first], active: first.id }
  }
}

export function SqlEditorPage() {
  const [state, setState] = useState<TabsState>(loadTabs)
  const tables = useSqlTables()
  const location = useLocation()
  const navigate = useNavigate()
  const editorApi = useRef<{ insert: (text: string) => void } | null>(null)
  // On md+ screens the schemas and the editor column fill the window; the
  // divider splits the column between the editor and the results.
  const panels = useRef<HTMLDivElement>(null)
  const panelsHeight = useFillHeight(panels)
  const autoRun = useRef<string | null>(null) // tab id to run once it shows
  const handled = useRef<string | null>(null) // location key of the last handed-over query

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable */
    }
  }, [state])

  const active = state.tabs.find((t) => t.id === state.active) ?? state.tabs[0]

  const addTab = (sql = "", title?: string) => {
    const tab = { id: newId(), title: title ?? "", sql }
    setState((prev) => {
      tab.title = title ?? nextTitle(prev.tabs)
      return { tabs: [...prev.tabs, tab], active: tab.id }
    })
    return tab.id
  }

  const closeTab = (id: string) => {
    results.delete(id)
    setState((prev) => {
      const index = prev.tabs.findIndex((t) => t.id === id)
      const tabs = prev.tabs.filter((t) => t.id !== id)
      if (!tabs.length) {
        const fresh = { id: newId(), title: "Query 1", sql: "" }
        return { tabs: [fresh], active: fresh.id }
      }
      const active = prev.active === id ? (tabs[index] ?? tabs[index - 1]).id : prev.active
      return { tabs, active }
    })
  }

  const updateTab = (id: string, change: Partial<QueryTab>) =>
    setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === id ? { ...t, ...change } : t)) }))

  // "Query in SQL Editor" from the Catalog or Workspace opens the query in a new tab and runs it.
  useEffect(() => {
    const handed = location.state as { sql?: string; title?: string } | null
    if (handed?.sql && handled.current !== location.key) {
      handled.current = location.key
      const fromTable = /FROM\s+([\w.]+)/i.exec(handed.sql)?.[1]
      autoRun.current = addTab(handed.sql, handed.title ?? fromTable)
      navigate(location.pathname, { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  return (
    <>
      <PageHeader
        title="SQL Editor"
        description={
          <>
            Read-only SQL (SQLite) over the Parquet files in the <code className="font-mono">data/</code> folders of the
            workspace and its projects
          </>
        }
      />
      <div
        ref={panels}
        style={panelsHeight ? { height: panelsHeight } : undefined}
        className="grid items-start gap-4 md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:items-stretch"
      >
        <TableList
          tables={tables.data}
          loading={tables.isLoading}
          error={tables.error}
          onRefresh={() => tables.refetch()}
          refreshing={tables.isFetching}
          onInsert={(text) => editorApi.current?.insert(text)}
        />

        <div data-sql-column className="flex min-h-0 min-w-0 flex-col gap-3">
          <QueryTabsBar
            tabs={state.tabs}
            active={active.id}
            onSelect={(id) => setState((prev) => ({ ...prev, active: id }))}
            onAdd={() => addTab()}
            onClose={closeTab}
            onRename={(id, title) => updateTab(id, { title })}
          />
          <QueryEditor
            key={active.id}
            tab={active}
            onSqlChange={(sql) => updateTab(active.id, { sql })}
            runOnMount={autoRun.current === active.id}
            onMounted={() => {
              if (autoRun.current === active.id) autoRun.current = null
            }}
            apiRef={editorApi}
            tables={tables.data ?? []}
          />
        </div>
      </div>
    </>
  )
}

/** The query tabs above the editor, with the Add query button at the end. */
function QueryTabsBar({
  tabs,
  active,
  onSelect,
  onAdd,
  onClose,
  onRename,
}: {
  tabs: QueryTab[]
  active: string
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <div role="tablist" aria-label="Queries" className="flex items-end gap-1 overflow-x-auto border-b">
      {tabs.map((t) => {
        const isActive = t.id === active
        return (
          <div
            key={t.id}
            className={cn(
              "group -mb-px flex h-8 shrink-0 items-center rounded-t-md border border-b-0 text-sm",
              isActive
                ? "bg-background border-border font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {editing === t.id ? (
              <input
                autoFocus
                defaultValue={t.title}
                aria-label="Query name"
                className="bg-background mx-1 h-6 w-32 rounded border px-1.5 text-sm"
                onBlur={(e) => {
                  if (editing !== t.id) return
                  onRename(t.id, e.target.value.trim() || t.title)
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onRename(t.id, e.currentTarget.value.trim() || t.title)
                    setEditing(null)
                  }
                  if (e.key === "Escape") setEditing(null)
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onSelect(t.id)}
                onDoubleClick={() => setEditing(t.id)}
                onAuxClick={(e) => e.button === 1 && onClose(t.id)}
                title="Double-click to rename"
                className="h-full max-w-48 truncate pr-1 pl-3"
              >
                {t.title}
              </button>
            )}
            <button
              type="button"
              onClick={() => onClose(t.id)}
              aria-label={`Close ${t.title}`}
              className={cn(
                "hover:bg-accent mr-1 grid size-5 place-items-center rounded",
                !isActive && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
      <Button variant="ghost" size="sm" className="mb-0.5 h-7 shrink-0" onClick={onAdd}>
        <Plus /> Add query
      </Button>
    </div>
  )
}

/** One query tab: its SQL, Run button and results. */
function QueryEditor({
  tab,
  onSqlChange,
  runOnMount,
  onMounted,
  apiRef,
  tables,
}: {
  tab: QueryTab
  onSqlChange: (sql: string) => void
  runOnMount: boolean
  onMounted: () => void
  apiRef: React.MutableRefObject<{ insert: (text: string) => void } | null>
  /** for code completion: schema. -> tables, schema.table. -> columns */
  tables: SqlTable[]
}) {
  const sql = tab.sql
  const [result, setResult] = useState<SqlResult | null>(results.get(tab.id) ?? null)
  const query = useSqlQuery()
  const editor = useRef<HTMLTextAreaElement>(null)
  const [height, setHeight] = useState(loadEditorHeight)
  const [expanded, setExpanded] = useState(false)

  const resultsArea = useRef<HTMLDivElement>(null)

  /** Tallest the editor may get: on md+ screens, where the column fills the
   * window, whatever the editor grows by comes out of the results, which keep
   * at least MIN_RESULTS_HEIGHT. */
  const maxEditorHeight = () => {
    const results = resultsArea.current
    if (!results || window.innerWidth < 768) return 2000
    return Math.max(MIN_EDITOR_HEIGHT, height + results.getBoundingClientRect().height - MIN_RESULTS_HEIGHT)
  }
  const resize = (h: number, save = false) => {
    const next = Math.round(Math.min(Math.max(h, MIN_EDITOR_HEIGHT), maxEditorHeight()))
    setHeight(next)
    if (save) saveEditorHeight(next)
    return next
  }

  const [completion, setCompletion] = useState<(Completion & { index: number; left: number; top: number }) | null>(null)

  const suggest = (text: string, cursor: number, force = false) => {
    const el = editor.current
    const found = el ? completeAt(text, cursor, tables, { force }) : null
    if (!el || !found) return setCompletion(null)
    const caret = caretPosition(el, found.from)
    setCompletion({ ...found, index: 0, left: caret.left, top: caret.top + caret.height })
  }

  const accept = (item: Suggestion) => {
    const el = editor.current
    if (!el || !completion) return
    const next = sql.slice(0, completion.from) + item.insert + sql.slice(completion.to)
    const at = completion.from + item.insert.length
    onSqlChange(next)
    setCompletion(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(at, at)
    })
  }

  const run = (text = sql) => {
    if (!text.trim()) return
    query.mutate(
      { sql: text, limit: 10000 },
      {
        onSuccess: (r) => {
          results.set(tab.id, r)
          setResult(r)
        },
      },
    )
  }

  useEffect(() => {
    if (runOnMount) run()
    onMounted()
    editor.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const insert = (text: string) => {
    const el = editor.current
    if (!el) return onSqlChange(sql + text)
    const { selectionStart: s, selectionEnd: e } = el
    onSqlChange(sql.slice(0, s) + text + sql.slice(e))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + text.length, s + text.length)
    })
  }
  apiRef.current = { insert }

  return (
    <>
      <div className="relative shrink-0">
        <Textarea
          ref={editor}
          value={sql}
          onChange={(e) => {
            onSqlChange(e.target.value)
            const el = e.currentTarget
            const typed = (e.nativeEvent as InputEvent).inputType?.startsWith("insert")
            // suggest while typing (e.g. right after "banking."), not after deleting
            if (typed || completion) suggest(e.target.value, el.selectionStart)
          }}
          onBlur={() => setTimeout(() => setCompletion(null), 150)}
          onClick={() => setCompletion(null)}
          onScroll={() => setCompletion(null)}
          spellCheck={false}
          aria-label="SQL query"
          aria-autocomplete="list"
          aria-expanded={!!completion}
          placeholder="Write a query, for example SELECT * FROM banking.customers"
          style={{ height: expanded ? "calc(100svh - 17rem)" : height }}
          className="min-h-24 resize-none pr-10 font-mono text-sm leading-relaxed field-sizing-fixed md:text-[13px]"
          onKeyDown={(e) => {
            if (completion) {
              const count = completion.items.length
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const step = e.key === "ArrowDown" ? 1 : -1
                setCompletion({ ...completion, index: (completion.index + step + count) % count })
                return
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                accept(completion.items[completion.index])
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setCompletion(null)
                return
              }
            }
            if (e.key === "Escape" && expanded) {
              e.preventDefault()
              setExpanded(false)
              return
            }
            if (e.key === " " && e.ctrlKey) {
              // Ctrl+Space: suggest schemas, tables or columns at the cursor
              e.preventDefault()
              suggest(e.currentTarget.value, e.currentTarget.selectionStart, true)
              return
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault()
              const el = e.currentTarget
              const selected = sql.slice(el.selectionStart, el.selectionEnd)
              run(selected.trim() ? selected : sql)
            }
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault()
              insert("  ")
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="bg-background/80 absolute top-1.5 right-1.5 size-7"
          onClick={() => {
            setExpanded(!expanded)
            requestAnimationFrame(() => editor.current?.focus())
          }}
          title={expanded ? "Collapse the editor (Esc)" : "Expand the editor"}
          aria-label={expanded ? "Collapse the editor" : "Expand the editor"}
          aria-pressed={expanded}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        {completion && (
          <ul
            role="listbox"
            aria-label="Suggestions"
            className="bg-popover text-popover-foreground absolute z-20 max-h-60 min-w-56 overflow-auto rounded-md border p-1 font-mono text-xs shadow-md"
            style={{ left: Math.max(0, completion.left), top: completion.top + 2 }}
          >
            {completion.items.map((item, i) => (
              <li
                key={`${item.kind}:${item.label}`}
                role="option"
                aria-selected={i === completion.index}
                onMouseDown={(e) => {
                  e.preventDefault() // keep focus in the editor
                  accept(item)
                }}
                onMouseEnter={() => setCompletion({ ...completion, index: i })}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-2 py-1",
                  i === completion.index && "bg-accent",
                )}
              >
                {item.kind === "schema" ? (
                  <Layers className="text-primary size-3.5 shrink-0" />
                ) : item.kind === "table" ? (
                  <Table2 className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <span className="text-muted-foreground w-3.5 shrink-0 text-center">·</span>
                )}
                <span className="truncate">{item.label}</span>
                {item.detail && <span className="text-muted-foreground ml-auto pl-3 font-sans">{item.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Button onClick={() => run()} disabled={query.isPending || !sql.trim()}>
          {query.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
        </Button>
        <span className="text-muted-foreground text-xs">
          <kbd className="font-sans">⌘</kbd>/<kbd className="font-sans">Ctrl</kbd> + Enter runs the query, or just the
          selected text · type <code className="font-mono">schema.</code> for its tables,{" "}
          <kbd className="font-sans">Ctrl</kbd> + Space for suggestions
        </span>
        {result && !query.isPending && (
          <span className="text-muted-foreground ml-auto text-xs">
            {result.row_count.toLocaleString()} row{result.row_count === 1 ? "" : "s"}
            {result.truncated && " (first 10,000 only)"} · {result.elapsed_ms} ms
          </span>
        )}
      </div>
      {!expanded && (
        <Divider
          height={height}
          onDrag={(h) => resize(h)}
          onDone={(h) => resize(h, true)}
          onReset={() => resize(DEFAULT_EDITOR_HEIGHT, true)}
          max={maxEditorHeight}
        />
      )}
      {query.error && (
        <div className="shrink-0">
          <ErrorAlert title="Query failed" error={query.error} />
        </div>
      )}
      <div ref={resultsArea} className="flex min-h-0 flex-col md:flex-1">
        {result ? (
          <ResultTable result={result} />
        ) : (
          <Card className="text-muted-foreground grid min-h-32 place-items-center p-6 text-sm md:flex-1">
            Run a query to see its results here.
          </Card>
        )}
      </div>
    </>
  )
}

/**
 * The bar between the SQL editor and the results. Drag it (or focus it and use
 * the arrow keys) to make the editor taller or shorter; the results take the
 * rest of the space. Double-click to go back to the default height.
 */
function Divider({
  height,
  onDrag,
  onDone,
  onReset,
  max,
}: {
  height: number
  onDrag: (h: number) => number
  onDone: (h: number) => void
  onReset: () => void
  max: () => number
}) {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ y: number; h: number } | null>(null)

  // While dragging, keep the page from selecting text and show the resize cursor everywhere.
  useEffect(() => {
    if (!dragging) return
    const { userSelect, cursor } = document.body.style
    document.body.style.userSelect = "none"
    document.body.style.cursor = "row-resize"
    return () => {
      document.body.style.userSelect = userSelect
      document.body.style.cursor = cursor
    }
  }, [dragging])

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the editor and the results"
      aria-valuenow={height}
      aria-valuemin={MIN_EDITOR_HEIGHT}
      aria-valuemax={max()}
      tabIndex={0}
      title="Drag to resize the editor and the results · double-click to reset"
      className="group -my-1.5 flex h-4 shrink-0 cursor-row-resize touch-none items-center outline-none"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { y: e.clientY, h: height }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (start.current) onDrag(start.current.h + e.clientY - start.current.y)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        onDone(start.current.h + e.clientY - start.current.y)
        start.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault()
          onDone(height + (e.key === "ArrowDown" ? KEY_STEP : -KEY_STEP))
        }
      }}
    >
      <div
        className={cn(
          "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary relative h-px w-full transition-colors",
          dragging && "bg-primary",
        )}
      >
        <span
          className={cn(
            "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary absolute top-1/2 left-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
            dragging && "bg-primary",
          )}
        />
      </div>
    </div>
  )
}

function TableList({
  tables,
  loading,
  error,
  refreshing,
  onRefresh,
  onInsert,
}: {
  tables?: SqlTable[]
  loading: boolean
  error: unknown
  refreshing: boolean
  onRefresh: () => void
  onInsert: (text: string) => void
}) {
  // schema -> its tables, in the order the server lists them
  const bySchema = new Map<string, SqlTable[]>()
  for (const t of tables ?? []) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t])

  return (
    <Card className="max-h-[60vh] gap-0 overflow-hidden py-0 md:h-full md:max-h-none">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Schemas</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onRefresh} aria-label="Refresh tables">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      {/* the tree fills the panel's height and scrolls inside it */}
      <div className="min-h-40 flex-1 overflow-auto">
        {error ? (
          <div className="p-2">
            <ErrorAlert error={error} />
          </div>
        ) : loading ? (
          <Skeleton className="m-2 h-40" />
        ) : !bySchema.size ? (
          <p className="text-muted-foreground p-3 text-sm">No tables yet. Import Parquet files in the Catalog tab.</p>
        ) : (
          <div className="py-1">
            {groupByCatalog(bySchema).map(({ catalog, schemas }) =>
              catalog ? (
                <CatalogItem key={`catalog:${catalog}`} catalog={catalog}>
                  {schemas.map(([schema, list]) => (
                    <SchemaItem key={schema} schema={schema} tables={list} onInsert={onInsert} catalog={catalog} />
                  ))}
                </CatalogItem>
              ) : (
                schemas.map(([schema, list]) => (
                  <SchemaItem key={schema} schema={schema} tables={list} onInsert={onInsert} />
                ))
              ),
            )}
          </div>
        )}
      </div>
      <p className="text-muted-foreground shrink-0 border-t px-3 py-2 text-xs">
        Click a table to see its columns, and a column to type its name into the query at the cursor.
      </p>
    </Card>
  )
}

/** Schemas in server order, with the schemas of each catalog gathered under it. */
function groupByCatalog(bySchema: Map<string, SqlTable[]>): { catalog: string; schemas: [string, SqlTable[]][] }[] {
  const groups: { catalog: string; schemas: [string, SqlTable[]][] }[] = []
  for (const entry of bySchema) {
    const catalog = entry[1][0]?.catalog ?? ""
    const last = groups[groups.length - 1]
    if (catalog && last?.catalog === catalog) last.schemas.push(entry)
    else groups.push({ catalog, schemas: [entry] })
  }
  return groups
}

/** A catalog (a tenant folder in data/) and its schemas, such as bronze and gold. */
function CatalogItem({ catalog, children }: { catalog: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? `Collapse catalog ${catalog}` : `Expand catalog ${catalog}`}
        className="hover:bg-accent flex w-full items-center gap-1.5 px-1.5 py-1 text-left text-sm"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Library className="text-primary size-4 shrink-0" />
        <span className="truncate font-mono text-xs font-medium">{catalog}</span>
        <span className="text-muted-foreground ml-auto text-[10px] tracking-wide uppercase">catalog</span>
      </button>
      {open && children}
    </div>
  )
}

function SchemaItem({
  schema,
  tables,
  onInsert,
  catalog = "",
}: {
  schema: string
  tables: SqlTable[]
  onInsert: (text: string) => void
  /** set inside a catalog: indented and labelled with the schema's own name ("bronze") */
  catalog?: string
}) {
  const [open, setOpen] = useState(true)
  const nested = !!catalog
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={schema}
        className={cn(
          "hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-1.5 text-left text-sm",
          nested ? "pl-5" : "pl-1.5",
        )}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Layers className="text-primary size-4 shrink-0" />
        <span className="truncate font-mono text-xs font-medium">
          {nested ? schema.slice(catalog.length + 1) : schema}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">{tables.length}</span>
      </button>
      {open && tables.map((t) => <TableItem key={t.qualified} table={t} onInsert={onInsert} nested={nested} />)}
    </div>
  )
}

function TableItem({
  table,
  onInsert,
  nested = false,
}: {
  table: SqlTable
  onInsert: (text: string) => void
  nested?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {/* clicking a table shows or hides its columns; it doesn't type anything into the query */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? `Hide columns of ${table.name}` : `Show columns of ${table.name}`}
        title={`${table.qualified} · ${table.row_count} rows · ${table.source}`}
        className={cn(
          "hover:bg-accent flex w-full items-center gap-1 py-1 pr-2 text-left text-sm",
          nested ? "pl-9" : "pl-5",
        )}
      >
        <span className="grid size-5 shrink-0 place-items-center">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </span>
        <Table2 className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate font-mono text-xs">{table.name}</span>
      </button>
      {open && (
        <div className="pb-1">
          {table.columns.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => onInsert(c.name)}
              title={`Insert ${c.name}`}
              className={cn(
                "hover:bg-accent flex w-full items-center justify-between gap-2 py-0.5 pr-3 text-left",
                nested ? "pl-20" : "pl-16",
              )}
            >
              <span className="truncate font-mono text-xs">{c.name}</span>
              <span className="text-muted-foreground text-[10px] uppercase">{c.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultTable({ result }: { result: SqlResult }) {
  return (
    <DataGrid
      columns={result.columns}
      rows={result.rows}
      maxHeight="max-h-[60vh] md:max-h-none md:min-h-0 md:flex-1"
      className="md:min-h-0 md:flex-1"
      footerNote={result.truncated ? `Showing the first ${result.row_count.toLocaleString()} rows` : undefined}
    />
  )
}
