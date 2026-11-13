import { useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import { CheckCircle2, FilePlus2, FolderInput, Loader2, Upload, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, useImportWorkspace } from "@/lib/api"
import type { ImportResult } from "@/lib/types"

// Never uploaded: version control, caches, virtualenvs, OS files, run history.
const SKIP_PARTS = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv", ".prooflix", ".DS_Store"])
const skipped = (relPath: string) =>
  relPath.split("/").some((p) => SKIP_PARTS.has(p) || p.startsWith("."))

interface Picked {
  file: File
  /** path inside the chosen folder, without the folder name ("pipelines/a.yaml") */
  inner: string
}

interface Selection {
  /** name of the chosen folder, or null when single files were chosen */
  folder: string | null
  files: Picked[]
  skippedCount: number
}

function fromFileList(list: FileList, isFolder: boolean): Selection {
  const all = Array.from(list)
  const folder = isFolder && all[0]?.webkitRelativePath ? all[0].webkitRelativePath.split("/")[0] : null
  const files: Picked[] = []
  let skippedCount = 0
  for (const file of all) {
    const rel = isFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name
    const inner = folder ? rel.split("/").slice(1).join("/") : rel
    if (!inner || skipped(inner)) skippedCount++
    else files.push({ file, inner })
  }
  return { folder, files, skippedCount }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const cleanFolder = (s: string) =>
  s
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== ".")
    .join("/")

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Upload a folder (or files) of pipelines and code into the workspace.
 * By default a chosen folder keeps its name, so each imported project gets its
 * own folder in the active workspace (<project>/pipelines and src) and its
 * pipelines can run straight away. Unticking "Keep the folder name" copies the
 * folder's contents into the destination folder instead.
 */
export function ImportCodePanel({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: (result: ImportResult) => void
}) {
  const folderInput = useRef<HTMLInputElement>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [keepFolderName, setKeepFolderName] = useState(true)
  const [destination, setDestination] = useState("")
  const [reading, setReading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const importer = useImportWorkspace()

  const conflicts =
    importer.error instanceof ApiError && importer.error.status === 409
      ? (((importer.error.detail as { conflicts?: string[] } | undefined)?.conflicts ?? []) as string[])
      : []

  const targets = useMemo(() => {
    if (!selection) return []
    const base = [cleanFolder(destination), keepFolderName && selection.folder ? selection.folder : ""]
      .filter(Boolean)
      .join("/")
    return selection.files.map((p) => ({ ...p, path: base ? `${base}/${p.inner}` : p.inner }))
  }, [selection, destination, keepFolderName])

  const totalSize = targets.reduce((n, t) => n + t.file.size, 0)

  const choose = (list: FileList | null, isFolder: boolean) => {
    if (!list?.length) return
    setSelection(fromFileList(list, isFolder))
    setResult(null)
    importer.reset()
  }

  const submit = async (overwrite = false) => {
    setReading(true)
    try {
      const files = await Promise.all(
        targets.map(async (t) => ({ path: t.path, content_base64: await toBase64(t.file) })),
      )
      importer.mutate(
        { files, overwrite },
        {
          onSuccess: (r) => {
            setResult(r)
            setSelection(null)
            onImported(r)
          },
        },
      )
    } finally {
      setReading(false)
    }
  }

  const busy = reading || importer.isPending

  return (
    <Card className="mb-4 py-4">
      <CardContent className="grid gap-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Import code</h2>
            <p className="text-muted-foreground text-sm">
              Choose a project folder (for example one with <code className="font-mono">pipelines/</code> and{" "}
              <code className="font-mono">src/</code>) or single files to copy into the workspace.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close import">
            <X />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => folderInput.current?.click()} disabled={busy}>
            <FolderInput /> Choose folder
          </Button>
          <Button variant="outline" onClick={() => filesInput.current?.click()} disabled={busy}>
            <FilePlus2 /> Choose files
          </Button>
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            multiple
            {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => {
              choose(e.target.files, true)
              e.target.value = ""
            }}
          />
          <input
            ref={filesInput}
            type="file"
            className="hidden"
            multiple
            onChange={(e) => {
              choose(e.target.files, false)
              e.target.value = ""
            }}
          />
        </div>

        {selection && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="import-destination">Destination folder in the workspace</Label>
                <Input
                  id="import-destination"
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value)
                    importer.reset()
                  }}
                  placeholder="workspace root"
                  className="font-mono text-sm"
                />
              </div>
              {selection.folder && (
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={keepFolderName}
                    onChange={(e) => {
                      setKeepFolderName(e.target.checked)
                      importer.reset()
                    }}
                    className="accent-primary size-4"
                  />
                  Keep the folder name <code className="font-mono">{selection.folder}/</code>
                </label>
              )}
            </div>

            <div className="rounded-md border">
              <div className="text-muted-foreground border-b px-3 py-2 text-xs">
                {targets.length} file{targets.length === 1 ? "" : "s"} · {formatSize(totalSize)}
                {selection.folder && (
                  <>
                    {" "}from <code className="font-mono">{selection.folder}/</code>
                  </>
                )}
                {selection.skippedCount > 0 && ` · ${selection.skippedCount} hidden or cache file(s) left out`}
              </div>
              <ul className="max-h-48 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
                {targets.map((t) => (
                  <li key={t.path} className={conflicts.includes(t.path) ? "text-status-failed" : undefined}>
                    {t.path}
                    {conflicts.includes(t.path) && " (exists)"}
                  </li>
                ))}
              </ul>
            </div>

            {conflicts.length > 0 ? (
              <Alert>
                <AlertTitle>
                  {conflicts.length} file{conflicts.length === 1 ? " already exists" : "s already exist"}
                </AlertTitle>
                <AlertDescription className="grid gap-2">
                  <span>Replace them, or change the destination folder.</span>
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

            {conflicts.length === 0 && (
              <div>
                <Button onClick={() => submit(false)} disabled={busy || targets.length === 0}>
                  <span className="contents">{busy ? <Loader2 className="animate-spin" /> : <Upload />}</span> Import {targets.length} file
                  {targets.length === 1 ? "" : "s"}
                </Button>
              </div>
            )}
          </>
        )}

        {result && (
          <Alert>
            <CheckCircle2 className="text-status-succeeded" />
            <AlertTitle>
              Imported {result.written.length} file{result.written.length === 1 ? "" : "s"}
            </AlertTitle>
            {result.pipelines.length > 0 && (
              <AlertDescription>
                <span>
                  Pipelines:{" "}
                  {result.pipelines.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ", "}
                      <Link to={`/pipelines/${id}`} className="font-mono underline">
                        {id}
                      </Link>
                    </span>
                  ))}
                </span>
              </AlertDescription>
            )}
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
