/**
 * The SQL table name the server gives a data file (mirrors
 * ``table_name`` in server/prooflix/api/sql.py).
 * ``data/output/2026-11-07/clean_orders.json`` -> ``output_2026_11_07_clean_orders``
 */
export function sqlTableFor(workspacePath: string): string | null {
  const m = /^data\/(.+)\.(csv|json)$/i.exec(workspacePath)
  if (!m) return null
  const name = m[1].replace(/[^0-9a-zA-Z]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()
  return name && !/^\d/.test(name) ? name : `t_${name}`
}
