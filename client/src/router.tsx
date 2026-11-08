import { createBrowserRouter } from "react-router"

import { AppShell } from "@/components/layout/app-shell"
import { NewPipelinePage } from "@/pages/new-pipeline-page"
import { PipelineDetailPage } from "@/pages/pipeline-detail-page"
import { PipelinesPage } from "@/pages/pipelines-page"
import { RunDetailPage } from "@/pages/run-detail-page"
import { RunsPage } from "@/pages/runs-page"
import { SqlEditorPage } from "@/pages/sql-editor-page"
import { WorkspacePage } from "@/pages/workspace-page"

// Each top-level area is a tab; see SECTIONS in lib/tabs.ts. "/" goes to Pipelines.
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      // Pipelines tab (runs open inside it)
      { path: "pipelines", element: <PipelinesPage /> },
      { path: "pipelines/new", element: <NewPipelinePage /> },
      { path: "pipelines/:pipelineId", element: <PipelineDetailPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunDetailPage /> },
      { path: "sql", element: <SqlEditorPage /> },
      { path: "workspace", element: <WorkspacePage /> },
    ],
  },
])
