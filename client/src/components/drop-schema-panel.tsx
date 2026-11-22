import { useState } from "react"
import { EyeOff, Loader2, Trash2, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuthStatus, useDropCatalog, useDropSchema } from "@/lib/api"
import type { CatalogSchema, DropSchemaMode } from "@/lib/types"
import { cn } from "@/lib/utils"

/** What a drop removed, for the notice on the Catalog page. */
export interface Dropped {
  kind: "schema" | "catalog"
  name: string
  mode: DropSchemaMode
  /** the schemas hidden or deleted (one for a schema) */
  schemas: string[]
  /** with mode "delete": the tables whose files were deleted */
  deletedTables: string[]
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`

/**
 * Drop a schema, or every schema of a catalog (a tenant): hide it from the GUI (its data stays in the data lake),
 * or delete its tables' files permanently.
 */
export function DropSchemaPanel({
  kind,
  name,
  schemas,
  onClose,
  onDropped,
}: {
  kind: "schema" | "catalog"
  /** the schema ("tenant1.bronze") or the catalog ("tenant1") */
  name: string
  /** the schema, or the catalog's schemas */
  schemas: CatalogSchema[]
  onClose: () => void
  onDropped: (result: Dropped) => void
}) {
  const auth = useAuthStatus().data
  // with users on, only an admin may delete data (the server checks it too)
  const canDelete = !auth?.enabled || auth.user?.role === "admin"
  const [mode, setMode] = useState<DropSchemaMode>("hide")
  const [confirm, setConfirm] = useState("")
  const dropSchema = useDropSchema()
  const dropCatalog = useDropCatalog()
  const drop = kind === "schema" ? dropSchema : dropCatalog
  const tables = schemas.flatMap((s) => s.tables.map((t) => (kind === "schema" ? t.name : `${s.name}.${t.name}`)))
  const rows = schemas.reduce((n, s) => n + s.tables.reduce((m, t) => m + t.row_count, 0), 0)
  const ready = mode === "hide" || confirm.trim() === name
  const what = kind === "schema" ? "it" : "its schemas"

  const options = [
    {
      mode: "hide" as const,
      icon: EyeOff,
      title: "Hide from the GUI",
      hint: `The Catalog and the SQL Editor stop listing ${what}. The data stays in the data lake and you can restore ${what}.`,
      disabled: false,
    },
    {
      mode: "delete" as const,
      icon: Trash2,
      title: "Delete permanently from the data lake",
      hint: canDelete
        ? `Deletes the files of ${plural(tables.length, "table")}. This can't be undone.`
        : `Only an admin can delete a ${kind}'s data.`,
      disabled: !canDelete,
    },
  ]

  const submit = () => {
    const done = (r: Omit<Dropped, "kind" | "name">) => onDropped({ kind, name, ...r })
    if (kind === "schema")
      dropSchema.mutate(
        { schema: name, mode },
        { onSuccess: (r) => done({ mode: r.mode, schemas: [r.schema], deletedTables: r.deleted_tables }) },
      )
    else
      dropCatalog.mutate(
        { catalog: name, mode },
        { onSuccess: (r) => done({ mode: r.mode, schemas: r.schemas, deletedTables: r.deleted_tables }) },
      )
  }

  return (
    <Card className="border-destructive/40 m-4 gap-0 py-4">
      <CardContent className="grid gap-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">
              Drop {kind === "schema" ? "schema" : "catalog"} <span className="font-mono">{name}</span>
            </h2>
            <p className="text-muted-foreground text-sm">
              {kind === "catalog" && `${plural(schemas.length, "schema")} · `}
              {plural(tables.length, "table")} · {plural(rows, "row")}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close drop">
            <X />
          </Button>
        </div>

        <div role="radiogroup" aria-label={`How to drop the ${kind}`} className="grid gap-2">
          {options.map((o) => (
            <label
              key={o.mode}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3",
                mode === o.mode && (o.mode === "delete" ? "border-destructive bg-destructive/5" : "border-primary"),
                o.disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name="drop-mode"
                value={o.mode}
                checked={mode === o.mode}
                disabled={o.disabled || drop.isPending}
                onChange={() => {
                  setMode(o.mode)
                  drop.reset()
                }}
                className="mt-1"
              />
              <o.icon className={cn("mt-0.5 size-4 shrink-0", o.mode === "delete" && "text-destructive")} />
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">{o.title}</span>
                <span className="text-muted-foreground text-xs">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {mode === "delete" && (
          <div className="grid gap-3">
            <Alert variant="destructive">
              <Trash2 />
              <AlertTitle>This permanently deletes data</AlertTitle>
              <AlertDescription>
                <p>
                  The folders of {tables.join(", ")} are deleted from{" "}
                  {schemas.map((s, i) => (
                    <span key={s.name}>
                      {i > 0 && ", "}
                      <code className="font-mono">{s.data_dir}/</code>
                    </span>
                  ))}
                  . Other files in those folders are kept. Tables registered in Unity Catalog stay registered there.
                </p>
              </AlertDescription>
            </Alert>
            <div className="grid gap-1.5">
              <Label htmlFor="drop-confirm">
                Type <span className="font-mono">{name}</span> to confirm
              </Label>
              <Input
                id="drop-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
          </div>
        )}

        {drop.error && <ErrorAlert title={`Could not drop the ${kind}`} error={drop.error} />}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={drop.isPending}>
            Cancel
          </Button>
          <Button
            variant={mode === "delete" ? "destructive" : "default"}
            disabled={!ready || drop.isPending}
            onClick={submit}
          >
            {drop.isPending ? <Loader2 className="animate-spin" /> : mode === "delete" ? <Trash2 /> : <EyeOff />}
            {mode === "delete" ? "Delete permanently" : kind === "schema" ? "Hide schema" : "Hide catalog"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
