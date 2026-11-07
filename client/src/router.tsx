import { createBrowserRouter, Navigate } from "react-router"

import { AppShell } from "@/components/layout/app-shell"
import { NewPipelinePage } from "@/pages/new-pipeline-page"
import { PipelineDetailPage } from "@/pages/pipeline-detail-page"
import { PipelinesPage } from "@/pages/pipelines-page"
import { RunDetailPage } from "@/pages/run-detail-page"
import { RunsPage } from "@/pages/runs-page"

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/pipelines" replace /> },
      { path: "pipelines", element: <PipelinesPage /> },
      { path: "pipelines/new", element: <NewPipelinePage /> },
      { path: "pipelines/:pipelineId", element: <PipelineDetailPage /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunDetailPage /> },
    ],
  },
])
