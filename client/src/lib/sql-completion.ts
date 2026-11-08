import type { SqlTable } from "@/lib/types"

export interface Suggestion {
  /** text inserted in place of the word being typed */
  insert: string
  label: string
  kind: "schema" | "table" | "column"
  detail?: string
}

export interface Completion {
  /** start of the word being replaced (the part after the last ".") */
  from: number
  to: number
  items: Suggestion[]
}

const MAX_ITEMS = 50

const startsWith = (name: string, prefix: string) => name.toLowerCase().startsWith(prefix.toLowerCase())

/**
 * What to suggest at the cursor.
 *   banking.|          -> the tables of schema "banking"
 *   banking.cu|        -> its tables starting with "cu"
 *   banking.customers.|-> the columns of banking.customers
 *   ba| (forced)       -> schemas and main tables starting with "ba"
 * Returns null when there is nothing to suggest.
 */
export function completeAt(
  text: string,
  cursor: number,
  tables: SqlTable[],
  { force = false }: { force?: boolean } = {},
): Completion | null {
  const before = text.slice(0, cursor)
  // the dotted identifier just before the cursor, e.g. "banking.cu" or "banking.customers."
  const m = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\.)?([A-Za-z_]\w*)?$/.exec(before)
  if (!m) return null
  const qualifier = (m[1] ?? "").replace(/\.$/, "") // "banking" or "banking.customers"
  const word = m[2] ?? ""
  const from = cursor - word.length
  const schemas = [...new Set(tables.map((t) => t.schema))]

  let items: Suggestion[] = []
  if (qualifier) {
    const parts = qualifier.split(".")
    if (parts.length === 1 && schemas.some((s) => s.toLowerCase() === parts[0].toLowerCase())) {
      // schema.  -> its tables
      items = tables
        .filter((t) => t.schema.toLowerCase() === parts[0].toLowerCase() && startsWith(t.name, word))
        .map((t) => ({
          insert: t.name,
          label: t.name,
          kind: "table" as const,
          detail: `${t.row_count.toLocaleString()} rows`,
        }))
    } else {
      // schema.table.  or  main_table.  -> its columns
      const table = tables.find((t) => t.qualified.toLowerCase() === qualifier.toLowerCase())
      items = (table?.columns ?? [])
        .filter((c) => startsWith(c.name, word))
        .map((c) => ({
          insert: c.name,
          label: c.name,
          kind: "column" as const,
          detail: c.type.toLowerCase(),
        }))
    }
  } else if (force || word.length >= 2) {
    items = [
      ...schemas
        .filter((s) => s !== "main" && startsWith(s, word))
        .map((s) => ({ insert: s, label: s, kind: "schema" as const, detail: "schema" })),
      ...tables
        .filter((t) => t.schema === "main" && startsWith(t.name, word))
        .map((t) => ({ insert: t.name, label: t.name, kind: "table" as const, detail: "table" })),
    ]
    // don't pop up just to repeat exactly what was typed
    if (!force && items.length === 1 && items[0].insert === word) items = []
  }
  if (!items.length) return null
  return { from, to: cursor, items: items.slice(0, MAX_ITEMS) }
}

/**
 * Pixel position of the caret inside a textarea, relative to the textarea's
 * top-left corner (a mirror element copies its text and styles).
 */
export function caretPosition(
  el: HTMLTextAreaElement,
  index: number,
): { left: number; top: number; height: number } {
  const style = getComputedStyle(el)
  const mirror = document.createElement("div")
  for (const prop of [
    "boxSizing",
    "width",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textTransform",
    "wordSpacing",
    "tabSize",
  ] as const) {
    mirror.style[prop] = style[prop]
  }
  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.overflowWrap = "break-word"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.textContent = el.value.slice(0, index)
  const marker = document.createElement("span")
  marker.textContent = el.value.slice(index) || "."
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4
  const pos = {
    left: marker.offsetLeft - el.scrollLeft,
    top: marker.offsetTop - el.scrollTop,
    height: lineHeight,
  }
  document.body.removeChild(mirror)
  return pos
}
