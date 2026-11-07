# Prooflix design documents

Prooflix is a data-platform core in the style of Databricks Workflows: pipelines
are defined as YAML files in a workspace, run by a Python server, and monitored
from a React web client. This first milestone covers **pipelines and
sub-pipelines** only.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System overview, repository layout, how the pieces talk to each other |
| [pipelines.md](pipelines.md) | The pipeline YAML format, sub-pipelines, `${...}` references, validation rules |
| [server.md](server.md) | Python server structure, execution engine, run model, REST API |
| [client.md](client.md) | React + shadcn/ui client structure, routing, data flow, components |

Diagrams are written in [Mermaid](https://mermaid.js.org/), which GitHub and
VS Code (with the *Markdown Preview Mermaid Support* extension) render directly.

## Roadmap after this milestone

These Databricks-like capabilities are intentionally out of scope for now and
are the natural next steps:

- Schedules and triggers (cron, file arrival)
- Notebook and SQL task types
- Clusters / compute pools and remote task execution
- Authentication, users and permissions
- A persistent database for runs (currently JSON files)
- Data catalog (tables, schemas, lineage)
