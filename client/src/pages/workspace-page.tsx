import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import {
  ArrowLeftRight,
  Braces,
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  File,
  FileArchive,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  RefreshCw,
  Table2,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import { LinkedFolderSection } from "@/components/linked-folder-section"
import { ErrorAlert } from "@/components/error-alert"
import {
  FolderPickerInput,
  ImportWorkspacePanel,
  readDroppedFolder,
  type FolderSelection,
} from "@/components/import-workspace-panel"
import { NewWorkspacePanel } from "@/components/new-workspace-panel"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { SwitchWorkspacePanel } from "@/components/switch-workspace-panel"
import { useForgetWorkspace, useRemoveWorkspaceItem, useWorkspaceFile, useWorkspaces, useWorkspaceTree } from "@/lib/api"
import { sqlTableFor } from "@/lib/sql-names"
import type { ImportWorkspaceResult, RemoveResult, WorkspaceEntry, WorkspaceList, WorkspaceNode } from "@/lib/types"
import { useFillHeight } from "@/lib/use-fill-height"
import { cn } from "@/lib/utils"

export function WorkspacePage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get("path")
  const tree = useWorkspaceTree()
  const workspaces = useWorkspaces()
  // one panel at a time under the header
  // "open-folder" is the switch panel with its folder picker already shown
  const [panel, setPanel] = useState<"import" | "new" | "switch" | "open-folder" | null>(null)
  const [removed, setRemoved] = useState<RemoveResult | null>(null)
  const remover = useRemoveWorkspaceItem()
  const forgetter = useForgetWorkspace()
  // the name of the workspace just removed from the list
  const [removedWs, setRemovedWs] = useState<string | null>(null)
  const [imported, setImported] = useState<ImportWorkspaceResult | null>(null)
  // Import Workspace opens the folder picker straight away; the chosen folder is imported directly
  const folderPicker = useRef<HTMLInputElement>(null)
  // the folder to import, chosen with the picker or dropped on the page; id remounts the panel for each one
  const [picked, setPicked] = useState<{ id: number; selection: FolderSelection | null } | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const pickFolder = () => folderPicker.current?.click()
  const importFolder = (selection: FolderSelection | null) => {
    setPicked((prev) => ({ id: (prev?.id ?? 0) + 1, selection }))
    setPanel("import")
    setImported(null)
    setDropError(null)
  }
  const dragging = useFolderDrop((data) => {
    void readDroppedFolder(data).then((r) => (typeof r === "string" ? setDropError(r) : importFolder(r)))
  })
  // On md+ screens the tree and the viewer fill the window and scroll inside.
  const panels = useRef<HTMLDivElement>(null)
  const panelsHeight = useFillHeight(panels)
  const selectedNode = useMemo(
    () => (selected && tree.data ? findNode(tree.data, selected) : null),
    [selected, tree.data],
  )

  const remove = (node: WorkspaceNode) => {
    const what =
      node.type === "dir"
        ? `the folder "${node.path}" and everything in it (${countFiles(node)} file${countFiles(node) === 1 ? "" : "s"})`
        : `the file "${node.path}"`
    if (
      !confirm(
        `Remove ${what} from the workspace?\n\nIt is moved to the workspace's .prooflix/trash folder, so it can be recovered there.`,
      )
    )
      return
    remover.mutate(node.path, {
      onSuccess: (r) => {
        setRemoved(r)
        const parent = node.path.split("/").slice(0, -1).join("/")
        setParams(parent ? { path: parent } : {})
      },
    })
  }

  const removeWorkspace = (w: WorkspaceEntry) => {
    if (!confirmRemoveWorkspace(w)) return
    setRemovedWs(null)
    forgetter.mutate(w.path, {
      onSuccess: () => {
        setRemovedWs(w.name)
        setRemoved(null)
        // the tree now shows another workspace when the active one was removed
        if (w.active) setParams({})
      },
    })
  }
  const activeWorkspace = workspaces.data?.workspaces.find((w) => w.active)
  // every workspace removed (or none yet): nothing to show in the tree
  const noWorkspace = workspaces.data?.active === null

  return (
    <>
      <PageHeader
        title="Workspace"
        description={
          noWorkspace ? (
            "No active workspace"
          ) : workspaces.data ? (
            <>
              Active workspace{" "}
              <code className="text-foreground font-mono font-semibold" title={workspaces.data.active ?? undefined}>
                {activeWorkspace?.name}
              </code>
            </>
          ) : undefined
        }
        actions={
          <>
            <Button variant="outline" onClick={() => tree.refetch()} disabled={tree.isFetching || noWorkspace}>
              <RefreshCw className={cn(tree.isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="outline" onClick={() => setPanel("new")} disabled={panel === "new"}>
              <FolderPlus /> New workspace
            </Button>
            <Button variant="outline" onClick={() => setPanel("switch")} disabled={panel === "switch" || panel === "open-folder"}>
              <ArrowLeftRight /> Switch workspace
            </Button>
            <Button onClick={pickFolder}>
              <FolderInput /> Import Workspace
            </Button>
            <FolderPickerInput
              inputRef={folderPicker}
              onPicked={importFolder}
            />
          </>
        }
      />
      {panel === "new" && <NewWorkspacePanel onClose={() => setPanel(null)} />}
      {(panel === "switch" || panel === "open-folder") && (
        <SwitchWorkspacePanel
          openFolder={panel === "open-folder"}
          onClose={() => setPanel(null)}
          onSwitched={() => {
            setPanel(null)
            setRemoved(null)
            setParams({})
          }}
        />
      )}
      {dragging && (
        <div className="bg-background/80 pointer-events-none fixed inset-0 z-50 grid place-items-center p-6 backdrop-blur-sm">
          <div className="border-primary text-foreground grid justify-items-center gap-2 rounded-xl border-2 border-dashed px-10 py-8 text-center">
            <FolderInput className="text-primary size-8" />
            <p className="font-medium">Drop a folder to import it as a workspace</p>
            <p className="text-muted-foreground text-sm">It is named after the folder and becomes the active workspace.</p>
          </div>
        </div>
      )}
      {dropError && (
        <Alert className="mb-4">
          <FolderInput />
          <AlertTitle>Can't import this</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            <span>{dropError}</span>
            <button type="button" className="underline" onClick={() => setDropError(null)}>
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}
      {panel === "import" && picked && (
        <ImportWorkspacePanel
          key={picked.id}
          selection={picked.selection}
          onChooseAgain={pickFolder}
          onClose={() => setPanel(null)}
          onOpenFolder={() => setPanel("open-folder")}
          onImported={(r) => {
            setPanel(null)
            setImported(r)
            setRemoved(null)
            setRemovedWs(null)
            if (r.workspace.active) setParams({})
          }}
        />
      )}
      {imported && (
        <Alert className="mb-4">
          <FolderInput />
          <AlertTitle>
            Imported the workspace <code className="font-mono">{imported.workspace.name}</code> ({imported.written} file
            {imported.written === 1 ? "" : "s"})
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            <span>
              {imported.workspace.active ? "It is now the active workspace." : "Switch to it to use it."}
              {imported.pipelines.length > 0 && (
                <>
                  {" "}
                  Pipelines: <span className="font-mono">{imported.pipelines.join(", ")}</span>.
                </>
              )}
            </span>
            <button type="button" className="underline" onClick={() => setImported(null)}>
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}
      {tree.error && <ErrorAlert error={tree.error} />}
      {remover.error && <ErrorAlert title="Could not remove" error={remover.error} />}
      {forgetter.error && <ErrorAlert title="Could not remove the workspace" error={forgetter.error} />}
      {removedWs && (
        <Alert className="mb-4">
          <Trash2 />
          <AlertTitle>
            Removed the workspace <code className="font-mono">{removedWs}</code> from the list
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            <span>Its folder and files were not touched. Open it with Switch workspace to list it again.</span>
            <button type="button" className="underline" onClick={() => setRemovedWs(null)}>
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}
      {removed && (
        <Alert className="mb-4">
          <Trash2 />
          <AlertTitle>
            Removed <code className="font-mono">{removed.path}</code>
            {removed.type === "dir" && ` (${removed.files} file${removed.files === 1 ? "" : "s"})`}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            A copy is in <code className="font-mono">{removed.trash}</code> in the workspace.
            <button type="button" className="underline" onClick={() => setRemoved(null)}>
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}
      <div
        ref={panels}
        style={panelsHeight ? { height: panelsHeight } : undefined}
        className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
      >
        <Card className="max-h-[70vh] gap-0 overflow-auto p-1.5 md:max-h-none">
          {workspaces.data && (
            <WorkspaceListSection list={workspaces.data} onRemove={removeWorkspace} removing={forgetter.isPending} />
          )}
          <div role="tree" aria-label="Workspace files">
            {noWorkspace ? null : tree.isLoading ? (
              <Skeleton className="m-1 h-64" />
            ) : (
              tree.data && (
                // the workspace folder itself is the root of the tree
                <TreeNode node={tree.data} depth={0} selected={selected} onSelect={(path) => setParams({ path })} />
              )
            )}
          </div>
        </Card>
        {noWorkspace ? (
          <Card className="text-muted-foreground grid min-h-64 place-items-center p-6 text-center text-sm md:min-h-0">
            <div className="grid justify-items-center gap-3">
              <p>There are no workspaces. Drop a folder here to import it, create one, or open a folder on the server.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={pickFolder}>
                  <FolderInput /> Import Workspace
                </Button>
                <Button variant="outline" onClick={() => setPanel("new")}>
                  <FolderPlus /> New workspace
                </Button>
                <Button variant="outline" onClick={() => setPanel("open-folder")}>
                  <ArrowLeftRight /> Open a folder
                </Button>
              </div>
            </div>
          </Card>
        ) : selectedNode?.type === "dir" ? (
          <FolderViewer
            node={selectedNode}
            onRemove={remove}
            removing={remover.isPending}
            onRemoveWorkspace={activeWorkspace ? () => removeWorkspace(activeWorkspace) : undefined}
            removingWorkspace={forgetter.isPending}
          />
        ) : (
          <FileViewer
            path={selected}
            onRemove={selectedNode ? () => remove(selectedNode) : undefined}
            removing={remover.isPending}
          />
        )}
      </div>
    </>
  )
}

/**
 * Every known workspace, the active one in bold; switching is done with the Switch workspace button.
 * Each can be removed from here; removing the active one switches to another first.
 */
function WorkspaceListSection({
  list,
  onRemove,
  removing,
}: {
  list: WorkspaceList
  onRemove: (w: WorkspaceEntry) => void
  removing: boolean
}) {
  return (
    <div className="mb-1.5 border-b pb-1.5">
      <p className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium tracking-wide uppercase">Workspaces</p>
      {list.workspaces.length === 0 && <p className="text-muted-foreground px-2 py-1 text-sm italic">none</p>}
      <ul aria-label="Workspaces">
        {list.workspaces.map((w) => (
          <li
            key={w.path}
            aria-current={w.active ? "true" : undefined}
            title={w.exists ? w.path : `${w.path} (missing)`}
            className={cn(
              "group hover:bg-accent flex h-7 items-center gap-1.5 rounded-md pr-1 pl-2 text-sm",
              w.active ? "text-foreground font-bold" : "text-muted-foreground",
            )}
          >
            {w.active ? <Check className="text-primary size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
            <span className={cn("min-w-0 flex-1 truncate", !w.exists && "italic line-through")}>{w.name}</span>
            <button
              type="button"
              onClick={() => onRemove(w)}
              disabled={removing}
              aria-label={`Remove workspace ${w.name}`}
              title="Remove from the list (the folder is kept)"
              className="text-muted-foreground hover:text-destructive focus-visible:ring-ring grid size-6 shrink-0 place-items-center rounded-sm opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Ask before removing a workspace from the list. */
function confirmRemoveWorkspace(w: WorkspaceEntry): boolean {
  const active = w.active
    ? "\n\nIt is the active workspace: the server switches to another one first, or to none if it is the last one."
    : ""
  return confirm(
    `Remove the workspace "${w.name}" from the list?\n\nIts folder ${w.path} and its files are not touched.${active}`,
  )
}

const ROOT = "." // the workspace folder's path in the tree
const INDENT = 16 // px per level
const ROW_PAD = 4 // px before the first level's arrow

/** An icon for a file, from its extension (and pipeline YAML files from their folder). */
function fileIcon(path: string): LucideIcon {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  if ((ext === "yaml" || ext === "yml") && /(^|\/)pipelines\//.test(path)) return Workflow
  if (ext === "yaml" || ext === "yml" || ext === "py" || ext === "ts" || ext === "sql" || ext === "sh") return FileCode
  if (ext === "parquet") return Table2
  if (ext === "avro" || ext === "zip" || ext === "gz") return FileArchive
  if (ext === "json") return Braces
  if (ext === "md" || ext === "txt" || ext === "csv") return FileText
  return File
}

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: WorkspaceNode
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  // the root's path is "." and its children's paths don't start with it
  const containsSelected = !!selected && (node.path === ROOT ? selected !== ROOT : selected.startsWith(`${node.path}/`))
  const [open, setOpen] = useState(depth === 0 || containsSelected)
  // Open the folders leading to a file selected from elsewhere (e.g. after an import).
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])
  const left = depth * INDENT + ROW_PAD
  const isSelected = selected === node.path
  const row = cn(
    "hover:bg-accent flex w-full items-center gap-1.5 rounded-md pr-2 text-sm",
    isSelected && "bg-accent text-foreground font-medium",
  )
  const focus = "focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"

  if (node.type === "file") {
    const Icon = fileIcon(node.path)
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={isSelected}
        onClick={() => onSelect(node.path)}
        style={{ paddingLeft: left }}
        className={cn(row, focus, "h-7 text-left")}
        title={node.path}
      >
        <span className="size-4 shrink-0" />
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }

  const Icon = open ? FolderOpen : Folder
  const children = node.children ?? []
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={isSelected}>
      <div style={{ paddingLeft: left }} className={cn(row, "h-7")}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          className={cn("text-muted-foreground hover:text-foreground grid size-4 shrink-0 place-items-center", focus)}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (isSelected) setOpen(!open)
            else {
              onSelect(node.path)
              setOpen(true)
            }
          }}
          title={node.path}
          className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 text-left", focus)}
        >
          <Icon className="text-primary size-4 shrink-0" />
          <span className="truncate">{node.name}</span>
          {!open && children.length > 0 && (
            <span className="text-muted-foreground ml-auto pl-2 text-xs tabular-nums">{children.length}</span>
          )}
        </button>
      </div>
      {open && children.length > 0 && (
        <div role="group" className="relative">
          {/* guide line from this folder's arrow down along its children */}
          <span aria-hidden className="bg-border absolute top-0 bottom-1.5 w-px" style={{ left: left + 8 }} />
          {children.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
      {open && children.length === 0 && (
        <p className="text-muted-foreground h-6 text-xs italic" style={{ paddingLeft: left + INDENT + 22 }}>
          empty
        </p>
      )}
    </div>
  )
}

function findNode(node: WorkspaceNode, path: string): WorkspaceNode | null {
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    if (path === child.path || path.startsWith(`${child.path}/`)) {
      const found = findNode(child, path)
      if (found) return found
    }
  }
  return null
}

function countFiles(node: WorkspaceNode): number {
  return node.type === "file" ? 1 : (node.children ?? []).reduce((n, c) => n + countFiles(c), 0)
}

function FolderViewer({
  node,
  onRemove,
  removing,
  onRemoveWorkspace,
  removingWorkspace,
}: {
  node: WorkspaceNode
  onRemove: (node: WorkspaceNode) => void
  removing: boolean
  /** for the workspace folder itself (the root of the tree) */
  onRemoveWorkspace?: () => void
  removingWorkspace?: boolean
}) {
  const files = countFiles(node)
  const isProject = node.children?.some((c) => c.type === "dir" && c.name === "pipelines")
  return (
    <Card className="min-w-0 gap-0 self-start overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FolderOpen className="text-primary size-4" />
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{node.path === ROOT ? node.name : node.path}/</code>
        {node.path !== ROOT ? (
          <Button variant="outline" size="sm" onClick={() => onRemove(node)} disabled={removing}>
            <Trash2 /> Remove folder
          </Button>
        ) : (
          // the root is the workspace folder itself: removing it removes the workspace
          onRemoveWorkspace && (
            <Button variant="outline" size="sm" onClick={onRemoveWorkspace} disabled={removingWorkspace}>
              <Trash2 /> Remove workspace
            </Button>
          )
        )}
      </div>
      <div className="text-muted-foreground grid gap-1 p-4 text-sm">
        <p>
          {files} file{files === 1 ? "" : "s"} in {node.children?.length ?? 0} item
          {node.children?.length === 1 ? "" : "s"}.
        </p>
        {isProject && <p>This is a project: its pipelines are listed in the Pipelines tab.</p>}
        <p>Select a file in the tree to view it.</p>
        {node.path === ROOT && (
          <div className="mt-2 grid gap-3">
            <LinkedFolderSection kind="source-data" />
            <LinkedFolderSection kind="data-lake" />
          </div>
        )}
      </div>
    </Card>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FileViewer({ path, onRemove, removing }: { path: string | null; onRemove?: () => void; removing?: boolean }) {
  const file = useWorkspaceFile(path)
  const navigate = useNavigate()
  const lines = useMemo(() => file.data?.content?.split("\n") ?? [], [file.data?.content])

  if (!path) {
    return (
      <Card className="text-muted-foreground grid min-h-64 place-items-center text-sm md:min-h-0">
        Select a file or folder.
      </Card>
    )
  }

  const pipelineId = /^pipelines\/([^/]+)\.ya?ml$/.exec(path)?.[1]
  const table = sqlTableFor(path)

  return (
    <Card className="min-h-0 min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{path}</code>
        {file.data && <span className="text-muted-foreground text-xs">{formatSize(file.data.size)}</span>}
        {pipelineId && (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/pipelines/${pipelineId}`}>
              <ExternalLink /> Open in Pipelines
            </Link>
          </Button>
        )}
        {table && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/sql", { state: { sql: `SELECT *\nFROM ${table}\nLIMIT 100;` } })}
          >
            <Database /> Query in SQL Editor
          </Button>
        )}
        {onRemove && (
          <Button variant="outline" size="sm" onClick={onRemove} disabled={removing}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      {file.error ? (
        <div className="p-4">
          <ErrorAlert title="Could not open file" error={file.error} />
        </div>
      ) : file.isLoading ? (
        <Skeleton className="m-4 h-64" />
      ) : file.data?.binary ? (
        <div className="text-muted-foreground p-6 text-sm">This is a binary file and can't be shown.</div>
      ) : (
        <div className="max-h-[70vh] min-h-0 overflow-auto md:max-h-none md:flex-1">
          <table className="font-mono text-[13px] leading-relaxed">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="text-muted-foreground/70 sticky left-0 bg-card px-3 text-right align-top select-none">
                    {i + 1}
                  </td>
                  <td className="pr-4 whitespace-pre">{line || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {file.data?.truncated && (
            <div className="text-muted-foreground border-t px-4 py-2 text-xs">Showing the first 1 MB of this file.</div>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * Accept a folder dragged onto the page: true while one is dragged over it, and
 * onDrop gets the drop's data (read it straight away: the browser allows it only then).
 */
function useFolderDrop(onDrop: (data: DataTransfer) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(onDrop)
  latest.current = onDrop
  useEffect(() => {
    let depth = 0 // dragenter/dragleave fire for every element crossed
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault() // allow dropping here instead of the browser opening the files
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer) latest.current(e.dataTransfer)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragover", over)
    window.addEventListener("dragleave", leave)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragover", over)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("drop", drop)
    }
  }, [])
  return dragging
}

