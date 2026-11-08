# Prooflix core

A data-platform core in the style of Databricks Workflows. Pipelines are YAML
files in a workspace, executed by a Python server, and managed from a React
(shadcn/ui) web client. A pipeline task can call another pipeline as a
**sub-pipeline**.

```text
server/      Python server (FastAPI) and CLI         → docs/server.md
client/      React + shadcn/ui web client            → docs/client.md
workspace/   imported projects (each with pipelines/ and src/) → docs/pipelines.md
catalog/     imported datasets, one folder per schema (CSV/JSON tables)
docs/        design documents with diagrams           → docs/README.md
```

## Requirements

- [uv](https://docs.astral.sh/uv/) (it installs the right Python version automatically)
- Node.js 20 or newer, for the client

## Run it

Server (http://127.0.0.1:8000, API docs at `/docs`):

```bash
cd server
uv run prooflix serve --reload
```

Client (http://localhost:5173), in a second terminal:

```bash
cd client
npm install
npm run dev
```

## Add pipelines

The workspace starts empty. In the web client open **Workspace → Import code**
and choose a project folder that has `pipelines/*.yaml` and its Python code in
`src/` (for example `prooflix-assets-bundle`). Each imported project lives in
its own folder under `workspace/`, and its pipelines appear in the
**Pipelines** tab, where **Run** starts them and clicking a task shows what it
printed.

## Catalog

The **Catalog** tab lists schemas and their tables, which you can query in the
**SQL Editor** as `schema.table`. A schema is either a project's `data/` folder
in the workspace, or a folder in `catalog/` (next to the workspace, set with
`PROOFLIX_CATALOG`) for datasets that are not part of a project. **Import**
adds CSV or JSON files as tables; **Export** downloads a table as CSV, or as a
ZIP with a Parquet file, and a schema or the whole catalog as a ZIP.

## Use it from the command line

```bash
cd server
uv run prooflix validate
uv run prooflix run pipeline1
```

The sample pipelines used by the tests (`daily_orders` and friends) are in
`server/tests/fixtures/sample_workspace/`; point the CLI at them with
`--workspace tests/fixtures/sample_workspace`.

## A pipeline that calls sub-pipelines

```yaml
# workspace/pipelines/daily_orders.yaml
parameters:
  run_date: "2026-01-01"
tasks:
  - key: ingest
    type: pipeline
    pipeline: ingest_orders          # workspace/pipelines/ingest_orders.yaml
    parameters:
      run_date: ${params.run_date}
  - key: transform
    type: pipeline
    pipeline: transform_orders
    depends_on: [ingest]
    parameters:
      input_path: ${tasks.ingest.output.path}   # output of the sub-pipeline
outputs:
  total_revenue: ${tasks.transform.output.total_revenue}
```

See [docs/pipelines.md](docs/pipelines.md) for the full format.

## Tests

```bash
cd server
uv run pytest
```
