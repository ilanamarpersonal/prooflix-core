import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PAGE_SIZES, type Pagination } from "@/lib/use-pagination"

/** Footer under a paged table: rows per page, the range shown, and page buttons. */
export function Pager<T>({ pagination, label = "rows" }: { pagination: Pagination<T>; label?: string }) {
  const { page, pageCount, pageSize, total, from, to, setPage, setPageSize } = pagination
  if (!total) return null
  return (
    <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t px-2 pt-2 text-xs">
      <label className="flex items-center gap-2">
        Rows per page
        <select
          className="border-input bg-background text-foreground focus-visible:ring-ring/50 h-7 rounded-md border px-1.5 text-xs outline-none focus-visible:ring-[3px]"
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          {from}–{to} of {total} {label}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="First page"
            disabled={page <= 1}
            onClick={() => setPage(1)}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="text-foreground min-w-16 text-center tabular-nums">
            Page {page} of {pageCount}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Last page"
            disabled={page >= pageCount}
            onClick={() => setPage(pageCount)}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
