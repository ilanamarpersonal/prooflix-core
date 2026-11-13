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

import { ErrorAlert } from "@/components/error-alert"
import { ImportCodePanel } from "@/components/import-code-panel"
import { NewWorkspacePanel } from "@/components/new-workspace-panel"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { SwitchWorkspacePanel } from "@/components/switch-workspace-panel"
import { useRemoveWorkspaceItem, useWorkspaceFile, useWorkspaces, useWorkspaceTree } from "@/lib/api"
import { sqlTableFor } from "@/lib/sql-names"
import type { RemoveResult, WorkspaceList, WorkspaceNode } from "@/lib/types"
import { useFillHeight } from "@/lib/use-fill-height"
import { cn } from "@/lib/utils"

export function WorkspacePage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get("path")
  const tree = useWorkspaceTree()
  const workspaces = useWorkspaces()
  // one panel at a time under the header
  const [panel, setPanel] = useState<"import" | "new" | "switch" | null>(null)
  const [removed, setRemoved] = useState<RemoveResult | null>(null)
  const remover = useRemoveWorkspaceItem()
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
        `Remove ${what} from the workspace?\n\nIt is moved to workspace/.prooflix/trash, so it can be recovered there.`,
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

  return (
    <>
      <PageHeader
        title="Workspace"
        description={
          workspaces.data ? (
            <>
              Active workspace{" "}
              <code className="text-foreground font-mono font-semibold" title={workspaces.data.active}>
                {workspaces.data.workspaces.find((w) => w.active)?.name}
              </code>
            </>
          ) : undefined
        }
        actions={
          <>
            <Button variant="outline" onClick={() => tree.refetch()} disabled={tree.isFetching}>
              <RefreshCw className={cn(tree.isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button variant="outline" onClick={() => setPanel("new")} disabled={panel === "new"}>
              <FolderPlus /> New workspace
            </Button>
            <Button variant="outline" onClick={() => setPanel("switch")} disabled={panel === "switch"}>
              <ArrowLeftRight /> Switch workspace
            </Button>
            <Button onClick={() => setPanel("import")} disabled={panel === "import"}>
              <FolderInput /> Import code
            </Button>
          </>
        }
      />
      {panel === "new" && <NewWorkspacePanel onClose={() => setPanel(null)} />}
      {panel === "switch" && (
        <SwitchWorkspacePanel
          onClose={() => setPanel(null)}
          onSwitched={() => {
            setPanel(null)
            setRemoved(null)
            setParams({})
          }}
        />
      )}
      {panel === "import" && (
        <ImportCodePanel
          onClose={() => setPanel(null)}
          onImported={(r) => {
            // Show what was imported: a pipeline if there is one, else the first file.
            const first = r.written.find((p) => /(^|\/)pipelines\/[^/]+\.ya?ml$/.test(p)) ?? r.written[0]
            if (first) setParams({ path: first })
          }}
        />
      )}
      {tree.error && <ErrorAlert error={tree.error} />}
      {remover.error && <ErrorAlert title="Could not remove" error={remover.error} />}
      {removed && (
        <Alert className="mb-4">
          <Trash2 />
          <AlertTitle>
            Removed <code className="font-mono">{removed.path}</code>
            {removed.type === "dir" && ` (${removed.files} file${removed.files === 1 ? "" : "s"})`}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            A copy is in <code className="font-mono">workspace/{removed.trash}</code>.
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
          {workspaces.data && <WorkspaceListSection list={workspaces.data} />}
          <div role="tree" aria-label="Workspace files">
            {tree.isLoading ? (
              <Skeleton className="m-1 h-64" />
            ) : (
              tree.data && (
                // the workspace folder itself is the root of the tree
                <TreeNode node={tree.data} depth={0} selected={selected} onSelect={(path) => setParams({ path })} />
              )
            )}
          </div>
        </Card>
        {selectedNode?.type === "dir" ? (
          <FolderViewer node={selectedNode} onRemove={remove} removing={remover.isPending} />
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

/** Every known workspace, the active one in bold; switching is done with the Switch workspace button. */
function WorkspaceListSection({ list }: { list: WorkspaceList }) {
  return (
    <div className="mb-1.5 border-b pb-1.5">
      <p className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium tracking-wide uppercase">Workspaces</p>
      <ul aria-label="Workspaces">
        {list.workspaces.map((w) => (
          <li
            key={w.path}
            aria-current={w.active ? "true" : undefined}
            title={w.exists ? w.path : `${w.path} (missing)`}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2 text-sm",
              w.active ? "text-foreground font-bold" : "text-muted-foreground",
              !w.exists && "italic line-through",
            )}
          >
            {w.active ? <Check className="text-primary size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
            <span className="truncate">{w.name}</span>
          </li>
        ))}
      </ul>
    </div>
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
}: {
  node: WorkspaceNode
  onRemove: (node: WorkspaceNode) => void
  removing: boolean
}) {
  const files = countFiles(node)
  const isProject = node.children?.some((c) => c.type === "dir" && c.name === "pipelines")
  return (
    <Card className="min-w-0 gap-0 self-start overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FolderOpen className="text-primary size-4" />
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{node.path === ROOT ? node.name : node.path}/</code>
        {/* the workspace folder itself can't be removed from here */}
        {node.path !== ROOT && (
          <Button variant="outline" size="sm" onClick={() => onRemove(node)} disabled={removing}>
            <Trash2 /> Remove folder
          </Button>
        )}
      </div>
      <div className="text-muted-foreground grid gap-1 p-4 text-sm">
        <p>
          {files} file{files === 1 ? "" : "s"} in {node.children?.length ?? 0} item
          {node.children?.length === 1 ? "" : "s"}.
        </p>
        {isProject && <p>This is a project: its pipelines are listed in the Pipelines tab.</p>}
        <p>Select a file in the tree to view it.</p>
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
