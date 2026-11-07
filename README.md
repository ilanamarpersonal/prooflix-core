# Prooflix core

A data-platform core in the style of Databricks Workflows. Pipelines are YAML
files in a workspace, executed by a Python server, and managed from a React
(shadcn/ui) web client. A pipeline task can call another pipeline as a
**sub-pipeline**.

```text
server/      Python server (FastAPI) and CLI         → docs/server.md
client/      React + shadcn/ui web client            → docs/client.md
workspace/   sample workspace: pipelines/*.yaml, src/ → docs/pipelines.md
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

## Use it from the command line

```bash
cd server
uv run prooflix validate
uv run prooflix run daily_orders -p run_date=2026-11-07
```

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
