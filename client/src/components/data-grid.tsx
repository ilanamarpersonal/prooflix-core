import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const PAGE_SIZES = [10, 25, 50, 100, 500]
const PAGE_SIZE_KEY = "prooflix-grid-page-size"

function loadPageSize(fallback: number) {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY))
    return PAGE_SIZES.includes(n) ? n : fallback
  } catch {
    return fallback
  }
}

function formatCell(v: unknown) {
  if (v === null || v === undefined) return <span className="text-muted-foreground italic">NULL</span>
  return String(v)
}

/**
 * A result grid: numeric columns (every non-null value is a number) are
 * right-aligned, headers included, and rows are shown one page at a time
 * with the pager in the bottom-right corner.
 */
export function DataGrid({
  columns,
  rows,
  defaultPageSize = 25,
  maxHeight = "max-h-[60vh]",
  footerNote,
  className,
}: {
  columns: string[]
  rows: unknown[][]
  defaultPageSize?: number
  maxHeight?: string
  /** shown at the bottom left, e.g. "first 10,000 rows only" */
  footerNote?: React.ReactNode
  /** extra classes for the outer card, e.g. to let it fill a flex column */
  className?: string
}) {
  const [pageSize, setPageSize] = useState(() => loadPageSize(defaultPageSize))
  const [page, setPage] = useState(0)

  // A new result starts on the first page.
  useEffect(() => setPage(0), [rows])

  const numeric = useMemo(
    () =>
      columns.map((_, c) => {
        let seen = false
        for (const row of rows) {
          const v = row[c]
          if (v === null || v === undefined) continue
          if (typeof v !== "number") return false
          seen = true
        }
        return seen
      }),
    [columns, rows],
  )

  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const current = Math.min(page, pages - 1)
  const start = current * pageSize
  const visible = rows.slice(start, start + pageSize)

  const changePageSize = (n: number) => {
    setPageSize(n)
    setPage(Math.floor(start / n))
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(n))
    } catch {
      /* storage unavailable */
    }
  }

  if (!columns.length) {
    return <Card className="text-muted-foreground p-4 text-sm">The query returned no columns.</Card>
  }

  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      <div className={cn("overflow-auto", maxHeight)}>
        <table className="w-full caption-bottom font-mono text-xs">
          <thead className="bg-muted sticky top-0 z-[1]">
            <tr className="border-b">
              {columns.map((c, i) => (
                <th
                  key={i}
                  scope="col"
                  className={cn(
                    "text-muted-foreground h-9 px-3 font-medium whitespace-nowrap",
                    numeric[i] ? "text-right" : "text-left",
                  )}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-muted-foreground px-3 py-6 text-center font-sans">
                  No rows
                </td>
              </tr>
            ) : (
              visible.map((row, r) => (
                <tr key={start + r} className="hover:bg-muted/50 border-b last:border-0">
                  {columns.map((_, c) => (
                    <td
                      key={c}
                      className={cn(
                        "px-3 py-2 whitespace-nowrap",
                        numeric[c] ? "text-right tabular-nums" : "text-left",
                      )}
                    >
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-3 py-2 text-xs">
        <span className="mr-auto">{footerNote}</span>
        <label className="flex items-center gap-2">
          Rows per page
          <select
            value={pageSize}
            onChange={(e) => changePageSize(Number(e.target.value))}
            className="bg-background text-foreground h-7 rounded-md border px-1.5"
            aria-label="Rows per page"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="tabular-nums">
          {rows.length === 0
            ? "0 rows"
            : `${(start + 1).toLocaleString()}–${Math.min(start + pageSize, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setPage(0)}
            disabled={current === 0}
            aria-label="First page"
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <span className="px-1 tabular-nums">
            Page {current + 1} of {pages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setPage(current + 1)}
            disabled={current >= pages - 1}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-7"
            onClick={() => setPage(pages - 1)}
            disabled={current >= pages - 1}
            aria-label="Last page"
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </Card>
  )
}
