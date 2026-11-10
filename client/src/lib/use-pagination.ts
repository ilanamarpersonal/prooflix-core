import { useEffect, useState } from "react"

export const PAGE_SIZES = [10, 25, 50, 100] as const

export type Pagination<T> = {
  /** the rows on the current page */
  items: T[]
  /** 1-based */
  page: number
  pageSize: number
  pageCount: number
  total: number
  /** 1-based position of the first and last row shown, 0 when empty */
  from: number
  to: number
  setPage: (page: number) => void
  setPageSize: (size: number) => void
}

/**
 * Client-side paging of a list. The page is kept in range when the list
 * shrinks (a pipeline deleted, runs filtered), and changing the page size
 * goes back to the first page.
 */
export function usePagination<T>(rows: T[] | undefined, initialPageSize = 25): Pagination<T> {
  const [page, setPageState] = useState(1)
  const [pageSize, setPageSizeState] = useState(initialPageSize)
  const total = rows?.length ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pageCount)

  useEffect(() => {
    if (page > pageCount) setPageState(pageCount)
  }, [page, pageCount])

  const start = (current - 1) * pageSize
  const items = rows ? rows.slice(start, start + pageSize) : []
  return {
    items,
    page: current,
    pageSize,
    pageCount,
    total,
    from: total ? start + 1 : 0,
    to: start + items.length,
    setPage: (p) => setPageState(Math.min(Math.max(1, p), pageCount)),
    setPageSize: (size) => {
      setPageSizeState(size)
      setPageState(1)
    },
  }
}
