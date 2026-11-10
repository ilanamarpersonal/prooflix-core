/**
 * How to name a data file's table in SQL (mirrors ``schemas``, ``table_key`` and
 * ``table_name`` in server/prooflix/api/sql.py). Only Parquet files are tables;
 * a folder of Parquet files is one table, and a file directly in a schema's
 * folder is its own. In the workspace's data/, each folder is a catalog (a tenant
 * ID) and each folder in it a schema (a layer); files directly in data/ are schema main.
 *   data/orders.parquet                                    -> orders                          (schema main)
 *   data/tenant1/bronze/customers/customers.parquet        -> tenant1.bronze.customers
 *   my-project/data/orders.parquet                         -> my_project.orders
 */
const ident = (s: string, prefix: string) => {
  const name = s
    .replace(/[^0-9a-zA-Z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return name && !/^\d/.test(name) ? name : `${prefix}${name}`
}

const schemaIdent = (folder: string) => {
  const schema = ident(folder, "s_")
  return schema === "main" || schema === "temp" ? `${schema}_` : schema
}

/** Table name for a path relative to its schema's folder, without ".parquet". */
const tableIdent = (rel: string) => {
  const slash = rel.lastIndexOf("/")
  return ident(slash === -1 ? rel : rel.slice(0, slash), "t_")
}

export function sqlTableFor(workspacePath: string): string | null {
  const m = /^(?:([^/]+)\/)?data\/(.+)\.parquet$/i.exec(workspacePath)
  if (!m) return null
  const rel = m[2]
  if (rel.split("/").some((p) => p.startsWith(".") || p.startsWith("_"))) return null
  if (m[1]) return `${schemaIdent(m[1])}.${tableIdent(rel)}`
  const parts = rel.split("/")
  if (parts.length === 1) return tableIdent(rel) // directly in data/: schema main
  if (parts.length === 2) return null // directly in a catalog folder: not in a schema, not a table
  const [catalog, schema, ...rest] = parts
  return `${schemaIdent(catalog)}.${schemaIdent(schema)}.${tableIdent(rest.join("/"))}`
}
