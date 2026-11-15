import { useState } from "react"
import { Check, Database, FolderInput, Loader2, Pencil, RotateCcw, type LucideIcon } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { FolderPicker } from "@/components/folder-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useLinkedFolder, useSetLinkedFolder } from "@/lib/api"
import type { LinkedFolder, LinkedFolderKind } from "@/lib/types"

const KIND: Record<
  LinkedFolderKind,
  { title: string; icon: LucideIcon; linked: (f: LinkedFolder) => string; unlinked: string }
> = {
  "source-data": {
    title: "Source data folder",
    icon: FolderInput,
    linked: () => "Pipelines read the raw files from source/, which links to this folder. Nothing is written to it.",
    unlinked: "Pipelines read the raw files from source/ in the workspace. Choose a folder elsewhere to read them in place.",
  },
  "data-lake": {
    title: "Data lake folder",
    icon: Database,
    linked: () =>
      "Pipelines build bronze, gold and their checkpoints in data/, which links to this folder; the catalog and SQL read it.",
    unlinked:
      "Pipelines build bronze, gold and their checkpoints in data/ in the workspace. Choose a folder elsewhere (a big disk) to build them there.",
  },
}

const ORIGIN_LABEL = { workspace: "This workspace", server: "Server default", default: "In the workspace" } as const

/**
 * One of the active workspace's linked folders: source data (source/, the raw files
 * pipelines read) or the data lake (data/, what they build, checkpoints included).
 */
export function LinkedFolderSection({ kind }: { kind: LinkedFolderKind }) {
  const folder = useLinkedFolder(kind)
  const setter = useSetLinkedFolder(kind)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const spec = KIND[kind]
  const Icon = spec.icon

  if (!folder.data) return folder.error ? <ErrorAlert title={`Could not read the ${spec.title.toLowerCase()}`} error={folder.error} /> : null
  const f = folder.data

  const save = (path: string | null) => setter.mutate(path, { onSuccess: () => setEditing(false) })

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="text-primary size-4 shrink-0" />
        <span className="text-foreground text-sm font-medium">{spec.title}</span>
        <Badge variant="outline">{ORIGIN_LABEL[f.origin]}</Badge>
        <div className="ml-auto flex gap-2">
          {f.workspace_setting && !editing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => save(null)}
              disabled={setter.isPending}
              title={f.server_default ? `Back to the server default ${f.server_default}` : `Back to ${f.link}/ in the workspace`}
            >
              <RotateCcw /> Use default
            </Button>
          )}
          {!editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(f.origin === "default" ? "" : f.path)
                setter.reset()
                setEditing(true)
              }}
            >
              <Pencil /> Change
            </Button>
          )}
        </div>
      </div>
      <code className="text-foreground block font-mono text-xs break-all">{f.path}</code>
      <p className="text-xs">{f.linked ? spec.linked(f) : spec.unlinked}</p>

      {editing && (
        <div className="grid gap-2 border-t pt-3">
          <p className="text-sm font-medium">Folder on the server</p>
          <FolderPicker value={draft} onChange={setDraft} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => save(draft)} disabled={setter.isPending || !draft.trim()}>
              <span className="contents">{setter.isPending ? <Loader2 className="animate-spin" /> : <Check />}</span> Use
              this folder
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={setter.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {setter.error && <ErrorAlert title={`Could not change the ${spec.title.toLowerCase()}`} error={setter.error} />}
    </div>
  )
}
