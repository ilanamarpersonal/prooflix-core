import { useEffect, useState } from "react"
import { Copy, FolderInput, FolderOpen, GitBranch, Loader2, Upload, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { FolderPicker } from "@/components/folder-picker"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useImportPath } from "@/lib/api"
import type { ImportPathResult } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A folder name the server accepts: letters, digits, spaces, ".", "_" or "-", starting with a letter or digit. */
const suggestName = (path: string) =>
  (path.replace(/\/+$/, "").split("/").pop() ?? "").replace(/[^A-Za-z0-9._ -]/g, "-").replace(/^[^A-Za-z0-9]+/, "")

/**
 * Import a project that is on the server, from its exact path: work on it in place
 * (the branch checked out there), or copy it into PROOFLIX_HOME/workspaces.
 * Uploading a folder from this computer is the other way in.
 */
export function ImportProjectPanel({
  onClose,
  onImported,
  onUpload,
}: {
  onClose: () => void
  onImported: (r: ImportPathResult) => void
  /** choose a folder on this computer instead (it is copied into PROOFLIX_HOME/workspaces) */
  onUpload: () => void
}) {
  const [path, setPath] = useState("")
  const [mode, setMode] = useState<"in_place" | "copy">("copy")
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)
  const [activate, setActivate] = useState(true)
  const importer = useImportPath()

  useEffect(() => {
    if (!nameTouched) setName(suggestName(path))
  }, [path, nameTouched])

  const submit = () =>
    importer.mutate(
      { path: path.trim(), mode, name: mode === "copy" ? name.trim() : null, activate },
      { onSuccess: onImported },
    )

  return (
    <Card className="mb-4 gap-0 py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <FolderInput className="text-primary size-4" />
        <CardTitle className="flex-1 text-base">Import a project</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X /> Close
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 px-4 py-4 text-sm">
        <div className="grid gap-1.5">
          <label htmlFor="import-path" className="font-medium">
            The project's folder on the server
          </label>
          <FolderPicker id="import-path" value={path} onChange={setPath} />
          <p className="text-muted-foreground text-xs">
            The exact path, such as <code className="font-mono">/Users/me/github/my-project/workspace/vanilla</code>: a
            folder with a <code className="font-mono">pipelines/</code> folder.
          </p>
        </div>

        <div className="grid gap-2">
          <span className="font-medium">How to use it</span>
          <div role="radiogroup" className="grid gap-2 md:grid-cols-2">
            <Choice
              on={mode === "in_place"}
              onClick={() => setMode("in_place")}
              icon={GitBranch}
              title="Work on it in place"
              text="Prooflix uses the folder where it is. In a git checkout you work on the branch checked out there: edits go into it, and switching branches there switches what Prooflix runs."
            />
            <Choice
              on={mode === "copy"}
              onClick={() => setMode("copy")}
              icon={Copy}
              title="Copy it into PROOFLIX_HOME/workspaces"
              text="Prooflix works on its own copy (without .git, caches and virtualenvs). The original folder is left as it is."
            />
          </div>
        </div>

        {mode === "copy" && (
          <div className="grid gap-1.5">
            <label htmlFor="import-name" className="font-medium">
              Name of the copy
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-muted-foreground font-mono text-xs">PROOFLIX_HOME/workspaces/</code>
              <Input
                id="import-name"
                className="w-64"
                value={name}
                onChange={(e) => {
                  setNameTouched(true)
                  setName(e.target.value)
                }}
              />
            </div>
          </div>
        )}

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-primary size-4"
            checked={activate}
            onChange={(e) => setActivate(e.target.checked)}
          />
          Make it the active workspace
        </label>

        {importer.error && <ErrorAlert title="Not imported" error={importer.error} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={!path.trim() || (mode === "copy" && !name.trim()) || importer.isPending}>
            {importer.isPending ? <Loader2 className="animate-spin" /> : mode === "copy" ? <Copy /> : <FolderOpen />}
            {mode === "copy" ? "Copy and import" : "Import in place"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <span className="text-muted-foreground mx-1 text-xs">or</span>
          <Button variant="outline" onClick={onUpload}>
            <Upload /> Upload a folder from this computer
          </Button>
          <span className="text-muted-foreground text-xs">
            (copied into PROOFLIX_HOME/workspaces; you can also drop it on the page)
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function Choice({
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
