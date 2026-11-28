import { useEffect, useState } from "react"
import { Copy, FolderInput, FolderOpen, GitBranch, Loader2, TriangleAlert, X } from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { Alert, AlertDescription, AlertTitle } from "@prooflix/ui/components/ui/alert"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent } from "@prooflix/ui/components/ui/card"
import { FolderPicker } from "@prooflix/ui/app/folder-picker"
import { Input } from "@prooflix/ui/components/ui/input"
import { api, useImportPath, useImportWorkspace } from "@/lib/api"
import type { FoundFolder, ImportPathResult, ImportWorkspaceResult } from "@/lib/types"
import { cn } from "@/lib/utils"

// The server's limits for one upload (MAX_IMPORT_BYTES and MAX_IMPORT_FILES in server/prooflix/api/workspace.py)
const MAX_BYTES = 20 * 1024 * 1024
const MAX_FILES = 2000

// Never uploaded: version control, caches, virtualenvs, OS files, run history.
const SKIP_PARTS = new Set(["__pycache__", "node_modules", ".git", ".venv", "venv", ".prooflix", ".DS_Store"])
const skipped = (relPath: string) => relPath.split("/").some((p) => SKIP_PARTS.has(p) || p.startsWith("."))

interface Picked {
  file: File
  /** path inside the chosen folder, without the folder name ("pipelines/a.yaml") */
  path: string
}

/** A folder to import: its name and its files (hidden and cache files left out). */
export interface FolderSelection {
  folder: string
  files: Picked[]
  skippedCount: number
}

function fromFileList(all: File[]): FolderSelection | null {
  const folder = all[0]?.webkitRelativePath.split("/")[0]
  if (!folder) return null
  const files: Picked[] = []
  let skippedCount = 0
  for (const file of all) {
    const path = file.webkitRelativePath.split("/").slice(1).join("/")
    if (!path || skipped(path)) skippedCount++
    else files.push({ file, path })
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

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** The biggest top-level entries of the selection, to show what makes it too large. */
function biggest(files: Picked[], count = 3): { name: string; size: number }[] {
  const sizes = new Map<string, number>()
  for (const p of files) {
    const top = p.path.includes("/") ? `${p.path.split("/")[0]}/` : p.path
    sizes.set(top, (sizes.get(top) ?? 0) + p.file.size)
  }
  return [...sizes.entries()]
    .map(([name, size]) => ({ name, size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, count)
}

// --- folders dropped on the page (Chrome asks no "Upload N files?" question for these)

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** Every file under a dropped directory, with its path inside it; hidden and cache folders aren't entered. */
async function walk(dir: FileSystemDirectoryEntry, prefix: string, out: FolderSelection): Promise<void> {
  const reader = dir.createReader()
  // readEntries returns the entries in batches, until an empty one
  for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
    for (const entry of batch) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (skipped(entry.name)) out.skippedCount++
      else if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, path, out)
      else out.files.push({ file: await entryFile(entry as FileSystemFileEntry), path })
    }
  }
}

/**
 * The folder dropped on the page, or a message saying why it can't be imported.
 * Call it from the drop handler itself: the browser only lets the entries be read then.
 */
export function readDroppedFolder(data: DataTransfer): Promise<FolderSelection | string> {
  const entries = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null)
  const dirs = entries.filter((e) => e.isDirectory) as FileSystemDirectoryEntry[]
  if (dirs.length === 0) return Promise.resolve("Drop a folder, not files, to import it as a workspace.")
  if (entries.length > 1) return Promise.resolve("Drop one folder at a time.")
  const out: FolderSelection = { folder: dirs[0].name, files: [], skippedCount: 0 }
  return walk(dirs[0], "", out).then(
    () => out,
    (err: unknown) => `Could not read the folder: ${err instanceof Error ? err.message : String(err)}`,
  )
}

/** A folder name the server accepts: letters, digits, spaces, ".", "_" or "-", starting with a letter or digit. */
const suggestName = (folder: string) => folder.replace(/[^A-Za-z0-9._ -]/g, "-").replace(/^[^A-Za-z0-9]+/, "")

