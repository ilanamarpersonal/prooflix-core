/**
 * How to name a data file's table in SQL (mirrors ``schemas``, ``table_key`` and
 * ``table_name`` in server/prooflix/api/sql.py). Only Parquet files are tables;
 * a folder of Parquet files is one table, and a file directly in data/ is its own.
 *   data/orders.parquet                              -> orders                      (schema main)
 *   data/destination/customers/part-0.parquet        -> destination_customers       (schema main)
 *   my-project/data/orders.parquet                   -> my_project.orders
 */
const ident = (s: string, prefix: string) => {
  const name = s.replace(/[^0-9a-zA-Z]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()
  return name && !/^\d/.test(name) ? name : `${prefix}${name}`
}

export function sqlTableFor(workspacePath: string): string | null {
  const m = /^(?:([^/]+)\/)?data\/(.+)\.parquet$/i.exec(workspacePath)
  if (!m) return null
  const rel = m[2]
  if (rel.split("/").some((p) => p.startsWith(".") || p.startsWith("_"))) return null
  const slash = rel.lastIndexOf("/")
  const table = ident(slash === -1 ? rel : rel.slice(0, slash), "t_")
  if (!m[1]) return table
  let schema = ident(m[1], "s_")
  if (schema === "main" || schema === "temp") schema += "_"
  return `${schema}.${table}`
}
