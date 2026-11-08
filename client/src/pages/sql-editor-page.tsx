import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { ChevronRight, Loader2, Play, RefreshCw, Table2 } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useSqlQuery, useSqlTables } from "@/lib/api"
import type { SqlResult, SqlTable } from "@/lib/types"
import { cn } from "@/lib/utils"

const DRAFT_KEY = "prooflix-sql-draft"
const DEFAULT_SQL = "SELECT country, COUNT(*) AS orders, SUM(amount) AS total\nFROM orders\nGROUP BY country\nORDER BY total DESC;"

// Kept outside the component so the last result is still there when you
// switch to another tab and come back.
let lastResult: SqlResult | null = null

function loadDraft() {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? DEFAULT_SQL
  } catch {
    return DEFAULT_SQL
  }
}

export function SqlEditorPage() {
  const [sql, setSql] = useState(loadDraft)
  const [result, setResult] = useState<SqlResult | null>(lastResult)
  const query = useSqlQuery()
  const tables = useSqlTables()
  const editor = useRef<HTMLTextAreaElement>(null)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, sql)
    } catch {
      /* storage unavailable */
    }
  }, [sql])

  const run = (text = sql) => {
    if (!text.trim()) return
    query.mutate(
      { sql: text },
      {
        onSuccess: (r) => {
          lastResult = r
          setResult(r)
        },
      },
    )
  }

  // "Query in SQL Editor" from the Workspace tab hands over a query to run.
  useEffect(() => {
    const handed = (location.state as { sql?: string } | null)?.sql
    if (handed) {
      setSql(handed)
      run(handed)
      navigate(location.pathname, { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  const insert = (text: string) => {
    const el = editor.current
    if (!el) return setSql((s) => s + text)
    const { selectionStart: s, selectionEnd: e } = el
    setSql(sql.slice(0, s) + text + sql.slice(e))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + text.length, s + text.length)
    })
  }

  return (
    <>
      <PageHeader
        title="SQL Editor"
        description={
          <>
            Read-only SQL (SQLite) over the CSV and JSON files in{" "}
            <code className="font-mono">workspace/data/</code>
          </>
        }
      />
      <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        <TableList tables={tables.data} loading={tables.isLoading} error={tables.error} onRefresh={() => tables.refetch()} refreshing={tables.isFetching} onInsert={insert} />

        <div className="grid min-w-0 content-start gap-3">
          <Textarea
            ref={editor}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            aria-label="SQL query"
            className="min-h-44 font-mono text-sm leading-relaxed md:text-[13px]"
            onKeyDown={(e) => {
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
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => run()} disabled={query.isPending || !sql.trim()}>
              {query.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
            </Button>
            <span className="text-muted-foreground text-xs">
              <kbd className="font-sans">⌘</kbd>/<kbd className="font-sans">Ctrl</kbd> + Enter runs the
              query, or just the selected text
            </span>
            {result && !query.isPending && (
              <span className="text-muted-foreground ml-auto text-xs">
                {result.row_count} row{result.row_count === 1 ? "" : "s"}
                {result.truncated && " (first rows only)"} · {result.elapsed_ms} ms
              </span>
            )}
          </div>
          {query.error && <ErrorAlert title="Query failed" error={query.error} />}
          {result && <ResultTable result={result} />}
        </div>
      </div>
    </>
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
  return (
    <Card className="max-h-[70vh] gap-0 overflow-auto py-0">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Tables</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={onRefresh} aria-label="Refresh tables">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      {error ? (
        <div className="p-2">
          <ErrorAlert error={error} />
        </div>
      ) : loading ? (
        <Skeleton className="m-2 h-40" />
      ) : !tables?.length ? (
        <p className="text-muted-foreground p-3 text-sm">
          No CSV or JSON files in <code className="font-mono">workspace/data/</code> yet.
        </p>
      ) : (
        <div className="py-1">
          {tables.map((t) => (
            <TableItem key={t.name} table={t} onInsert={onInsert} />
          ))}
        </div>
      )}
      <p className="text-muted-foreground border-t px-3 py-2 text-xs">Click a name to add it to the query.</p>
    </Card>
  )
}

function TableItem({ table, onInsert }: { table: SqlTable; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div className="hover:bg-accent flex items-center gap-1 px-1.5 text-sm">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-label={open ? "Hide columns" : "Show columns"}
          aria-expanded={open}
          className="grid size-5 shrink-0 place-items-center"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => onInsert(table.name)}
          title={`${table.source} · ${table.row_count} rows`}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        >
          <Table2 className="text-primary size-4 shrink-0" />
          <span className="truncate font-mono text-xs">{table.name}</span>
        </button>
      </div>
      {open && (
        <div className="pb-1">
          {table.columns.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => onInsert(c.name)}
              className="hover:bg-accent flex w-full items-center justify-between gap-2 py-0.5 pr-3 pl-11 text-left"
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

function formatCell(v: unknown) {
  if (v === null || v === undefined) return <span className="text-muted-foreground italic">NULL</span>
  return String(v)
}

function ResultTable({ result }: { result: SqlResult }) {
  if (!result.columns.length) {
    return <Card className="text-muted-foreground p-4 text-sm">The query returned no columns.</Card>
  }
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="max-h-[55vh] overflow-auto">
        <Table>
          <TableHeader className="bg-muted sticky top-0 z-[1]">
            <TableRow>
              {result.columns.map((c, i) => (
                <TableHead key={i} className="font-mono text-xs">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={result.columns.length} className="text-muted-foreground text-center">
                  No rows
                </TableCell>
              </TableRow>
            ) : (
              result.rows.map((row, r) => (
                <TableRow key={r}>
                  {row.map((v, c) => (
                    <TableCell
                      key={c}
                      className={cn("font-mono text-xs", typeof v === "number" && "text-right tabular-nums")}
                    >
                      {formatCell(v)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}
