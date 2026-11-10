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

// Words that end a table reference instead of naming an alias.
const NOT_ALIAS = new Set(
  (
    "where on using join left right inner outer full cross natural lateral positional asof anti semi " +
    "group order limit offset having qualify window union except intersect select from as " +
    "pivot unpivot sample tablesample fetch returning"
  ).split(" "),
)

/**
 * The tables a query reads, by every name it can be written with in the query:
 * its alias (`FROM tenant1.bronze.accounts acc`, `JOIN ... AS t`) or, without an
 * alias, its table name and full name. Text in strings and comments is ignored.
 * Keys are lowercase.
 */
export function tableRefs(text: string, tables: SqlTable[]): Map<string, SqlTable> {
  const code = text
    .replace(/'(?:[^']|'')*'/g, " ''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ")
  const tokens = code.match(/"(?:[^"]|"")+"|[A-Za-z_][\w$]*|\.|,|\(|\)|;/g) ?? []
  const word = (t: string | undefined) => (t && t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t)
  const isIdent = (t: string | undefined) => !!t && /^("|[A-Za-z_])/.test(t)
  const byQualified = new Map(tables.map((t) => [t.qualified.toLowerCase(), t]))
  const refs = new Map<string, SqlTable>()

  for (let i = 0; i < tokens.length; i++) {
    const kw = tokens[i].toLowerCase()
    if (kw !== "from" && kw !== "join") continue
    let j = i + 1
    for (;;) {
      if (!isIdent(tokens[j])) break // e.g. a subquery "("
      const parts = [word(tokens[j])!]
      j++
      while (tokens[j] === "." && isIdent(tokens[j + 1])) {
        parts.push(word(tokens[j + 1])!)
        j += 2
      }
      const name = parts.join(".").toLowerCase()
      const table =
        byQualified.get(name) ??
        (parts.length === 1 ? tables.filter((t) => t.name.toLowerCase() === name).at(0) : undefined)
      let alias: string | undefined
      if (tokens[j]?.toLowerCase() === "as") j++
      if (isIdent(tokens[j]) && !NOT_ALIAS.has(tokens[j].toLowerCase())) {
        alias = word(tokens[j])
        j++
      }
      if (table) {
        if (alias) refs.set(alias.toLowerCase(), table)
        else {
          refs.set(table.name.toLowerCase(), table)
          refs.set(table.qualified.toLowerCase(), table)
        }
      }
      if (kw === "from" && tokens[j] === ",")
        j++ // FROM a x, b y
      else break
    }
  }
  return refs
}

const columnItems = (table: SqlTable, word: string, withTable = false): Suggestion[] =>
  table.columns
    .filter((c) => startsWith(c.name, word))
    .map((c) => ({
      insert: c.name,
      label: c.name,
      kind: "column" as const,
      detail: withTable ? `${c.type.toLowerCase()} · ${table.name}` : c.type.toLowerCase(),
    }))

/**
 * What to suggest at the cursor.
 *   banking.|                 -> the tables of schema "banking"
 *   banking.cu|               -> its tables starting with "cu"
 *   banking.customers.|       -> the columns of banking.customers
 *   tenant1.|                 -> the schemas of catalog "tenant1" (bronze, ...)
 *   tenant1.bronze.|          -> the tables of schema "tenant1.bronze"
 *   tenant1.bronze.accounts.| -> its columns
 *   acc.|                     -> the columns of the table "acc" stands for in this query
 *                                (FROM tenant1.bronze.accounts acc), or of a table named
 *                                accounts used without an alias
 *   ba| (forced)              -> catalogs, schemas, main tables, aliases and the columns
 *                                of the query's tables starting with "ba"
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
  // (a name part may be quoted: "Acc".)
  const m = /((?:(?:"[^"\n]+"|[A-Za-z_]\w*)\.)+)?([A-Za-z_]\w*)?$/.exec(before)
  if (!m) return null
  // "banking" or "banking.customers", without quotes
  const qualifier = (m[1] ?? "")
    .replace(/\.$/, "")
    .split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => p.replace(/^"(.*)"$/, "$1"))
    .join(".")
  const word = m[2] ?? ""
  const from = cursor - word.length
  const schemas = [...new Set(tables.map((t) => t.schema))]
  const catalogs = [...new Set(tables.map((t) => t.catalog).filter(Boolean))]
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const refs = tableRefs(text, tables)

  let items: Suggestion[] = []
  if (qualifier) {
    const aliased = refs.get(qualifier.toLowerCase())
    if (aliased && !qualifier.includes(".")) {
      // alias.  or  table.  (as named in this query's FROM / JOIN) -> its columns
      items = columnItems(aliased, word)
    } else if (catalogs.some((c) => same(c, qualifier))) {
      // catalog.  -> its schemas, written without the catalog ("bronze")
      items = schemas
        .filter((s) => same(s.split(".")[0], qualifier) && s.includes("."))
        .map((s) => s.slice(s.indexOf(".") + 1))
        .filter((s) => startsWith(s, word))
        .map((s) => ({ insert: s, label: s, kind: "schema" as const, detail: "schema" }))
    } else if (schemas.some((s) => same(s, qualifier))) {
      // schema.  or  catalog.schema.  -> its tables
      items = tables
        .filter((t) => same(t.schema, qualifier) && startsWith(t.name, word))
        .map((t) => ({
          insert: t.name,
          label: t.name,
          kind: "table" as const,
          detail: `${t.row_count.toLocaleString()} rows`,
        }))
    } else {
      // [catalog.]schema.table.  or  main_table.  -> its columns
      const table = tables.find((t) => t.qualified.toLowerCase() === qualifier.toLowerCase())
      items = table ? columnItems(table, word) : []
    }
  } else if (force || word.length >= 2) {
    items = [
      ...catalogs
        .filter((c) => startsWith(c, word))
        .map((c) => ({ insert: c, label: c, kind: "schema" as const, detail: "catalog" })),
      ...schemas
        .filter((s) => s !== "main" && !s.includes(".") && startsWith(s, word))
        .map((s) => ({ insert: s, label: s, kind: "schema" as const, detail: "schema" })),
      ...tables
        .filter((t) => t.schema === "main" && startsWith(t.name, word))
        .map((t) => ({ insert: t.name, label: t.name, kind: "table" as const, detail: "table" })),
      // the aliases and columns of the tables this query reads
      ...[...refs]
        .filter(([name, t]) => !name.includes(".") && name !== t.name.toLowerCase() && startsWith(name, word))
        .map(([name, t]) => ({ insert: name, label: name, kind: "table" as const, detail: `alias of ${t.qualified}` })),
      ...[...new Set(refs.values())].flatMap((t) => columnItems(t, word, true)),
    ]
    // the same column in two tables only once
    const seen = new Set<string>()
    items = items.filter((it) => {
      const key = `${it.kind}:${it.insert.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
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
export function caretPosition(el: HTMLTextAreaElement, index: number): { left: number; top: number; height: number } {
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
