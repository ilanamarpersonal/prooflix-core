# Prooflix design documents

Prooflix is a data-platform core in the style of Databricks Workflows:
pipelines are defined as YAML files in a workspace, run by a Python server on
demand or on a cron schedule, and monitored from a React web client, which
also offers a SQL editor and a catalog over the workspace's Parquet data.

Current capabilities:

- **Pipelines and sub-pipelines**: Python, shell and pipeline tasks in a DAG,
  `${...}` references, retries, timeouts, cancellation, whole-workspace
  validation.
- **Schedules**: cron with 5 fields, or 6 with seconds (`*/15 * * * * *`), per
  time zone, with pause/resume, run by a scheduler inside the server.
- **Runs**: live status, every task's printout as it runs, nested sub-runs,
  run history per workspace.
- **Workspaces**: a folder of workspaces, one active at a time; create, switch
  and import code from the web client.
- **SQL and catalog**: DuckDB queries over Parquet files, import (CSV/JSON) and
  export (CSV/Parquet).
- **Deployment**: one Docker image, a Helm chart and a Terraform configuration.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System overview, repository layout, request flows, key design decisions |
| [pipelines.md](pipelines.md) | The pipeline YAML format, sub-pipelines, `${...}` references, validation rules, schedules |
| [server.md](server.md) | Python server structure, execution engine, scheduler, run model, workspaces, REST API, configuration |
| [client.md](client.md) | React + shadcn/ui client structure, sections and screens, data flow, components |
| [deployment.md](deployment.md) | Docker image, Helm chart, Terraform and the local kind workflow |

Diagrams are written in [Mermaid](https://mermaid.js.org/), which GitHub and
VS Code (with the *Markdown Preview Mermaid Support* extension) render directly.

## Roadmap

These Databricks-like capabilities are not built yet and are the natural next
steps:

- File-arrival and event triggers (schedules are done)
- Notebook and SQL task types
- Clusters / compute pools and remote task execution (tasks run in the server
  process today, so the server runs as a single replica)
- Authentication, users and permissions
- A persistent database for runs (currently JSON files per workspace)
- Lineage and governance on the catalog (schemas and tables are done)
