import { useRef, useState } from "react"
import { CheckCircle2, FilePlus2, Loader2, Upload, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, useCatalogImport } from "@/lib/api"
import type { CatalogImportResult, CatalogSchema } from "@/lib/types"

const NEW_SCHEMA = "__new__"

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Table name the server gives a file (mirrors table_name in server/prooflix/api/sql.py). */
const tableNameOf = (file: string) => {
  const name = file
    .replace(/\.[^.]+$/, "")
    .replace(/[^0-9a-zA-Z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return name && !/^\d/.test(name) ? name : `t_${name}`
}

/** Upload Parquet files as tables of an existing or a new schema. */
export function CatalogImportPanel({
  schemas,
  defaultSchema,
  onClose,
  onImported,
}: {
  schemas: CatalogSchema[]
  defaultSchema?: string
  onClose: () => void
  onImported: (result: CatalogImportResult) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState(defaultSchema ?? schemas[0]?.name ?? NEW_SCHEMA)
  const [newName, setNewName] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<CatalogImportResult | null>(null)
  const importer = useCatalogImport()

  const conflicts =
    importer.error instanceof ApiError && importer.error.status === 409
      ? ((importer.error.detail as { conflicts?: string[] } | undefined)?.conflicts ?? [])
      : []
  const schema = target === NEW_SCHEMA ? newName.trim() : target
  const busy = reading || importer.isPending

  const submit = async (overwrite = false) => {
    setReading(true)
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, content_base64: await toBase64(f) })),
      )
      importer.mutate(
        { schema, files: payload, overwrite },
        {
          onSuccess: (r) => {
            setResult(r)
            setFiles([])
            onImported(r)
          },
        },
      )
    } finally {
      setReading(false)
    }
  }

  return (
    <Card className="mb-4 py-4">
      <CardContent className="grid gap-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Import tables</h2>
            <p className="text-muted-foreground text-sm">
              Each Parquet file becomes a table of the schema.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close import">
            <X />
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="import-schema">Schema</Label>
            <select
              id="import-schema"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value)
                importer.reset()
              }}
              className="bg-background h-9 rounded-md border px-2 font-mono text-sm"
            >
              {schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
              <option value={NEW_SCHEMA}>New schema…</option>
            </select>
          </div>
          {target === NEW_SCHEMA && (
            <div className="grid gap-1.5">
              <Label htmlFor="import-new-schema">New schema name</Label>
              <Input
                id="import-new-schema"
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value)
                  importer.reset()
                }}
                placeholder="for example sales"
                className="font-mono text-sm"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            <FilePlus2 /> Choose files
          </Button>
          <span className="text-muted-foreground text-sm">
            {files.length ? `${files.length} file${files.length === 1 ? "" : "s"} chosen` : ".parquet"}
          </span>
          <input
            ref={input}
            type="file"
            multiple
            accept=".parquet"
            className="hidden"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []))
              setResult(null)
              importer.reset()
              e.target.value = ""
            }}
          />
        </div>

        {files.length > 0 && (
          <ul className="max-h-40 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-relaxed">
            {files.map((f) => {
              const table = tableNameOf(f.name)
              return (
                <li key={f.name} className={conflicts.includes(table) ? "text-status-failed" : undefined}>
                  {f.name} → {schema || "…"}.{table}
                  {conflicts.includes(table) && " (exists)"}
                </li>
              )
            })}
          </ul>
        )}

        {conflicts.length > 0 ? (
          <Alert>
            <AlertTitle>
              {conflicts.length} table{conflicts.length === 1 ? " already exists" : "s already exist"} in {schema}
            </AlertTitle>
            <AlertDescription className="grid gap-2">
              <span>Replace them, or pick another schema.</span>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={() => submit(true)} disabled={busy}>
                  Overwrite and import
                </Button>
                <Button size="sm" variant="outline" onClick={() => importer.reset()} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          importer.error && <ErrorAlert title="Import failed" error={importer.error} />
        )}

        {conflicts.length === 0 && files.length > 0 && (
          <div>
            <Button onClick={() => submit(false)} disabled={busy || !schema}>
              <span className="contents">{busy ? <Loader2 className="animate-spin" /> : <Upload />}</span> Import {files.length} table
              {files.length === 1 ? "" : "s"}
            </Button>
          </div>
        )}

        {result && (
          <Alert>
            <CheckCircle2 className="text-status-succeeded" />
            <AlertTitle>
              Imported {result.tables.length} table{result.tables.length === 1 ? "" : "s"} into{" "}
              <span className="font-mono">{result.schema}</span>
              {result.created_schema && " (new schema)"}
            </AlertTitle>
            <AlertDescription>
              <span>
                {result.tables.map((t) => `${result.schema}.${t}`).join(", ")} · files in{" "}
                <code className="font-mono">{result.folder}/</code>
              </span>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