/** The folder picker for importing a workspace: a hidden input the Import Workspace buttons click. */
export function FolderPickerInput({
  inputRef,
  onPicked,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  onPicked: (selection: FolderSelection | null) => void
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      multiple
      {...{ webkitdirectory: "", directory: "" }}
      onChange={(e) => {
        // Copy the files first: the FileList is live, and clearing the input (so the
        // same folder can be chosen again) empties it.
        const files = Array.from(e.target.files ?? [])
        e.target.value = ""
        if (files.length) onPicked(fromFileList(files))
      }}
    />
  )
}

/**
 * Import a folder chosen on this computer as a workspace, straight away: it is
 * named after the folder and made active. When a workspace of that name exists
 * (imported before), it is updated with the folder: files with the same path are
 * replaced, everything else in it (run history included) is kept. This panel only shows the
 * progress, and asks when something needs an answer (too large, name taken).
 */
export function ImportWorkspacePanel({
  selection,
  onChooseAgain,
  onClose,
  onImported,
  onImportedInPlace,
  onServerPath,
}: {
  /** the chosen or dropped folder (null: nothing usable was chosen) */
  selection: FolderSelection | null
  /** open the folder picker again (or drop another folder) */
  onChooseAgain: () => void
  onClose: () => void
  /** copied (uploaded) into PROOFLIX_HOME/workspaces */
  onImported: (result: ImportWorkspaceResult) => void
  /** worked on in place, where it is on the server */
  onImportedInPlace: (result: ImportPathResult) => void
  /** type a path on the server instead (the folder isn't on this computer) */
  onServerPath: () => void
}) {
  const [name, setName] = useState(selection ? suggestName(selection.folder) : "")
  const [reading, setReading] = useState(false)
  const importer = useImportWorkspace()
  const inPlace = useImportPath()
  const [mode, setMode] = useState<"in_place" | "copy" | null>(null) // null until the search answers
  const [path, setPath] = useState("")
  const [found, setFound] = useState<FoundFolder[] | null>(null)
  const [activate, setActivate] = useState(true)

  const totalSize = selection?.files.reduce((n, p) => n + p.file.size, 0) ?? 0
  const busy = reading || importer.isPending || inPlace.isPending
  // only a copy is uploaded, so only a copy has the browser's size limits
  const tooBig = !!selection && (totalSize > MAX_BYTES || selection.files.length > MAX_FILES)
  const empty = !selection || selection.files.length === 0
  const error = importer.error ?? inPlace.error

  // where is this folder on the server? (the browser never says) — search once per choice
  useEffect(() => {
    if (!selection || empty) return
    let current = true
    const sample = selection.files.map((p) => p.path).slice(0, 20)
    api
      .findFolder(selection.folder, sample)
      .then((list) => {
        if (!current) return
        setFound(list)
        setPath(list[0]?.path ?? "")
        // a copy by default; in place only when the folder is too large to upload and was found
        setMode(tooBig && list.length ? "in_place" : "copy")
      })
      .catch(() => {
        if (!current) return
        setFound([])
        setMode("copy")
      })
    return () => {
      current = false
    }
  }, [selection, empty, tooBig])

  const copy = async () => {
    if (!selection || empty || tooBig) return
    setReading(true)
    try {
      const encoded = await Promise.all(
        selection.files.map(async (p) => ({ path: p.path, content_base64: await toBase64(p.file) })),
      )
      // a copy of that name (imported before, maybe removed from the list) is updated with this folder
      importer.mutate({ name, files: encoded, activate, overwrite: true }, { onSuccess: onImported })
    } finally {
      setReading(false)
    }
  }
  const submit = () =>
    mode === "in_place"
      ? inPlace.mutate({ path: path.trim(), mode: "in_place", name: null, activate }, { onSuccess: onImportedInPlace })
      : void copy()

  return (
    <Card className="mb-4 py-4">
      <CardContent className="grid gap-4 px-4 text-sm">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 truncate font-medium">
            Import <code className="font-mono">{selection?.folder ?? "folder"}/</code>
            {selection && !empty && (
              <span className="text-muted-foreground text-sm font-normal">
                {" "}
                · {selection.files.length} file{selection.files.length === 1 ? "" : "s"}, {formatSize(totalSize)}
              </span>
            )}
          </h2>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close import">
            <X />
          </Button>
        </div>

        {empty ? (
          <ErrorAlert
            title="Nothing to import"
            error={new Error("The folder has no files to import (hidden and cache files are left out).")}
          />
        ) : mode === null ? (
          <span className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Looking for this folder on the server…
          </span>
        ) : (
          <>
            <div className="grid gap-2">
              <span className="font-medium">How to import it</span>
              <div role="radiogroup" className="grid gap-2 md:grid-cols-2">
                <ModeChoice
                  on={mode === "in_place"}
                  onClick={() => setMode("in_place")}
                  icon={GitBranch}
                  title="Work on it in place"
                  text="Prooflix uses the folder where it is on the server: in a git checkout, the branch checked out there. Edits go into it; nothing is copied."
                />
                <ModeChoice
                  on={mode === "copy"}
                  onClick={() => setMode("copy")}
                  icon={Copy}
                  title="Copy it into PROOFLIX_HOME/workspaces"
                  text="The folder's files are uploaded into a copy Prooflix works on. The original stays as it is."
                />
              </div>
            </div>

            {mode === "in_place" && (
              <div className="grid gap-2">
                <span className="font-medium">Where it is on the server</span>
                {found && found.length > 0 ? (
                  <div className="grid gap-1" role="radiogroup" aria-label="Folders found">
                    {found.map((f) => (
                      <label
                        key={f.path}
                        className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1"
                      >
                        <input
                          type="radio"
                          className="accent-primary"
                          checked={path === f.path}
                          onChange={() => setPath(f.path)}
                        />
                        <code className="min-w-0 truncate font-mono text-xs">{f.path}</code>
                        {f.branch && (
                          <span className="text-muted-foreground flex shrink-0 items-center gap-0.5 font-mono text-xs">
                            <GitBranch className="size-3" /> {f.branch}
                          </span>
                        )}
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {f.matches} of {Math.min(selection.files.length, 20)} files match
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    No folder named <code className="font-mono">{selection.folder}</code> with a pipelines/ folder was
                    found on the server. Give its path below, or copy it instead.
                  </p>
                )}
                <FolderPicker value={path} onChange={setPath} />
                <p className="text-muted-foreground text-xs">
                  Pick one that was found, or browse to or type the exact path.
                </p>
              </div>
            )}

            {mode === "copy" &&
              (tooBig ? (
                <Alert>
                  <TriangleAlert />
                  <AlertTitle>Too large to copy from the browser</AlertTitle>
                  <AlertDescription className="grid gap-2">
                    <span>
                      It has {selection.files.length.toLocaleString()} files ({formatSize(totalSize)}); one copy can
                      carry at most {MAX_FILES.toLocaleString()} files and {formatSize(MAX_BYTES)}. Largest:{" "}
                      {biggest(selection.files).map((b, i) => (
                        <span key={b.name}>
                          {i > 0 && ", "}
                          <code className="font-mono">{b.name}</code> {formatSize(b.size)}
                        </span>
                      ))}
                      . Work on it in place instead: nothing is uploaded.
                    </span>
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="grid gap-1.5">
                  <span className="font-medium">Name of the copy</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-muted-foreground font-mono text-xs">PROOFLIX_HOME/workspaces/</code>
                    <Input
                      className="w-64"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      aria-label="Name of the copy"
                    />
                  </div>
                </div>
              ))}

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-primary size-4"
                checked={activate}
                onChange={(e) => setActivate(e.target.checked)}
              />
              Make it the active workspace
            </label>
          </>
        )}

        {error && <ErrorAlert title="Import failed" error={error} />}
        <div className="flex flex-wrap items-center gap-2">
          {!empty && mode !== null && (
            <Button onClick={submit} disabled={busy || (mode === "in_place" ? !path.trim() : tooBig || !name.trim())}>
              {busy ? <Loader2 className="animate-spin" /> : mode === "copy" ? <Copy /> : <FolderOpen />}
              {mode === "copy" ? "Copy and import" : "Import in place"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onChooseAgain} disabled={busy}>
            <FolderInput /> Choose another folder
          </Button>
          <button type="button" className="text-muted-foreground text-xs underline" onClick={onServerPath}>
            The folder is on another computer? Give a path on the server
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

function ModeChoice({
  on,
  onClick,
  icon: Icon,
  title,
  text,
}: {
  on: boolean
  onClick: () => void
  icon: typeof Copy
  title: string
  text: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "grid gap-1 rounded-md border p-3 text-left",
        on ? "border-primary bg-primary/5 ring-primary/30 ring-2" : "hover:bg-accent",
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <Icon className="text-primary size-4" /> {title}
      </span>
      <span className="text-muted-foreground text-xs">{text}</span>
    </button>
  )
}
