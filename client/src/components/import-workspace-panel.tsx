import { useEffect, useRef, useState } from "react"
import { ArrowLeftRight, FolderInput, Loader2, TriangleAlert, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useImportWorkspace } from "@/lib/api"
import type { ImportWorkspaceResult } from "@/lib/types"

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
  onOpenFolder,
}: {
  /** the chosen or dropped folder (null: nothing usable was chosen) */
  selection: FolderSelection | null
  /** open the folder picker again (or drop another folder) */
  onChooseAgain: () => void
  onClose: () => void
  onImported: (result: ImportWorkspaceResult) => void
  /** use the folder where it is on the server instead (Switch workspace → Open another folder) */
  onOpenFolder: () => void
}) {
  const name = selection ? suggestName(selection.folder) : ""
  const [reading, setReading] = useState(false)
  const importer = useImportWorkspace()

  const totalSize = selection?.files.reduce((n, p) => n + p.file.size, 0) ?? 0
  const busy = reading || importer.isPending
  // Checked before reading anything: a large folder would stall the browser while it is encoded.
  const tooBig = !!selection && (totalSize > MAX_BYTES || selection.files.length > MAX_FILES)
  const empty = !selection || selection.files.length === 0

  const submit = async () => {
    if (!selection || empty || tooBig) return
    setReading(true)
    try {
      const encoded = await Promise.all(
        selection.files.map(async (p) => ({ path: p.path, content_base64: await toBase64(p.file) })),
      )
      // a workspace of that name (imported before, maybe removed from the list) is updated with this folder
      importer.mutate({ name, files: encoded, activate: true, overwrite: true }, { onSuccess: onImported })
    } finally {
      setReading(false)
    }
  }

  // Import as soon as a folder is chosen (once per choice, also under React's double effects).
  const started = useRef<FolderSelection | null | undefined>(undefined)
  useEffect(() => {
    if (started.current === selection) return
    started.current = selection
    importer.reset()
    void submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  return (
    <Card className="mb-4 py-4">
      <CardContent className="grid gap-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {busy && <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />}
            <h2 className="truncate font-medium">
              {busy ? "Importing" : "Import"} <code className="font-mono">{selection?.folder ?? "folder"}/</code>
              {selection && !empty && (
                <span className="text-muted-foreground text-sm font-normal">
                  {" "}
                  · {selection.files.length} file{selection.files.length === 1 ? "" : "s"}, {formatSize(totalSize)}
                </span>
              )}
            </h2>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close import">
            <X />
          </Button>
        </div>

        {empty ? (
          <ErrorAlert
            title="Nothing to import"
            error={new Error("The folder has no files to import (hidden and cache files are left out).")}
          />
        ) : tooBig ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>This folder is too large to import from the browser</AlertTitle>
            <AlertDescription className="grid gap-2">
              <span>
                It has {selection.files.length.toLocaleString()} files ({formatSize(totalSize)}); one import can carry
                at most {MAX_FILES.toLocaleString()} files and {formatSize(MAX_BYTES)}. Largest:{" "}
                {biggest(selection.files).map((b, i) => (
                  <span key={b.name}>
                    {i > 0 && ", "}
                    <code className="font-mono">{b.name}</code> {formatSize(b.size)}
                  </span>
                ))}
                .
              </span>
              <span>
                If the folder is on the computer running Prooflix, open it where it is instead: nothing is copied, and
                its data stays in place.
              </span>
              <div>
                <Button size="sm" variant="outline" onClick={onOpenFolder}>
                  <ArrowLeftRight /> Open a folder instead
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          importer.error && <ErrorAlert title="Import failed" error={importer.error} />
        )}

        {!busy && (empty || tooBig || importer.error) && (
          <div>
            <Button variant="outline" size="sm" onClick={onChooseAgain}>
              <FolderInput /> Choose another folder
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
