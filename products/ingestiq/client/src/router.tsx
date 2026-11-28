import { createBrowserRouter } from "react-router"

import { ProductApp } from "@prooflix/ui/app/product-app"

import { useIngestiqCommands } from "@/lib/commands"
import { AlertsPage } from "@/pages/alerts-page"
import { CatalogPage } from "@/pages/catalog-page"
import { ClickHousePage } from "@/pages/clickhouse-page"
import { IngestionPage } from "@/pages/ingestion-page"
import { NewPipelinePage } from "@/pages/new-pipeline-page"
import { PipelineDetailPage } from "@/pages/pipeline-detail-page"
import { PipelinesPage } from "@/pages/pipelines-page"
import { RunDetailPage } from "@/pages/run-detail-page"
import { RunsPage } from "@/pages/runs-page"
import { SemanticPage } from "@/pages/semantic-page"
import { SqlEditorPage } from "@/pages/sql-editor-page"
import { WorkspacePage } from "@/pages/workspace-page"

// Each top-level area is a tab; see SCREENS in @prooflix/ui/app/screens. "/" goes to Pipelines.
export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <ProductApp productId="ingestiq" useCommands={useIngestiqCommands} alwaysHome={["pipelines"]} />,
      children: [
        // Pipelines tab (runs open inside it)
        { path: "pipelines", element: <PipelinesPage /> },
        { path: "pipelines/new", element: <NewPipelinePage /> },
        { path: "pipelines/:pipelineId", element: <PipelineDetailPage /> },
        { path: "runs", element: <RunsPage /> },
        { path: "runs/:runId", element: <RunDetailPage /> },
        { path: "ingestion", element: <IngestionPage /> },
        { path: "sql", element: <SqlEditorPage /> },
        { path: "catalog", element: <CatalogPage /> },
        { path: "semantic", element: <SemanticPage /> },
        { path: "clickhouse", element: <ClickHousePage /> },
        { path: "workspace", element: <WorkspacePage /> },
        { path: "alerts", element: <AlertsPage /> },
      ],
    },
    // IngestIQ is served under /ingestiq/ (the portal is at /)
  ],
  { basename: "/ingestiq" },
)
