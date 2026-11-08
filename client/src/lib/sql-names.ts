/**
 * How to name a data file's table in SQL (mirrors ``schemas`` and
 * ``table_name`` in server/prooflix/api/sql.py).
 *   data/output/2026-11-07/clean_orders.json -> output_2026_11_07_clean_orders   (schema main)
 *   my-project/data/orders.csv               -> my_project.orders
 */
const ident = (s: string, prefix: string) => {
  const name = s.replace(/[^0-9a-zA-Z]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()
  return name && !/^\d/.test(name) ? name : `${prefix}${name}`
}

export function sqlTableFor(workspacePath: string): string | null {
  const m = /^(?:([^/]+)\/)?data\/(.+)\.(csv|json)$/i.exec(workspacePath)
  if (!m) return null
  const table = ident(m[2], "t_")
  if (!m[1]) return table
  let schema = ident(m[1], "s_")
  if (schema === "main" || schema === "temp") schema += "_"
  return `${schema}.${table}`
}
